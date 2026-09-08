from __future__ import annotations

import argparse
import json
import re
import ssl
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

import certifi
from threading import Lock


API_URL = "https://danbooru.donmai.us/tags.json"
USER_AGENT = "dean-nai-vocabulary-sync/1.0"
PAGE_SIZE = 200
SYNC_LOCK = Lock()
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
SCOPE_PATTERN = re.compile(r"^[a-z0-9][a-z0-9_:'!.-]{0,120}$")

CATEGORY_NAMES = {
    0: "\u5e38\u89c4",
    1: "\u753b\u5e08",
    3: "\u7248\u6743\u4f5c\u54c1",
    4: "\u89d2\u8272",
    5: "\u5143\u6807\u7b7e",
}

SEED_TRANSLATIONS = {
    "rover_(wuthering_waves)": "\u6f02\u6cca\u8005\uff08\u9e23\u6f6e\uff09",
    "female_rover_(wuthering_waves)": "\u5973\u6f02\u6cca\u8005\uff08\u9e23\u6f6e\uff09",
    "male_rover_(wuthering_waves)": "\u7537\u6f02\u6cca\u8005\uff08\u9e23\u6f6e\uff09",
}


class VocabularySyncError(RuntimeError):
    pass


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def meta_get(conn, key: str, default: str = "") -> str:
    row = conn.execute("SELECT value FROM app_meta WHERE key = ?", (key,)).fetchone()
    return str(row[0]) if row else default


def meta_set(conn, key: str, value: object) -> None:
    conn.execute(
        "INSERT INTO app_meta(key, value) VALUES (?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, str(value)),
    )


def seed_translation_overrides(conn) -> None:
    now = utc_now()
    conn.executemany(
        "INSERT OR IGNORE INTO vocabulary_translations(name, translation, origin, updated_at) VALUES (?, ?, 'builtin', ?)",
        [(name, translation, now) for name, translation in SEED_TRANSLATIONS.items()],
    )
    overrides = conn.execute(
        "SELECT name, translation FROM vocabulary_translations "
        "WHERE name IN ({})".format(",".join("?" for _ in SEED_TRANSLATIONS)),
        tuple(SEED_TRANSLATIONS),
    ).fetchall()
    conn.executemany(
        "UPDATE vocabulary_tags SET translation = ? WHERE name = ? COLLATE NOCASE",
        [(str(row["translation"]), str(row["name"])) for row in overrides],
    )


def _request_tags(params: dict[str, object], *, timeout: int = 30, retries: int = 3) -> list[dict]:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{API_URL}?{query}",
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
    )
    last_error: Exception | None = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(request, timeout=timeout, context=SSL_CONTEXT) as response:
                data = json.loads(response.read().decode("utf-8"))
            if not isinstance(data, list):
                raise VocabularySyncError("Danbooru \u8fd4\u56de\u4e86\u975e\u9884\u671f\u6570\u636e")
            return [item for item in data if isinstance(item, dict)]
        except (OSError, urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as error:
            last_error = error
            if attempt + 1 < retries:
                time.sleep(1.5 * (attempt + 1))
    raise VocabularySyncError(f"\u8fde\u63a5 Danbooru \u5931\u8d25\uff1a{last_error}")


def _normalized_item(item: dict) -> dict | None:
    try:
        tag_id = int(item.get("id"))
        name = str(item.get("name") or "").strip()
        post_count = max(0, int(item.get("post_count") or 0))
        category = int(item.get("category") or 0)
    except (TypeError, ValueError):
        return None
    if tag_id <= 0 or not name:
        return None
    return {
        "id": tag_id,
        "name": name,
        "post_count": post_count,
        "category": category,
        "is_deprecated": bool(item.get("is_deprecated")),
        "created_at": str(item.get("created_at") or ""),
        "updated_at": str(item.get("updated_at") or ""),
    }


def apply_remote_tags(conn, items: list[dict], *, source_scope: str, min_posts: int = 1) -> dict:
    seed_translation_overrides(conn)
    now = utc_now()
    normalized = [parsed for item in items if (parsed := _normalized_item(item)) is not None]
    translations = {
        str(row["name"]).casefold(): str(row["translation"])
        for row in conn.execute("SELECT name, translation FROM vocabulary_translations").fetchall()
    }
    inserted = updated = removed = skipped = 0
    for item in normalized:
        name = item["name"]
        previous = conn.execute(
            "SELECT post_count, category, is_deprecated FROM vocabulary_remote_tags WHERE name = ? COLLATE NOCASE",
            (name,),
        ).fetchone()
        conn.execute(
            """
            INSERT INTO vocabulary_remote_tags(
                name, danbooru_id, post_count, category, is_deprecated, source_scope,
                remote_created_at, remote_updated_at, synced_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                danbooru_id = excluded.danbooru_id,
                post_count = excluded.post_count,
                category = excluded.category,
                is_deprecated = excluded.is_deprecated,
                source_scope = excluded.source_scope,
                remote_created_at = excluded.remote_created_at,
                remote_updated_at = excluded.remote_updated_at,
                synced_at = excluded.synced_at
            """,
            (
                name, item["id"], item["post_count"], item["category"], int(item["is_deprecated"]),
                source_scope, item["created_at"], item["updated_at"], now,
            ),
        )
        if item["is_deprecated"] or item["post_count"] < min_posts:
            deleted = conn.execute(
                "DELETE FROM vocabulary_tags WHERE name = ? COLLATE NOCASE AND source_file LIKE 'danbooru-live:%'",
                (name,),
            ).rowcount
            removed += deleted
            skipped += 1
            continue
        translation = translations.get(name.casefold(), "")
        existing = conn.execute(
            "SELECT translation FROM vocabulary_tags WHERE name = ? COLLATE NOCASE",
            (name,),
        ).fetchone()
        if existing and not translation:
            translation = str(existing["translation"] or "")
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
                name,
                translation,
                item["post_count"],
                CATEGORY_NAMES.get(item["category"], "\u672a\u5206\u7c7b"),
                f"danbooru-live:{source_scope}",
            ),
        )
        if previous:
            updated += 1
        else:
            inserted += 1
    return {
        "received": len(items),
        "valid": len(normalized),
        "inserted": inserted,
        "updated": updated,
        "removed": removed,
        "skipped": skipped,
    }


