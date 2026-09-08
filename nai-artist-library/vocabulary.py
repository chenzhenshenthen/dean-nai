from __future__ import annotations

import base64
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock

from Crypto.Cipher import AES
from Crypto.Util.Padding import unpad


ROOT = Path(__file__).resolve().parent
DEFAULT_TAG_DIR = ROOT.parent / "tags"
PASSPHRASE = b"a-very-secret-key-that-is-not-so-secret"
INDEX_LOCK = Lock()


def _evp_bytes_to_key(passphrase: bytes, salt: bytes, key_length: int = 32, iv_length: int = 16) -> tuple[bytes, bytes]:
    """Derive the key and IV used by CryptoJS passphrase mode."""
    material = b""
    previous = b""
    while len(material) < key_length + iv_length:
        previous = hashlib.md5(previous + passphrase + salt).digest()
        material += previous
    return material[:key_length], material[key_length:key_length + iv_length]


def decrypt_cryptojs_json(path: Path) -> dict:
    payload = base64.b64decode(path.read_text(encoding="utf-8").strip())
    if payload[:8] != b"Salted__" or len(payload) < 32:
        raise ValueError(f"{path.name} \u4e0d\u662f\u6709\u6548\u7684 CryptoJS \u6570\u636e")
    key, iv = _evp_bytes_to_key(PASSPHRASE, payload[8:16])
    plaintext = unpad(AES.new(key, AES.MODE_CBC, iv).decrypt(payload[16:]), AES.block_size)
    data = json.loads(plaintext.decode("utf-8"))
    if not isinstance(data, dict):
        raise ValueError(f"{path.name} \u89e3\u5bc6\u540e\u4e0d\u662f\u5bf9\u8c61")
    return data


def _structured_rows(data: dict, source_file: str) -> list[tuple[str, str, int, str, str]]:
    groups = data.get("tag_groups") or []
    tags = data.get("tag_tags") or []
    group_names: dict[object, str] = {}
    subgroup_names: dict[object, str] = {}
    fallback = ""
    for group in groups:
        group_name = str(group.get("name") or "").strip()
        fallback = fallback or group_name
        group_id = group.get("id_index")
        if group_id is not None:
            group_names[group_id] = group_name
        for subgroup in group.get("subgroups") or []:
            subgroup_name = str(subgroup.get("name") or "").strip()
            subgroup_id = subgroup.get("id_index")
            if subgroup_id is not None:
                subgroup_names[subgroup_id] = "/".join(part for part in (group_name, subgroup_name) if part)
    rows = []
    for tag in tags:
        name = str(tag.get("text") or "").strip()
        if not name:
            continue
        subgroup_id = tag.get("subgroup_id")
        category = subgroup_names.get(subgroup_id) or group_names.get(subgroup_id) or fallback
        rows.append((name, str(tag.get("desc") or "").strip(), -1, category, source_file))
    return rows


DANBOORU_CATEGORIES = {
    0: "\u5e38\u89c4",
    1: "\u753b\u5e08",
    3: "\u7248\u6743\u4f5c\u54c1",
    4: "\u89d2\u8272",
    5: "\u5143\u6807\u7b7e",
}


def _danbooru_rows(data: dict, source_file: str) -> list[tuple[str, str, int, str, str]]:
    rows = []
    for tag in data.get("danbooru_tag") or []:
        name = str(tag.get("tag") or tag.get("name") or "").strip()
        if not name:
            continue
        try:
            hot = int(tag.get("hot") or 0)
        except (TypeError, ValueError):
            hot = 0
        try:
            color_id = int(tag.get("color_id"))
        except (TypeError, ValueError):
            color_id = -1
        rows.append((
            name,
            str(tag.get("translate") or tag.get("translation") or "").strip(),
            hot,
            DANBOORU_CATEGORIES.get(color_id, "\u672a\u5206\u7c7b"),
            source_file,
        ))
    return rows


def source_files(tag_dir: Path = DEFAULT_TAG_DIR) -> list[Path]:
    ordered = [tag_dir / "tags.json", tag_dir / "tag_NSFW001.json"]
    ordered.extend(sorted(tag_dir.glob("danbooru_*.json")))
    return [path for path in ordered if path.is_file()]


def source_fingerprint(tag_dir: Path = DEFAULT_TAG_DIR) -> dict[str, str]:
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source_files(tag_dir)}


