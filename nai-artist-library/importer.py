from __future__ import annotations

import argparse
import hashlib
import re
import shutil
import xml.etree.ElementTree as ET
import zipfile
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath

from PIL import Image, ImageOps

from database import DATA_DIR, ROOT, connect, entry_media_dir, init_db, utc_now


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NS = {"w": W_NS, "a": A_NS, "r": R_NS, "rel": REL_NS}

STAR_RE = re.compile(r"[★☆]{1,5}")
SECRET_PATTERNS = (
    re.compile(r"\bsk-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\bpst-[A-Za-z0-9_-]{16,}\b"),
    re.compile(r"\b(?:api[_ -]?key|token|secret)\s*[:=]", re.I),
    re.compile(r"^[A-Za-z][A-Za-z0-9_-]{24,}$"),
)


@dataclass
class Paragraph:
    index: int
    text: str
    image_rel_ids: list[str] = field(default_factory=list)
    outline_level: int | None = None


@dataclass
class ParsedDocx:
    path: Path
    paragraphs: list[Paragraph]
    relationships: dict[str, str]


def normalize_text(value: str) -> str:
    value = value.replace("\u00a0", " ").replace("\u3000", " ")
    return re.sub(r"[ \t\r\n]+", " ", value).strip()


def looks_sensitive(value: str) -> bool:
    candidate = value.strip()
    return any(pattern.search(candidate) for pattern in SECRET_PATTERNS)


def parse_docx(path: Path) -> ParsedDocx:
    with zipfile.ZipFile(path) as archive:
        document = ET.fromstring(archive.read("word/document.xml"))
        rel_root = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        styles_root = ET.fromstring(archive.read("word/styles.xml"))

    style_levels: dict[str, int] = {}
    for style in styles_root.findall("w:style", NS):
        style_id = style.attrib.get(f"{{{W_NS}}}styleId")
        outline = style.find("w:pPr/w:outlineLvl", NS)
        if style_id and outline is not None:
            style_levels[style_id] = int(outline.attrib.get(f"{{{W_NS}}}val", "0")) + 1

    relationships = {}
    for rel in rel_root.findall(f"{{{REL_NS}}}Relationship"):
        rel_id = rel.attrib.get("Id")
        target = rel.attrib.get("Target")
        if rel_id and target:
            relationships[rel_id] = target

    paragraphs = []
    body = document.find("w:body", NS)
    if body is None:
        return ParsedDocx(path, [], relationships)

    index = 0
    for node in body.iter():
        if node.tag != f"{{{W_NS}}}p":
            continue
        text = normalize_text("".join(part.text or "" for part in node.findall(".//w:t", NS)))
        image_rel_ids = []
        for blip in node.findall(".//a:blip", NS):
            rel_id = blip.attrib.get(f"{{{R_NS}}}embed")
            if rel_id:
                image_rel_ids.append(rel_id)
        outline_level = None
        properties = node.find("w:pPr", NS)
        if properties is not None:
            direct = properties.find("w:outlineLvl", NS)
            style = properties.find("w:pStyle", NS)
            if direct is not None:
                outline_level = int(direct.attrib.get(f"{{{W_NS}}}val", "0")) + 1
            elif style is not None:
                style_id = style.attrib.get(f"{{{W_NS}}}val", "")
                outline_level = style_levels.get(style_id)
        paragraphs.append(Paragraph(index, text, image_rel_ids, outline_level))
        index += 1
    return ParsedDocx(path, paragraphs, relationships)


def rating_from_text(text: str) -> int | None:
    match = STAR_RE.search(text)
    if not match:
        return None
    stars = match.group(0)
    # 用户原文使用空心星表示半星，例如 ★★★★☆ = 4.5。
    score = stars.count("★") * 2 + stars.count("☆")
    return min(10, max(1, score))


def strip_rating(text: str) -> str:
    return normalize_text(STAR_RE.sub("", text, count=1).lstrip("：: -"))


