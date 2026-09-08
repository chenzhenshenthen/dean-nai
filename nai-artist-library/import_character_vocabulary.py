from __future__ import annotations

import argparse
import json
import re
import sqlite3
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

from database import DB_PATH, ROOT, connect
from vocabulary import restore_custom_vocabulary


DEFAULT_SOURCE = ROOT.parent / "nai_hot_characters_zh_enhanced_appearance_v5_story_audit.md"
HEADING_RE = re.compile(r"^##\s+(.+?)\s*$")
ENTRY_RE = re.compile(r"^-\s+(.+?)：\s*,\s*([^,]+?)\s*,\s*(.+?)\s*$")


@dataclass(frozen=True)
class CharacterTag:
    name: str
    translation: str
    work: str
    enhanced_prompt: str


def canonical_tag(value: str) -> str:
    value = value.strip().replace("\\_", "_")
    return re.sub(r"\s+", "_", value).lower()


def qualified_translation(translation: str, work: str) -> str:
    """Return the searchable Chinese label, including its source work."""
    translation = translation.strip()
    work = work.strip()
    if not work:
        return translation
    suffix = f"（{work}）"
    return translation if translation.endswith(suffix) else f"{translation}{suffix}"


def parse_character_markdown(path: Path) -> list[CharacterTag]:
    rows: list[CharacterTag] = []
    seen: dict[str, int] = {}
    work = ""
    for line_number, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), start=1):
        heading = HEADING_RE.match(line)
        if heading:
            work = heading.group(1).strip()
            continue
        if not line.startswith("-"):
            continue
        entry = ENTRY_RE.match(line)
        if not entry:
            raise ValueError(f"第 {line_number} 行格式不正确：{line}")
        if not work:
            raise ValueError(f"第 {line_number} 行之前缺少作品二级标题")
        translation, raw_tag, enhanced_prompt = (part.strip() for part in entry.groups())
        name = canonical_tag(raw_tag)
        if not name or not translation or not enhanced_prompt:
            raise ValueError(f"第 {line_number} 行存在空字段")
        key = name.casefold()
        if key in seen:
            raise ValueError(f"第 {line_number} 行 Tag 重复；首次出现于第 {seen[key]} 行：{name}")
        seen[key] = line_number
        rows.append(CharacterTag(
            name,
            qualified_translation(translation, work),
            work,
            enhanced_prompt,
        ))
    if not rows:
        raise ValueError("没有解析到任何角色 Tag")
    return rows


def backup_database(database: Path) -> Path:
    backup_dir = ROOT / "backups"
    backup_dir.mkdir(parents=True, exist_ok=True)
    target = backup_dir / f"词库角色导入前-{datetime.now().strftime('%Y%m%d-%H%M%S')}.db"
    source_conn = sqlite3.connect(database, timeout=10)
    target_conn = sqlite3.connect(target)
    try:
        source_conn.backup(target_conn)
    finally:
        target_conn.close()
        source_conn.close()
    return target


def import_character_tags(source: Path, database: Path = DB_PATH, *, dry_run: bool = False) -> dict:
    rows = parse_character_markdown(source)
    source_file = f"custom:{source.stem}"

    # Opening once ensures schema migrations are applied before the online backup.
    with connect(database):
        pass

    with connect(database) as conn:
        existing = {
            str(row["name"]).casefold(): str(row["translation"])
            for row in conn.execute("SELECT name, translation FROM vocabulary_tags").fetchall()
        }
        manual = {
            str(row["name"]).casefold()
            for row in conn.execute("SELECT name FROM vocabulary_translations").fetchall()
        }
    added = sum(row.name.casefold() not in existing for row in rows)
    translation_updates = sum(
        row.name.casefold() in existing
        and row.name.casefold() not in manual
        and existing[row.name.casefold()] != row.translation
        for row in rows
    )
    result = {
        "parsed": len(rows),
        "works": len({row.work for row in rows}),
        "added": added,
        "translation_updates": translation_updates,
        "source_file": source_file,
        "database": str(database),
        "backup": None,
        "dry_run": dry_run,
    }
    if dry_run:
        return result

    backup = backup_database(database)
    imported_at = datetime.now().astimezone().isoformat(timespec="seconds")
    with connect(database) as conn:
        conn.execute("DELETE FROM vocabulary_custom_tags WHERE source_file = ?", (source_file,))
        conn.execute("DELETE FROM vocabulary_tags WHERE source_file = ?", (source_file,))
        conn.executemany(
            """
            INSERT INTO vocabulary_custom_tags(
                name, translation, work, enhanced_prompt, source_file, imported_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            """,
            [
                (row.name, row.translation, row.work, row.enhanced_prompt, source_file, imported_at)
                for row in rows
            ],
        )
        restore_custom_vocabulary(conn)
    result["backup"] = str(backup)
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="将作品分组的角色 Markdown 增量导入本地 Danbooru 标签词库")
    parser.add_argument("source", nargs="?", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--database", type=Path, default=DB_PATH)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    print(json.dumps(
        import_character_tags(args.source.resolve(), args.database.resolve(), dry_run=args.dry_run),
        ensure_ascii=False,
        indent=2,
    ))


if __name__ == "__main__":
    main()