def sync_global_incremental(conn, *, bootstrap_pages: int = 10, max_pages: int = 200) -> dict:
    if not SYNC_LOCK.acquire(blocking=False):
        raise VocabularySyncError("\u8bcd\u5e93\u540c\u6b65\u5df2\u5728\u8fdb\u884c")
    started = utc_now()
    try:
        last_id = int(meta_get(conn, "danbooru_last_tag_id", "0") or 0)
        items: list[dict] = []
        latest_id = 0
        reached_cursor = False
        page_limit = bootstrap_pages if last_id <= 0 else max_pages
        pages = 0
        for page in range(1, page_limit + 1):
            batch = _request_tags({
                "search[order]": "date",
                "limit": PAGE_SIZE,
                "page": page,
            })
            pages += 1
            if not batch:
                reached_cursor = True
                break
            ids = [int(item.get("id") or 0) for item in batch]
            latest_id = max(latest_id, max(ids, default=0))
            if last_id > 0:
                fresh = [item for item in batch if int(item.get("id") or 0) > last_id]
                items.extend(fresh)
                if len(fresh) < len(batch):
                    reached_cursor = True
                    break
            else:
                items.extend(batch)
            if len(batch) < PAGE_SIZE:
                reached_cursor = True
                break
            time.sleep(0.12)
        if last_id > 0 and not reached_cursor:
            raise VocabularySyncError(f"\u65b0\u6807\u7b7e\u8d85\u8fc7 {max_pages * PAGE_SIZE} \u6761\uff0c\u4e3a\u907f\u514d\u8df3\u8fc7\u6570\u636e\u672a\u63a8\u8fdb\u6e38\u6807")
        stats = apply_remote_tags(conn, items, source_scope="global", min_posts=1)
        if latest_id:
            meta_set(conn, "danbooru_last_tag_id", max(last_id, latest_id))
        meta_set(conn, "danbooru_last_sync_at", utc_now())
        meta_set(conn, "danbooru_last_error", "")
        return {
            **stats,
            "mode": "global",
            "pages": pages,
            "bootstrap": last_id <= 0,
            "previous_id": last_id,
            "latest_id": max(last_id, latest_id),
            "started_at": started,
            "finished_at": utc_now(),
        }
    except Exception as error:
        meta_set(conn, "danbooru_last_error", str(error))
        raise
    finally:
        SYNC_LOCK.release()


