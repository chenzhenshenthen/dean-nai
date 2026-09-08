from __future__ import annotations

import argparse
import json
import re
import sqlite3
import time
from collections import defaultdict
from datetime import datetime
from pathlib import Path

from database import DATA_DIR, DB_PATH, ROOT
from image_metadata import extract_image_metadata, metadata_is_current


def asset_path(row: sqlite3.Row, data_root: Path) -> Path:
    if row["external_path"]:
        return Path(row["external_path"])
    if str(row["path"]).startswith("原图/"):
        return ROOT / Path(row["path"])
    return data_root / Path(row["path"])


def prompt_tokens(value: str) -> set[str]:
    tokens = set()
    for raw in re.split(r"[,\n]+", value or ""):
        token = raw.strip().casefold().replace("_", " ")
        token = re.sub(r"^[\s{[(]+|[\s})\]]+$", "", token)
        token = re.sub(r"^[+-]?\d+(?:\.\d+)?::", "", token)
        token = re.sub(r"::$", "", token).strip()
        token = re.sub(r"\s+", " ", token)
        if len(token) >= 2:
            tokens.add(token)
    return tokens


def coverage(reference: str, image_prompt: str) -> float | None:
    expected = prompt_tokens(reference)
    actual = prompt_tokens(image_prompt)
    if len(expected) < 3 or len(actual) < 3:
        return None
    return len(expected & actual) / len(expected)


def markdown_report(report: dict) -> str:
    summary = report["summary"]
    lines = [
        "# NAI 资料库图片审计",
        "",
        f"生成时间：{report['created_at']}",
        "",
        "## 扫描概况",
        "",
        f"- 图片资产：{summary['assets']} 张",
        f"- 本次实际读取：{summary['scanned']} 张",
        f"- 复用缓存：{summary['cached']} 张",
        f"- 用时：{summary['elapsed_seconds']} 秒",
        "",
        "## 问题数量",
        "",
        f"- 原图路径失效：{len(report['missing_originals'])}",
        f"- 缩略图缺失：{len(report['missing_thumbnails'])}",
        f"- 图片没有可读取 Prompt：{len(report['images_without_prompt'])}",
        f"- 图片与卡片提示词疑似不匹配：{len(report['prompt_mismatches'])}",
        f"- 图片含角色 Prompt、卡片中未记录：{len(report['unrecorded_character_prompts'])}",
        f"- 同一图片关联至少 3 张卡片：{len(report['shared_by_three_or_more'])}",
    ]
    sections = [
        ("原图路径失效", "missing_originals"),
        ("缩略图缺失", "missing_thumbnails"),
        ("图片没有可读取 Prompt", "images_without_prompt"),
        ("图片与卡片提示词疑似不匹配", "prompt_mismatches"),
        ("图片含角色 Prompt、卡片中未记录", "unrecorded_character_prompts"),
        ("同一图片关联至少 3 张卡片", "shared_by_three_or_more"),
    ]
    for title, key in sections:
        items = report[key]
        if not items:
            continue
        lines.extend(["", f"## {title}", ""])
        for item in items:
            text = f"- 资产 #{item['asset_id']}"
            if item.get("entry_title"):
                text += f" · {item['entry_title']}"
            if item.get("path"):
                text += f" · `{item['path']}`"
            if item.get("coverage") is not None:
                text += f" · 覆盖率 {item['coverage']:.0%}"
            if item.get("entry_titles"):
                text += " · " + "、".join(item["entry_titles"])
            lines.append(text)
    return "\n".join(lines) + "\n"