def split_positive_negative(lines: list[str]) -> tuple[str, str, str]:
    positive: list[str] = []
    negative: list[str] = []
    notes: list[str] = []
    target = positive
    for raw in lines:
        line = strip_rating(raw)
        if not line:
            continue
        negative_match = re.match(r"^(?:暂无\s*)?负(?:面提示词|面)?", line, re.I)
        positive_match = re.match(r"^(?:前置正面提示词|正面提示词|正面|正)\s*[：:]?\s*(.*)$", line, re.I)
        if negative_match:
            target = negative
            tail = line[negative_match.end():].strip()
            # “负面（或者通用）：内容”中的括号是说明；而
            # “负面(worst quality:1.2), ...”的括号本身就是提示词，必须保留。
            if tail.startswith(("（", "(")):
                closing = "）" if tail[0] == "（" else ")"
                close_at = tail.find(closing, 1)
                if close_at >= 0:
                    remainder = tail[close_at + 1:].lstrip()
                    qualifier = tail[1:close_at]
                    if remainder.startswith(("：", ":")) or (not remainder and re.search(r"通用|备用|说明", qualifier)):
                        tail = remainder[1:].strip() if remainder else ""
            tail = re.sub(r"^\d+\s*[：:]\s*", "", tail)
            tail = re.sub(r"^[：:]\s*", "", tail)
            tail = re.sub(r"^[，,]\s*(?:暂时)?用\s*", "", tail)
            if tail:
                negative.append(tail)
            continue
        if positive_match:
            target = positive
            if positive_match.group(1):
                positive.append(positive_match.group(1))
            continue
        if looks_sensitive(line):
            notes.append("[导入时已排除疑似密钥或令牌]")
            continue
        target.append(line)
    return "\n".join(positive), "\n".join(negative), "\n".join(notes)


def artist_header(text: str) -> tuple[int | None, str, str] | None:
    """解析“★★★★★名称：具体内容”；有评分时也兼容误用的英文冒号。"""
    value = normalize_text(text)
    if re.match(r"^(?:暂无\s*)?负(?:面提示词|面)?", value, re.I):
        return None
    star_match = re.match(r"^([★☆]{1,5})\s*(.*)$", value)
    rating = rating_from_text(value) if star_match else None
    remainder = star_match.group(2).strip() if star_match else value
    ascii_title = remainder.split(":", 1)[0] if ":" in remainder else ""
    separator = "：" if "：" in remainder else (
        ":" if ":" in remainder and (star_match or re.search(r"[\u3400-\u9fff]", ascii_title)) else None
    )
    if separator:
        title, content = remainder.split(separator, 1)
        title = normalize_text(title)
        content = normalize_text(content)
        field_label = re.match(r"^(?:正|正面|正面提示词|前置正面提示词|负|负面|负面提示词)(?:[（(][^）)]*[）)]|\d+)?$", title)
        if field_label:
            if not star_match:
                return None
            return rating, "", f"{title}：{content}"
        if star_match or (separator in ("：", ":") and title and len(title) <= 55):
            return rating, title, content
    if star_match:
        return rating, "", normalize_text(remainder)
    return None