def sync_scope(
    conn,
    scope: str,
    *,
    category: int | None = 4,
    min_posts: int = 1,
    include_deprecated: bool = False,
    max_pages: int = 100,
) -> dict:
    scope = scope.strip().lower().replace(" ", "_")
    if not SCOPE_PATTERN.fullmatch(scope):
        raise VocabularySyncError("\u4f5c\u54c1\u6807\u7b7e\u53ea\u80fd\u5305\u542b\u82f1\u6587\u3001\u6570\u5b57\u548c\u5e38\u7528\u6807\u7b7e\u7b26\u53f7")
    if not SYNC_LOCK.acquire(blocking=False):
        raise VocabularySyncError("\u8bcd\u5e93\u540c\u6b65\u5df2\u5728\u8fdb\u884c")
    started = utc_now()
    try:
        items: list[dict] = []
        pages = 0
        for page in range(1, max_pages + 1):
            params: dict[str, object] = {
                "search[name_matches]": f"*_\u0028{scope}\u0029",
                "search[order]": "count",
                "limit": PAGE_SIZE,
                "page": page,
            }
            if category is not None:
                params["search[category]"] = category
            batch = _request_tags(params)
            raw_count = len(batch)
            pages += 1
            if not include_deprecated:
                batch = [item for item in batch if not item.get("is_deprecated")]
            items.extend(batch)
            if raw_count < PAGE_SIZE:
                break
            time.sleep(0.12)
        stats = apply_remote_tags(conn, items, source_scope=scope, min_posts=max(0, min_posts))
        meta_set(conn, f"danbooru_scope_sync:{scope}", utc_now())
        return {
            **stats,
            "mode": "scope",
            "scope": scope,
            "pages": pages,
            "min_posts": min_posts,
            "started_at": started,
            "finished_at": utc_now(),
        }
    finally:
        SYNC_LOCK.release()


def set_translation(conn, name: str, translation: str, *, origin: str = "manual") -> dict:
    name = name.strip()
    translation = translation.strip()
    if not name:
        raise VocabularySyncError("\u6807\u7b7e\u540d\u4e0d\u80fd\u4e3a\u7a7a")
    now = utc_now()
    if translation:
        conn.execute(
            """
            INSERT INTO vocabulary_translations(name, translation, origin, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET
                translation = excluded.translation,
                origin = excluded.origin,
                updated_at = excluded.updated_at
            """,
            (name, translation, origin, now),
        )
    else:
        conn.execute("DELETE FROM vocabulary_translations WHERE name = ? COLLATE NOCASE", (name,))
    updated = conn.execute(
        "UPDATE vocabulary_tags SET translation = ? WHERE name = ? COLLATE NOCASE",
        (translation, name),
    ).rowcount
    return {"name": name, "translation": translation, "updated": bool(updated)}


def sync_status(conn) -> dict:
    # Keep status checks read-only. Writing here would open a SQLite write
    # transaction before the scheduled network request and lock the whole local
    # library while Danbooru is being contacted.
    enabled = meta_get(conn, "danbooru_daily_sync_enabled", "true").lower() != "false"
    try:
        interval_hours = max(1, min(168, int(meta_get(conn, "danbooru_sync_interval_hours", "24"))))
    except ValueError:
        interval_hours = 24
    last_sync = meta_get(conn, "danbooru_last_sync_at", "")
    due = True
    next_sync = ""
    if last_sync:
        try:
            next_dt = datetime.fromisoformat(last_sync) + timedelta(hours=interval_hours)
            next_sync = next_dt.isoformat(timespec="seconds")
            due = datetime.now(timezone.utc) >= next_dt
        except ValueError:
            pass
    return {
        "enabled": enabled,
        "interval_hours": interval_hours,
        "last_sync_at": last_sync or None,
        "next_sync_at": next_sync or None,
        "last_tag_id": int(meta_get(conn, "danbooru_last_tag_id", "0") or 0),
        "last_error": meta_get(conn, "danbooru_last_error", "") or None,
        "due": due,
        "running": SYNC_LOCK.locked(),
        "remote_tag_count": int(conn.execute("SELECT COUNT(*) FROM vocabulary_remote_tags").fetchone()[0]),
        "translation_count": int(conn.execute("SELECT COUNT(*) FROM vocabulary_translations").fetchone()[0]),
    }


def configure_sync(conn, *, enabled: bool, interval_hours: int) -> dict:
    meta_set(conn, "danbooru_daily_sync_enabled", "true" if enabled else "false")
    meta_set(conn, "danbooru_sync_interval_hours", max(1, min(168, int(interval_hours))))
    return sync_status(conn)


def sync_if_due(conn) -> dict | None:
    status = sync_status(conn)
    if not status["enabled"] or not status["due"]:
        return None
    return sync_global_incremental(conn)


def main() -> None:
    from database import connect

    parser = argparse.ArgumentParser(description="dean-nai Danbooru \u8bcd\u5e93\u589e\u91cf\u540c\u6b65")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--global-sync", action="store_true", help="\u540c\u6b65 Danbooru \u6700\u65b0\u5168\u5c40\u6807\u7b7e")
    mode.add_argument("--scope", help="\u6df1\u5ea6\u540c\u6b65\u6307\u5b9a\u4f5c\u54c1\u6807\u7b7e")
    parser.add_argument("--category", type=int, default=4)
    parser.add_argument("--min-posts", type=int, default=1)
    args = parser.parse_args()
    with connect() as conn:
        result = (
            sync_global_incremental(conn)
            if args.global_sync
            else sync_scope(conn, args.scope, category=args.category, min_posts=args.min_posts)
        )
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