def vocabulary_status(conn, tag_dir: Path = DEFAULT_TAG_DIR) -> dict:
    files = source_files(tag_dir)
    indexed_rows = conn.execute("SELECT file_name, sha256, tag_count, imported_at FROM vocabulary_sources").fetchall()
    indexed = {row["file_name"]: dict(row) for row in indexed_rows}
    fingerprints = source_fingerprint(tag_dir)
    total = conn.execute("SELECT COUNT(*) FROM vocabulary_tags").fetchone()[0]
    local_ready = not files or (
        len(indexed) == len(files)
        and all(indexed.get(name, {}).get("sha256") == digest for name, digest in fingerprints.items())
    )
    remote_source_count = int(conn.execute(
        "SELECT COUNT(DISTINCT source_scope) FROM vocabulary_remote_tags"
    ).fetchone()[0])
    remote_imported_at = conn.execute("SELECT MAX(synced_at) FROM vocabulary_remote_tags").fetchone()[0]
    custom_source_count = int(conn.execute(
        "SELECT COUNT(DISTINCT source_file) FROM vocabulary_custom_tags"
    ).fetchone()[0])
    custom_imported_at = conn.execute("SELECT MAX(imported_at) FROM vocabulary_custom_tags").fetchone()[0]
    local_imported_at = max((row["imported_at"] for row in indexed_rows), default=None)
    return {
        "available": bool(files) or bool(total),
        "ready": bool(total) and local_ready,
        "source_count": max(len(files), len(indexed)) + remote_source_count + custom_source_count,
        "indexed_sources": len(indexed),
        "tag_count": int(total),
        "tag_dir": str(tag_dir),
        "imported_at": max(filter(None, (local_imported_at, remote_imported_at, custom_imported_at)), default=None),
    }


def rebuild_vocabulary(conn, tag_dir: Path = DEFAULT_TAG_DIR) -> dict:
    files = source_files(tag_dir)
    if not files:
        return vocabulary_status(conn, tag_dir)
    fingerprints = source_fingerprint(tag_dir)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    rows_by_name: dict[str, tuple[str, str, int, str, str]] = {}
    source_counts: dict[str, int] = {}
    for path in files:
        data = decrypt_cryptojs_json(path)
        rows = _structured_rows(data, path.name) if "tag_groups" in data else _danbooru_rows(data, path.name)
        source_counts[path.name] = len(rows)
        for row in rows:
            key = row[0].casefold()
            current = rows_by_name.get(key)
            if current is None:
                rows_by_name[key] = row
                continue
            rows_by_name[key] = (
                current[0],
                current[1] or row[1],
                max(current[2], row[2]),
                current[3] or row[3],
                current[4],
            )
    conn.execute("DELETE FROM vocabulary_tags")
    conn.execute("DELETE FROM vocabulary_sources")
    conn.executemany(
        "INSERT INTO vocabulary_tags(name, translation, hot, category, source_file) VALUES (?, ?, ?, ?, ?)",
        rows_by_name.values(),
    )
    conn.executemany(
        "INSERT INTO vocabulary_sources(file_name, sha256, tag_count, imported_at) VALUES (?, ?, ?, ?)",
        [(path.name, fingerprints[path.name], source_counts[path.name], now) for path in files],
    )
    restore_custom_vocabulary(conn)
    restore_remote_vocabulary(conn)
    return vocabulary_status(conn, tag_dir)


def restore_custom_vocabulary(conn) -> None:
    manual_translations = {
        str(row["name"]).casefold(): str(row["translation"])
        for row in conn.execute("SELECT name, translation FROM vocabulary_translations").fetchall()
    }
    rows = conn.execute(
        "SELECT name, translation, source_file FROM vocabulary_custom_tags ORDER BY name COLLATE NOCASE"
    ).fetchall()
    for row in rows:
        name = str(row["name"])
        translation = manual_translations.get(name.casefold(), str(row["translation"]))
        conn.execute(
            """
            INSERT INTO vocabulary_tags(name, translation, hot, category, source_file)
            VALUES (?, ?, 0, '角色', ?)
            ON CONFLICT(name) DO UPDATE SET
                translation = CASE WHEN excluded.translation != '' THEN excluded.translation ELSE vocabulary_tags.translation END
            """,
            (name, translation, str(row["source_file"])),
        )