def standalone_negative_blocks(doc: ParsedDocx) -> tuple[list[dict], set[int]]:
    """识别文档中明确声明为独立资料的默认/通用负面提示词。"""
    blocks: list[dict] = []
    consumed: set[int] = set()
    current: dict | None = None

    def header(text: str) -> tuple[str, str] | None:
        if "：" not in text:
            return None
        label, content = text.split("：", 1)
        if re.match(r"^(?:默认|通用)负面", label):
            return label.strip(), content.strip()
        if label.startswith("以下应该被认为是") and "单独的负面提示词" in label:
            name = re.search(r"((?:默认|通用)负面[^：:]*)$", label)
            return (name.group(1).strip() if name else "默认负面"), content.strip()
        return None

    def finish() -> None:
        nonlocal current
        if current:
            content, _, notes = split_positive_negative(current["lines"])
            # 独立负面库的正文应放在卡片主内容字段，便于点击复制。
            current["content"] = content
            current["notes"] = notes
            blocks.append(current)
            current = None

    for paragraph in doc.paragraphs:
        text = normalize_text(paragraph.text)
        found = header(text)
        if found:
            finish()
            title, first_content = found
            current = {
                "kind": "artist",
                "title": title,
                "content": "",
                "negative_prompt": "",
                "rating": None,
                "category": "负面提示词",
                "notes": "",
                "tags": [],
                "source_index": paragraph.index,
                "image_rel_ids": [],
                "lines": [first_content] if first_content else [],
            }
            consumed.add(paragraph.index)
            continue
        if current:
            if paragraph.image_rel_ids or (text and re.match(r"^[★☆]", text)):
                finish()
            else:
                consumed.add(paragraph.index)
                if text:
                    current["lines"].append(text)
    finish()
    for block in blocks:
        block.pop("lines", None)
        block["notes"] = block["notes"] or "从 nai.docx 中明确标注的独立负面提示词导入。"
    return blocks, consumed


def artist_blocks(doc: ParsedDocx) -> list[dict]:
    # Word 的视觉结构是“若干图片在前，随后是一条或多条画师串”。
    # 先按图片组切成版面区块，再在区块内部按“评分+名称：内容”拆条目。
    sections: list[dict] = []
    section: dict | None = None
    _, standalone_indices = standalone_negative_blocks(doc)
    for paragraph in doc.paragraphs:
        if paragraph.index in standalone_indices:
            continue
        if paragraph.image_rel_ids:
            if section and section["paragraphs"]:
                sections.append(section)
                section = None
            if section is None:
                section = {"images": [], "paragraphs": [], "source_index": paragraph.index}
            section["images"].extend(paragraph.image_rel_ids)
        elif paragraph.text:
            if section is None:
                section = {"images": [], "paragraphs": [], "source_index": paragraph.index}
            section["paragraphs"].append(paragraph)
    if section and (section["images"] or section["paragraphs"]):
        sections.append(section)

    blocks: list[dict] = []
    for section in sections:
        section_entries: list[dict] = []
        current: dict | None = None
        preface: list[str] = []
        for paragraph in section["paragraphs"]:
            header = artist_header(paragraph.text)
            if header:
                if current:
                    section_entries.append(current)
                rating, title, first_content = header
                current = {
                    "source_index": paragraph.index,
                    "title": title,
                    "rating": rating,
                    "lines": ([*preface, first_content] if first_content else [*preface]),
                    "image_rel_ids": [],
                }
                preface = []
            elif current:
                current["lines"].append(paragraph.text)
            else:
                preface.append(paragraph.text)
        if current:
            section_entries.append(current)
        elif preface:
            section_entries.append(
                {
                    "source_index": section["source_index"],
                    "title": "",
                    "rating": rating_from_text("\n".join(preface)),
                    "lines": preface,
                    "image_rel_ids": [],
                }
            )

        images = section["images"]
        if len(section_entries) == len(images) and len(images) > 1:
            for entry, image_rel_id in zip(section_entries, images):
                entry["image_rel_ids"] = [image_rel_id]
        elif len(section_entries) == 1:
            section_entries[0]["image_rel_ids"] = images
        elif section_entries and images:
            # 数量不相等时保守地顺序分配，剩余图片留给最后一条。
            for index, image_rel_id in enumerate(images):
                target = min(index, len(section_entries) - 1)
                section_entries[target]["image_rel_ids"].append(image_rel_id)
        blocks.extend(section_entries)

    results = []
    for number, block in enumerate(blocks, 1):
        rating = block["rating"]
        positive, negative, notes = split_positive_negative(block["lines"])
        title = block["title"].strip() or f"未命名画师串 {number:03d}"
        results.append(
            {
                "kind": "artist",
                "title": title,
                "content": positive,
                "negative_prompt": negative,
                "rating": rating,
                "category": "画师串",
                "notes": notes or "从 nai.docx 自动切分；请核对标题、评分及图片归属。",
                "tags": [],
                "source_index": block["source_index"],
                "image_rel_ids": block["image_rel_ids"],
            }
        )
    return results