def audit_library(
    database_path: Path = DB_PATH,
    output_dir: Path | None = None,
    *,
    deep: bool = False,
    full: bool = False,
    mismatch_threshold: float = 0.25,
    progress=None,
) -> tuple[Path, Path, dict]:
    started = time.perf_counter()
    database_path = database_path.resolve()
    data_root = database_path.parent
    output_dir = (output_dir or ROOT / "output" / "audits").resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database_path)
    connection.row_factory = sqlite3.Row
    try:
        assets = connection.execute(
            "SELECT id, path, thumbnail_path, external_path, sha256, metadata_json FROM assets ORDER BY id"
        ).fetchall()
        links = connection.execute(
            """
            SELECT entry_images.asset_id, entries.id AS entry_id, entries.title, entries.content,
                   entries.negative_prompt, entries.kind
            FROM entry_images JOIN entries ON entries.id = entry_images.entry_id
            ORDER BY entry_images.asset_id, entries.id
            """
        ).fetchall()
        links_by_asset: dict[int, list[sqlite3.Row]] = defaultdict(list)
        for link in links:
            links_by_asset[link["asset_id"]].append(link)

        report = {
            "format": "nai-library-image-audit",
            "created_at": datetime.now().astimezone().isoformat(timespec="seconds"),
            "database": str(database_path),
            "options": {"deep": deep, "full": full, "mismatch_threshold": mismatch_threshold},
            "missing_originals": [],
            "missing_thumbnails": [],
            "images_without_prompt": [],
            "prompt_mismatches": [],
            "unrecorded_character_prompts": [],
            "shared_by_three_or_more": [],
        }
        scanned = cached_count = 0
        for index, row in enumerate(assets):
            if progress:
                progress(index, len(assets))
            source = asset_path(row, data_root).resolve()
            asset_links = links_by_asset.get(row['id'], [])
            base = {'asset_id': row['id'], 'path': str(source),
                    'entry_ids': [link['entry_id'] for link in asset_links],
                    'entry_titles': [link['title'] for link in asset_links]}
            if not source.is_file():
                report["missing_originals"].append(base)
                continue
            thumb = data_root / row["thumbnail_path"] if row["thumbnail_path"] else None
            if thumb is None or not thumb.is_file():
                report["missing_thumbnails"].append({**base, "thumbnail_path": str(thumb or "")})
            try:
                metadata = json.loads(row["metadata_json"] or "{}")
            except json.JSONDecodeError:
                metadata = {}
            cached_deep = bool((metadata.get("_scan") or {}).get("deep")) if isinstance(metadata, dict) else False
            needs_scan = full or not metadata_is_current(metadata, source) or (deep and not cached_deep)
            if needs_scan:
                try:
                    metadata = extract_image_metadata(source, include_stealth=deep)
                    metadata.setdefault("_scan", {})["deep"] = deep
                    connection.execute(
                        "UPDATE assets SET metadata_json = ? WHERE id = ?",
                        (json.dumps(metadata, ensure_ascii=False), row["id"]),
                    )
                    scanned += 1
                    connection.commit()
                except (OSError, ValueError) as error:
                    report["missing_originals"].append({**base, "error": str(error)})
                    continue
            else:
                cached_count += 1

            positive = str(metadata.get("positive_prompt") or "")
            characters = metadata.get("characters") if isinstance(metadata.get("characters"), list) else []
            if not metadata.get("has_prompt"):
                report["images_without_prompt"].append(base)
            asset_links = links_by_asset.get(row["id"], [])
            if len(asset_links) >= 3:
                report["shared_by_three_or_more"].append({
                    **base,
                    "entry_ids": [link["entry_id"] for link in asset_links],
                    "entry_titles": [link["title"] for link in asset_links],
                })
            for link in asset_links:
                measured = coverage(link["content"], positive)
                if measured is not None and measured < mismatch_threshold:
                    report["prompt_mismatches"].append({
                        **base, "entry_id": link["entry_id"], "entry_title": link["title"], "coverage": measured,
                    })
                missing_characters = []
                for prompt in characters:
                    measured_character = coverage(str(prompt), link["content"])
                    if measured_character is not None and measured_character < 0.5:
                        missing_characters.append(str(prompt))
                if missing_characters:
                    report["unrecorded_character_prompts"].append({
                        **base, "entry_id": link["entry_id"], "entry_title": link["title"],
                        "character_count": len(missing_characters),
                    })
        connection.commit()
        if progress:
            progress(len(assets), len(assets))
    finally:
        connection.close()

    report["summary"] = {
        "assets": len(assets), "scanned": scanned, "cached": cached_count,
        "elapsed_seconds": round(time.perf_counter() - started, 2),
    }
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    json_path = output_dir / f"图片审计-{stamp}.json"
    markdown_path = output_dir / f"图片审计-{stamp}.md"
    json_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    markdown_path.write_text(markdown_report(report), encoding="utf-8")
    return json_path, markdown_path, report


def main() -> int:
    parser = argparse.ArgumentParser(description="增量检查 NAI 资料库原图、缩略图和图片内嵌 Prompt。")
    parser.add_argument("--database", type=Path, default=DB_PATH)
    parser.add_argument("--output-dir", type=Path)
    parser.add_argument("--deep", action="store_true", help="尝试读取 PNG Alpha 隐写参数，速度较慢")
    parser.add_argument("--full", action="store_true", help="忽略缓存，重新读取全部图片")
    parser.add_argument("--mismatch-threshold", type=float, default=0.25)
    args = parser.parse_args()
    try:
        json_path, markdown_path, report = audit_library(
            args.database, args.output_dir, deep=args.deep, full=args.full,
            mismatch_threshold=max(0.0, min(1.0, args.mismatch_threshold)),
        )
        print(
            f"审计完成：{report['summary']['assets']} 张图片，实际读取 {report['summary']['scanned']} 张，"
            f"复用缓存 {report['summary']['cached']} 张，用时 {report['summary']['elapsed_seconds']} 秒。"
        )
        print(f"Markdown：{markdown_path}\nJSON：{json_path}")
        return 0
    except Exception as error:
        print(f"审计失败：{error}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
