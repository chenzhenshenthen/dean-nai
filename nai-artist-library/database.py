from __future__ import annotations

import json
import os
import re
import sqlite3
import unicodedata
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock


ROOT = Path(os.environ.get("DEAN_NAI_LIBRARY_ROOT") or Path(__file__).resolve().parent).resolve()
DATA_DIR = ROOT / "data"
ORIGINALS_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "library.db"
_INIT_LOCK = Lock()
_INITIALIZED_DATABASES: set[str] = set()


SCHEMA = """
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('artist', 'prompt')),
    title TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '',
    rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 10),
    style TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '未分类',
    notes TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '[]',
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    manual_order INTEGER NOT NULL DEFAULT 0,
    usage_count INTEGER NOT NULL DEFAULT 0,
    last_used_at TEXT,
    source_doc TEXT,
    source_index INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(source_doc, source_index)
);

CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    thumbnail_path TEXT,
    sha256 TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    UNIQUE(entry_id, sha256)
);

CREATE TABLE IF NOT EXISTS assets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    thumbnail_path TEXT,
    sha256 TEXT NOT NULL UNIQUE,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    external_path TEXT,
    width INTEGER,
    height INTEGER,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entry_images (
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (entry_id, asset_id)
);

CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('artist', 'prompt')),
    path TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    UNIQUE(kind, path)
);

CREATE TABLE IF NOT EXISTS custom_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('artist', 'prompt')),
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(kind, name)
);

CREATE TABLE IF NOT EXISTS entry_groups (
    entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
    group_id INTEGER NOT NULL REFERENCES custom_groups(id) ON DELETE CASCADE,
    PRIMARY KEY (entry_id, group_id)
);

CREATE TABLE IF NOT EXISTS app_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocabulary_sources (
    file_name TEXT PRIMARY KEY,
    sha256 TEXT NOT NULL,
    tag_count INTEGER NOT NULL DEFAULT 0,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocabulary_tags (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    translation TEXT NOT NULL DEFAULT '',
    hot INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocabulary_custom_tags (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    translation TEXT NOT NULL DEFAULT '',
    work TEXT NOT NULL DEFAULT '',
    enhanced_prompt TEXT NOT NULL DEFAULT '',
    source_file TEXT NOT NULL,
    imported_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media_cleanup_queue (
    asset_id INTEGER PRIMARY KEY,
    error TEXT
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_custom_tags_work
ON vocabulary_custom_tags(work);

CREATE TABLE IF NOT EXISTS vocabulary_pins (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    pinned_at TEXT NOT NULL
);


CREATE TABLE IF NOT EXISTS vocabulary_remote_tags (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    danbooru_id INTEGER UNIQUE,
    post_count INTEGER NOT NULL DEFAULT 0,
    category INTEGER NOT NULL DEFAULT 0,
    is_deprecated INTEGER NOT NULL DEFAULT 0,
    source_scope TEXT NOT NULL DEFAULT 'global',
    remote_created_at TEXT,
    remote_updated_at TEXT,
    synced_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vocabulary_translations (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    translation TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'manual',
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_entries_kind ON entries(kind);
CREATE INDEX IF NOT EXISTS idx_entries_rating ON entries(rating);
CREATE INDEX IF NOT EXISTS idx_entries_category ON entries(category);
CREATE INDEX IF NOT EXISTS idx_images_entry ON images(entry_id);

CREATE TABLE IF NOT EXISTS external_sources (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    parent_id TEXT REFERENCES external_sources(id) ON DELETE CASCADE,
    is_collection INTEGER NOT NULL DEFAULT 0,
    upstream_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'prompt',
    author TEXT NOT NULL DEFAULT '',
    version TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    nsfw INTEGER NOT NULL DEFAULT 0,
    entry_count INTEGER NOT NULL DEFAULT 0,
    image_count INTEGER NOT NULL DEFAULT 0,
    cached_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'not_installed',
    remote_state TEXT NOT NULL DEFAULT '',
    error TEXT NOT NULL DEFAULT '',
    last_sync_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS external_entries (
    source_id TEXT NOT NULL REFERENCES external_sources(id) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    prompt TEXT NOT NULL DEFAULT '',
    negative_prompt TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    source_note TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    available INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS external_entry_images (
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    image_index INTEGER NOT NULL DEFAULT 0,
    remote_url TEXT NOT NULL,
    thumb_path TEXT NOT NULL DEFAULT '',
    asset_revision TEXT NOT NULL DEFAULT '',
    width INTEGER,
    height INTEGER,
    cached_bytes INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_id, external_id, image_index),
    FOREIGN KEY (source_id, external_id)
        REFERENCES external_entries(source_id, external_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS external_user_data (
    source_id TEXT NOT NULL,
    external_id TEXT NOT NULL,
    favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
    pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
    personal_note TEXT NOT NULL DEFAULT '',
    saved_entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (source_id, external_id),
    FOREIGN KEY (source_id, external_id)
        REFERENCES external_entries(source_id, external_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entry_images_entry ON entry_images(entry_id);
CREATE INDEX IF NOT EXISTS idx_entry_images_asset ON entry_images(asset_id);
CREATE INDEX IF NOT EXISTS idx_categories_kind ON categories(kind);
CREATE INDEX IF NOT EXISTS idx_custom_groups_kind ON custom_groups(kind);
CREATE INDEX IF NOT EXISTS idx_entry_groups_group ON entry_groups(group_id);
CREATE INDEX IF NOT EXISTS idx_vocabulary_tags_hot ON vocabulary_tags(hot DESC);
CREATE INDEX IF NOT EXISTS idx_vocabulary_tags_category ON vocabulary_tags(category);
CREATE INDEX IF NOT EXISTS idx_vocabulary_tags_translation ON vocabulary_tags(translation);
CREATE INDEX IF NOT EXISTS idx_external_sources_provider ON external_sources(provider, parent_id);
CREATE INDEX IF NOT EXISTS idx_external_entries_source_order ON external_entries(source_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_external_entries_title ON external_entries(title COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_external_entries_category ON external_entries(source_id, category);
CREATE INDEX IF NOT EXISTS idx_external_images_cache ON external_entry_images(source_id, thumb_path);
CREATE INDEX IF NOT EXISTS idx_external_user_favorite ON external_user_data(favorite, pinned);
CREATE INDEX IF NOT EXISTS idx_vocabulary_remote_id ON vocabulary_remote_tags(danbooru_id);
CREATE INDEX IF NOT EXISTS idx_vocabulary_remote_scope ON vocabulary_remote_tags(source_scope);
"""