def restore_remote_vocabulary(conn) -> None:
    translations = {
        str(row["name"]).casefold(): str(row["translation"])
        for row in conn.execute("SELECT name, translation FROM vocabulary_translations").fetchall()
    }
    rows = conn.execute(
        "SELECT name, post_count, category, source_scope FROM vocabulary_remote_tags "
        "WHERE is_deprecated = 0 AND post_count > 0"
    ).fetchall()
    for row in rows:
        name = str(row["name"])
        translation = translations.get(name.casefold(), "")
        conn.execute(
            """
            INSERT INTO vocabulary_tags(name, translation, hot, category, source_file)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                translation = CASE WHEN excluded.translation != '' THEN excluded.translation ELSE vocabulary_tags.translation END,
                hot = excluded.hot,
                category = excluded.category,
                source_file = excluded.source_file
            """,
            (
                name, translation, int(row["post_count"]),
                DANBOORU_CATEGORIES.get(int(row["category"]), "\u672a\u5206\u7c7b"),
                f"danbooru-live:{row['source_scope']}",
            ),
        )


def ensure_vocabulary(conn, tag_dir: Path = DEFAULT_TAG_DIR) -> dict:
    status = vocabulary_status(conn, tag_dir)
    if status["ready"] or not status["available"]:
        return status
    with INDEX_LOCK:
        status = vocabulary_status(conn, tag_dir)
        return status if status["ready"] else rebuild_vocabulary(conn, tag_dir)


def search_vocabulary(conn, query: str, *, limit: int = 20, prefix: bool = False, category: str = "") -> list[dict]:
    return search_vocabulary_page(conn, query, limit=limit, prefix=prefix, category=category)["items"]


def _vocabulary_filter(query: str, prefix: bool, category: str, pinned_only: bool) -> tuple[list[str], list[object]]:
    conditions: list[str] = []
    params: list[object] = []
    if query:
        pattern = f"{query}%" if prefix else f"%{query}%"
        conditions.append("(t.name LIKE ? COLLATE NOCASE OR t.translation LIKE ? COLLATE NOCASE)")
        params.extend([pattern, pattern])
    if category:
        conditions.append("t.category = ?")
        params.append(category)
    if pinned_only:
        conditions.append("p.name IS NOT NULL")
    return conditions, params


def search_vocabulary_page(
    conn,
    query: str,
    *,
    limit: int = 20,
    offset: int = 0,
    prefix: bool = False,
    category: str = "",
    pinned_only: bool = False,
) -> dict:
    query = query.strip()
    if not query and not category and not pinned_only:
        return {"items": [], "total": 0}
    limit = max(1, min(int(limit), 200))
    offset = max(0, int(offset))
    conditions, filter_params = _vocabulary_filter(query, prefix, category, pinned_only)
    where_sql = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    total = int(conn.execute(
        f"""
        SELECT COUNT(*)
        FROM vocabulary_tags AS t
        LEFT JOIN vocabulary_pins AS p ON p.name = t.name
        {where_sql}
        """,
        filter_params,
    ).fetchone()[0])
    order_params: list[object] = []
    relevance_sql = ""
    if query:
        relevance_sql = (
            "CASE WHEN t.name = ? COLLATE NOCASE THEN 0 "
            "WHEN t.name LIKE ? COLLATE NOCASE THEN 1 ELSE 2 END,"
        )
        order_params.extend([query, f"{query}%"])
    rows = conn.execute(
        f"""
        SELECT t.name, t.translation, t.hot, t.category, t.source_file,
               CASE WHEN p.name IS NULL THEN 0 ELSE 1 END AS pinned
        FROM vocabulary_tags AS t
        LEFT JOIN vocabulary_pins AS p ON p.name = t.name
        {where_sql}
        ORDER BY p.name IS NULL, {relevance_sql} t.hot DESC, t.name COLLATE NOCASE
        LIMIT ? OFFSET ?
        """,
        [*filter_params, *order_params, limit, offset],
    ).fetchall()
    return {"items": [dict(row) for row in rows], "total": total}


def set_vocabulary_pin(conn, name: str, pinned: bool) -> bool:
    name = name.strip()
    if not name or not conn.execute("SELECT 1 FROM vocabulary_tags WHERE name = ? COLLATE NOCASE", (name,)).fetchone():
        return False
    if pinned:
        conn.execute(
            "INSERT OR REPLACE INTO vocabulary_pins(name, pinned_at) VALUES (?, ?)",
            (name, datetime.now(timezone.utc).isoformat(timespec="seconds")),
        )
    else:
        conn.execute("DELETE FROM vocabulary_pins WHERE name = ? COLLATE NOCASE", (name,))
    return True


def vocabulary_categories(conn) -> list[dict]:
    rows = conn.execute(
        "SELECT category, COUNT(*) AS count FROM vocabulary_tags WHERE category != '' GROUP BY category ORDER BY count DESC, category"
    ).fetchall()
    return [dict(row) for row in rows]