def common_negative_entries(doc: ParsedDocx) -> list[dict]:
    return standalone_negative_blocks(doc)[0]


def is_heading(text: str) -> bool:
    value = text.strip()
    if not value or len(value) > 42 or looks_sensitive(value):
        return False
    if value.endswith(("：", ":")) and value.count(",") <= 1:
        return True
    return False


def split_mapping(text: str) -> tuple[str, str] | None:
    # Word may keep intentional line breaks inside one prompt paragraph. Treat
    # those as ordinary whitespace instead of rejecting an otherwise valid
    # "名称：提示词" mapping.
    match = re.match(r"^\s*([^:：\r\n]{1,200})\s*[：:]\s*(.*)$", text, flags=re.DOTALL)
    if not match:
        return None
    title, content = normalize_text(match.group(1)), normalize_text(match.group(2))
    if not title:
        return None
    return title, content


def prompt_blocks(doc: ParsedDocx) -> list[dict]:
    results: list[dict] = []
    level_one = "未分类"
    level_two = ""
    category = "从 Word 导入/未分类"
    buffer: list[Paragraph] = []
    last_created: dict | None = None

    def flush() -> None:
        nonlocal buffer, last_created
        image_rel_ids = [rel for p in buffer for rel in p.image_rel_ids]
        clean = [p for p in buffer if p.text and not looks_sensitive(p.text)]
        buffer = []
        if not clean:
            return
        first = clean[0].text
        mapping = split_mapping(first)
        if mapping:
            title, first_content = mapping
            content = "\n".join([first_content, *[p.text for p in clean[1:]]]).strip()
        elif is_heading(first) and len(clean) > 1:
            title = first.rstrip("：:").strip()
            content_lines = [p.text for p in clean[1:]]
            content = "\n".join(content_lines).strip()
        elif len(first) <= 36 and re.search(r"[\u4e00-\u9fff]", first) and len(clean) > 1:
            title = first.rstrip("：:").strip()
            content_lines = [p.text for p in clean[1:]]
            content = "\n".join(content_lines).strip()
        else:
            title = f"提示词 {clean[0].index:03d}"
            content_lines = [p.text for p in clean]
            content = "\n".join(content_lines).strip()
        if not content:
            return
        target_category = category
        if re.search(r"负面|undesired|negative", title, re.I):
            target_category = "负面提示词"
        target_kind = "artist" if target_category == "负面提示词" else "prompt"
        item = {
                "kind": target_kind,
                "title": title[:120],
                "content": content,
                "negative_prompt": "",
                "rating": None,
                "category": target_category,
                "notes": "从 nai提示词.docx 自动分组；请核对标题与目录。",
                "tags": [],
                "source_index": clean[0].index,
                "image_rel_ids": image_rel_ids,
            }
        results.append(item)
        last_created = item

    character_library = False
    for paragraph in doc.paragraphs:
        text = paragraph.text
        if looks_sensitive(text):
            continue
        if paragraph.outline_level in (1, 2) and text:
            flush()
            heading = text.rstrip("：:").strip()
            character_library = heading == "角色提示词库"
            if paragraph.outline_level == 1:
                level_one, level_two = heading, ""
            else:
                level_two = heading
            category_parts = [level_one]
            if level_two and level_two != level_one:
                category_parts.append(level_two)
            category = "/".join(category_parts)
            if re.search(r"负面|undesired|negative", heading, re.I):
                category = "负面提示词"
            continue
        if text in ("角色提示词库:", "角色提示词库："):
            flush()
            character_library = True
            category = "角色提示词库"
            continue
        if character_library:
            if text in ("可替换地点列表：", "可替换地点列表:"):
                character_library = False
                category = "场景与模板/地点"
                buffer.append(paragraph)
                continue
            if is_heading(text):
                category = f"角色提示词库/{text.rstrip('：:').strip()}"
                continue
            mapping = split_mapping(text)
            if mapping:
                title, content = mapping
                results.append(
                    {
                        "kind": "prompt",
                        "title": title,
                        "content": content,
                        "negative_prompt": "",
                        "rating": None,
                        "category": category,
                        "notes": "从角色提示词列表导入。",
                        "tags": [],
                        "source_index": paragraph.index,
                        "image_rel_ids": paragraph.image_rel_ids,
                    }
                )
                last_created = results[-1]
            elif text:
                # 无中文名称的角色条目仍然单独保留。
                results.append(
                    {
                        "kind": "prompt",
                        "title": text[:80],
                        "content": text,
                        "negative_prompt": "",
                        "rating": None,
                        "category": category,
                        "notes": "从角色提示词列表导入。",
                        "tags": [],
                        "source_index": paragraph.index,
                        "image_rel_ids": paragraph.image_rel_ids,
                    }
                )
                last_created = results[-1]
            continue

        mapping = split_mapping(text) if text else None
        if mapping:
            # “名称：具体内容”本身就是新卡片，即使与上一条之间没有空行。
            flush()
            buffer.append(paragraph)
            continue
        if paragraph.image_rel_ids and not text:
            # Word 中的示例图紧跟在对应的单行提示词之后。
            if buffer:
                buffer.append(paragraph)
                flush()
            elif last_created:
                last_created["image_rel_ids"].extend(paragraph.image_rel_ids)
            continue
        if not text and not paragraph.image_rel_ids:
            flush()
            continue
        buffer.append(paragraph)
    flush()
    return results