def safe_path_segment(value: str, fallback: str = "未命名") -> str:
    value = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", str(value)).strip().rstrip(".")
    value = re.sub(r"\s+", " ", value)
    return (value[:80] or fallback)


def entry_media_dir(kind: str, category: str, title: str) -> Path:
    if kind == "prompt":
        return ORIGINALS_DIR / "nai" / "场景"
    return ORIGINALS_DIR / "nai" / "画师串" / safe_path_segment(title)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def chinese_title_compare(left: str, right: str) -> int:
    """按 GB18030 的中文拼音区段排序，同时忽略拉丁字母大小写。"""
    left_text = unicodedata.normalize("NFKC", str(left)).casefold()
    right_text = unicodedata.normalize("NFKC", str(right)).casefold()
    left_key = left_text.encode("gb18030", errors="replace")
    right_key = right_text.encode("gb18030", errors="replace")
    if left_key != right_key:
        return (left_key > right_key) - (left_key < right_key)
    return (left_text > right_text) - (left_text < right_text)


def place_artist_in_manual_rating_group(conn: sqlite3.Connection, entry_id: int, rating: int | None) -> int:
    """Place an unpositioned artist after the last artist in its rating band."""
    current = conn.execute(
        "SELECT manual_order FROM entries WHERE id = ? AND kind = 'artist'",
        (entry_id,),
    ).fetchone()
    if not current or current[0] > 0:
        return int(current[0]) if current else 0

    if rating is None:
        anchor = conn.execute(
            "SELECT COALESCE(MAX(manual_order), 0) FROM entries WHERE kind = 'artist' AND manual_order > 0"
        ).fetchone()[0]
    else:
        anchor = conn.execute(
            """SELECT MAX(manual_order) FROM entries
               WHERE kind = 'artist' AND manual_order > 0 AND rating = ?""",
            (rating,),
        ).fetchone()[0]
        if anchor is None:
            anchor = conn.execute(
                """SELECT COALESCE(MAX(manual_order), 0) FROM entries
                   WHERE kind = 'artist' AND manual_order > 0 AND rating > ?""",
                (rating,),
            ).fetchone()[0]

    anchor = int(anchor or 0)
    conn.execute(
        "UPDATE entries SET manual_order = manual_order + 1 WHERE kind = 'artist' AND manual_order > ?",
        (anchor,),
    )
    position = anchor + 1
    conn.execute("UPDATE entries SET manual_order = ? WHERE id = ?", (position, entry_id))
    return position


def move_artist_to_manual_rating_group(conn: sqlite3.Connection, entry_id: int, rating: int | None) -> int:
    """Reinsert an existing artist at the end of its current rating band."""
    row = conn.execute(
        "SELECT manual_order FROM entries WHERE id = ? AND kind = 'artist'",
        (entry_id,),
    ).fetchone()
    if not row:
        return 0
    current = int(row[0] or 0)
    if current > 0:
        conn.execute(
            "UPDATE entries SET manual_order = manual_order - 1 WHERE kind = 'artist' AND manual_order > ?",
            (current,),
        )
    conn.execute("UPDATE entries SET manual_order = 0 WHERE id = ?", (entry_id,))
    return place_artist_in_manual_rating_group(conn, entry_id, rating)


def move_entry_to_manual_position(conn: sqlite3.Connection, entry_id: int, position: int) -> tuple[int, int]:
    row = conn.execute("SELECT kind FROM entries WHERE id = ?", (entry_id,)).fetchone()
    if not row:
        return 0, 0
    kind = row[0]
    ordered_ids = [item[0] for item in conn.execute(
        "SELECT id FROM entries WHERE kind = ? ORDER BY manual_order <= 0, manual_order, id",
        (kind,),
    ).fetchall()]
    ordered_ids.remove(entry_id)
    target = max(1, min(int(position), len(ordered_ids) + 1))
    ordered_ids.insert(target - 1, entry_id)
    conn.executemany(
        "UPDATE entries SET manual_order = ? WHERE id = ?",
        [(index + 1, item_id) for index, item_id in enumerate(ordered_ids)],
    )
    return target, len(ordered_ids)