def archive_media_path(target: str) -> str:
    normalized = PurePosixPath("word") / PurePosixPath(target)
    parts = []
    for part in normalized.parts:
        if part == "..":
            if parts:
                parts.pop()
        elif part not in (".", ""):
            parts.append(part)
    return "/".join(parts)


def save_image(archive: zipfile.ZipFile, member: str, source_stem: str, entry: dict) -> tuple[str, str | None, str, int | None, int | None]:
    payload = archive.read(member)
    digest = hashlib.sha256(payload).hexdigest()
    suffix = Path(member).suffix.lower() or ".bin"
    media_dir = entry_media_dir(entry["kind"], entry["category"], entry["title"])
    thumb_dir = DATA_DIR / "thumbs" / source_stem
    media_dir.mkdir(parents=True, exist_ok=True)
    thumb_dir.mkdir(parents=True, exist_ok=True)
    image_path = media_dir / f"{digest}{suffix}"
    thumb_path = thumb_dir / f"{digest}.jpg"
    width = height = None
    if not image_path.exists():
        image_path.write_bytes(payload)
    if not thumb_path.exists():
        try:
            with Image.open(image_path) as image:
                image = ImageOps.exif_transpose(image)
                width, height = image.size
                image = image.convert("RGB")
                image.thumbnail((720, 720), Image.Resampling.LANCZOS)
                image.save(thumb_path, "JPEG", quality=84, optimize=True)
        except Exception:
            thumb_path = None
    relative_thumb = thumb_path.relative_to(DATA_DIR).as_posix() if thumb_path else None
    if width is None:
        try:
            with Image.open(image_path) as image:
                width, height = ImageOps.exif_transpose(image).size
        except Exception:
            pass
    return image_path.relative_to(DATA_DIR).as_posix(), relative_thumb, digest, width, height