def init_db(db_path: Path = DB_PATH) -> None:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    ORIGINALS_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.create_collation("ZH_PINYIN", chinese_title_compare)
    try:
        with conn:
            conn.executescript(SCHEMA)
            columns = {row[1] for row in conn.execute("PRAGMA table_info(entries)")}
            if "favorite" not in columns:
                conn.execute("ALTER TABLE entries ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0")
            if "pinned" not in columns:
                conn.execute("ALTER TABLE entries ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0")
            if "manual_order" not in columns:
                conn.execute("ALTER TABLE entries ADD COLUMN manual_order INTEGER NOT NULL DEFAULT 0")
            if "usage_count" not in columns:
                conn.execute("ALTER TABLE entries ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0")
            if "last_used_at" not in columns:
                conn.execute("ALTER TABLE entries ADD COLUMN last_used_at TEXT")
            if "style" not in columns:
                conn.execute("ALTER TABLE entries ADD COLUMN style TEXT NOT NULL DEFAULT ''")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_pinned ON entries(pinned)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_manual_order ON entries(kind, manual_order)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_usage ON entries(kind, usage_count, last_used_at)")
            conn.execute("CREATE INDEX IF NOT EXISTS idx_entries_style ON entries(kind, style)")
            seed_version = conn.execute("SELECT value FROM app_meta WHERE key = 'manual_order_seed'").fetchone()
            if not seed_version or seed_version[0] != "rating-and-usage-v2":
                for kind in ("artist", "prompt"):
                    by_id = [row[0] for row in conn.execute("SELECT id FROM entries WHERE kind = ? ORDER BY id", (kind,))]
                    current = [row[0] for row in conn.execute(
                        "SELECT id FROM entries WHERE kind = ? ORDER BY manual_order <= 0, manual_order, id", (kind,)
                    )]
                    # Preserve a sequence the user has actually rearranged. The previous migration's
                    # id-order seed is replaced because it was only an implementation default.
                    if current == by_id:
                        if kind == "artist":
                            order = "rating IS NULL, rating DESC, favorite DESC, usage_count DESC, last_used_at DESC, updated_at DESC, title COLLATE ZH_PINYIN"
                        else:
                            order = "favorite DESC, usage_count DESC, last_used_at DESC, updated_at DESC, title COLLATE ZH_PINYIN"
                        seeded = [row[0] for row in conn.execute(f"SELECT id FROM entries WHERE kind = ? ORDER BY {order}", (kind,))]
                        conn.executemany(
                            "UPDATE entries SET manual_order = ? WHERE id = ?",
                            [(index + 1, entry_id) for index, entry_id in enumerate(seeded)],
                        )
                conn.execute(
                    "INSERT INTO app_meta(key, value) VALUES ('manual_order_seed', 'rating-and-usage-v2') "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                )
            # Earlier versions only placed newly unpositioned artists into a rating band.
            # Existing positive manual_order values could therefore still contain mixed
            # ratings. Normalize that baseline once, preserving order inside each rating.
            rating_band_version = conn.execute(
                "SELECT value FROM app_meta WHERE key = 'artist_manual_rating_bands'"
            ).fetchone()
            if not rating_band_version or rating_band_version[0] != "v1":
                artist_ids = [row[0] for row in conn.execute(
                    """SELECT id FROM entries WHERE kind = 'artist'
                       ORDER BY rating IS NULL, rating DESC,
                                manual_order <= 0, manual_order, id"""
                )]
                conn.executemany(
                    "UPDATE entries SET manual_order = ? WHERE id = ?",
                    [(index + 1, entry_id) for index, entry_id in enumerate(artist_ids)],
                )
                conn.execute(
                    "INSERT INTO app_meta(key, value) VALUES ('artist_manual_rating_bands', 'v1') "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
                )
            # Entries created by the previous API were left at manual_order=0 and
            # therefore appeared at the very end. Move only those pending artists;
            # positive positions (including the user's custom ordering) stay intact.
            pending_artists = conn.execute(
                "SELECT id, rating FROM entries WHERE kind = 'artist' AND manual_order <= 0 ORDER BY id"
            ).fetchall()
            for entry_id, rating in pending_artists:
                place_artist_in_manual_rating_group(conn, entry_id, rating)
            asset_columns = {row[1] for row in conn.execute("PRAGMA table_info(assets)")}
            if "external_path" not in asset_columns:
                conn.execute("ALTER TABLE assets ADD COLUMN external_path TEXT")
            if "width" not in asset_columns:
                conn.execute("ALTER TABLE assets ADD COLUMN width INTEGER")
            if "height" not in asset_columns:
                conn.execute("ALTER TABLE assets ADD COLUMN height INTEGER")
            category_columns = {row[1] for row in conn.execute("PRAGMA table_info(categories)")}
            if "sort_order" not in category_columns:
                conn.execute("ALTER TABLE categories ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0")
            # 兼容第一版数据库：把旧的一对多图片表迁移为可跨资料复用的资源表。
            legacy_count = conn.execute("SELECT COUNT(*) FROM images").fetchone()[0]
            link_count = conn.execute("SELECT COUNT(*) FROM entry_images").fetchone()[0]
            if legacy_count and not link_count:
                now = utc_now()
                conn.execute(
                    """
                    INSERT OR IGNORE INTO assets (path, thumbnail_path, sha256, created_at)
                    SELECT MIN(path), MIN(thumbnail_path), sha256, ? FROM images GROUP BY sha256
                    """,
                    (now,),
                )
                conn.execute(
                    """
                    INSERT OR IGNORE INTO entry_images (entry_id, asset_id, sort_order)
                    SELECT images.entry_id, assets.id, images.sort_order
                    FROM images JOIN assets ON assets.sha256 = images.sha256
                    """
                )
    finally:
        conn.close()
    _INITIALIZED_DATABASES.add(str(db_path.resolve()))


@contextmanager
def connect(db_path: Path = DB_PATH):
    database_key = str(db_path.resolve())
    if database_key not in _INITIALIZED_DATABASES:
        with _INIT_LOCK:
            if database_key not in _INITIALIZED_DATABASES:
                init_db(db_path)
    conn = sqlite3.connect(db_path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.create_collation("ZH_PINYIN", chinese_title_compare)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 10000")
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def row_to_entry(row: sqlite3.Row, images: list[sqlite3.Row] | None = None) -> dict:
    item = dict(row)
    try:
        item["tags"] = json.loads(item.get("tags") or "[]")
    except json.JSONDecodeError:
        item["tags"] = []
    item["rating_value"] = item["rating"] / 2 if item.get("rating") else None
    item["images"] = [dict(image) for image in (images or [])]
    return item