def import_docx(path: Path) -> dict:
    path = path.resolve()
    parsed = parse_docx(path)
    if path.name.lower() == "nai.docx":
        entries = artist_blocks(parsed) + common_negative_entries(parsed)
    else:
        entries = prompt_blocks(parsed)

    inserted = 0
    skipped = 0
    image_count = 0
    source_doc = path.name
    with zipfile.ZipFile(path) as archive, connect() as conn:
        for entry in entries:
            existing = conn.execute(
                "SELECT id FROM entries WHERE source_doc = ? AND source_index = ?",
                (source_doc, entry["source_index"]),
            ).fetchone()
            if existing:
                skipped += 1
                continue
            now = utc_now()
            cursor = conn.execute(
                """
                INSERT INTO entries
                    (kind, title, content, negative_prompt, rating, category, notes, tags,
                     source_doc, source_index, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    entry["kind"], entry["title"], entry["content"], entry["negative_prompt"],
                    entry["rating"], entry["category"], "",
                    __import__("json").dumps(entry["tags"], ensure_ascii=False), source_doc,
                    entry["source_index"], now, now,
                ),
            )
            entry_id = cursor.lastrowid
            for order, rel_id in enumerate(entry["image_rel_ids"]):
                target = parsed.relationships.get(rel_id)
                if not target:
                    continue
                member = archive_media_path(target)
                try:
                    image_path, thumb_path, digest, width, height = save_image(archive, member, path.stem, entry)
                except (KeyError, OSError):
                    continue
                asset = conn.execute("SELECT id FROM assets WHERE sha256 = ?", (digest,)).fetchone()
                if asset:
                    asset_id = asset["id"]
                else:
                    asset_id = conn.execute(
                        "INSERT INTO assets (path, thumbnail_path, sha256, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        (image_path, thumb_path, digest, width, height, utc_now()),
                    ).lastrowid
                conn.execute(
                    "INSERT OR IGNORE INTO entry_images (entry_id, asset_id, sort_order) VALUES (?, ?, ?)",
                    (entry_id, asset_id, order),
                )
                image_count += 1
            inserted += 1
    return {"file": source_doc, "parsed": len(entries), "inserted": inserted, "skipped": skipped, "images": image_count}


def reset_imported_data() -> None:
    with connect() as conn:
        conn.execute("DELETE FROM entries WHERE source_doc IS NOT NULL")
        conn.execute("DELETE FROM images")
        conn.execute("DELETE FROM assets WHERE id NOT IN (SELECT asset_id FROM entry_images)")
    # 原图目录可能同时包含网页上传内容，重建索引时绝不删除原图；只清理可再生成的缩略图。
    for base in (DATA_DIR / "thumbs",):
        for source_name in ("nai", "nai提示词"):
            folder = (base / source_name).resolve()
            if folder.parent == base.resolve() and folder.exists():
                shutil.rmtree(folder)


def main() -> None:
    parser = argparse.ArgumentParser(description="导入 NAI Word 资料")
    parser.add_argument("files", nargs="*", type=Path)
    parser.add_argument("--all", action="store_true", help="导入项目目录中的两个默认文档")
    parser.add_argument("--reset", action="store_true", help="先清除以前从 Word 导入的数据")
    args = parser.parse_args()
    init_db()
    if args.reset:
        reset_imported_data()
    files = args.files
    if args.all:
        files = [ROOT / "nai.docx", ROOT / "nai提示词.docx"]
    if not files:
        parser.error("请提供 DOCX 文件，或使用 --all")
    for file in files:
        if not file.exists():
            print(f"跳过不存在的文件：{file}")
            continue
        result = import_docx(file)
        print(
            f"{result['file']}: 识别 {result['parsed']} 条，新增 {result['inserted']} 条，"
            f"跳过 {result['skipped']} 条，关联图片 {result['images']} 张"
        )


if __name__ == "__main__":
    main()
