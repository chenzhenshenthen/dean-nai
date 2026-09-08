"""Durable second phase of card deletion. Never stores or deletes external originals."""
from pathlib import Path
from database import connect
from library_media import cleanup_detached


def enqueue_cleanup(conn, asset_ids):
    conn.executemany(
        "INSERT INTO media_cleanup_queue(asset_id,error) VALUES(?,NULL) ON CONFLICT(asset_id) DO UPDATE SET error=NULL",
        [(int(asset_id),) for asset_id in set(asset_ids)],
    )
    return Path(conn.execute("PRAGMA database_list").fetchone()[2]).resolve()


def drain_cleanup(database_path, progress=lambda *_: None):
    total = {"removed_files": 0, "removed_bytes": 0, "removed_assets": 0, "errors": []}
    processed = 0
    while True:
        # Small committed batches release the write lock between groups. The existing
        # cleaner rechecks references while locked, so newly shared images remain safe.
        with connect(database_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            ids = [row[0] for row in conn.execute(
                "SELECT asset_id FROM media_cleanup_queue WHERE error IS NULL ORDER BY asset_id LIMIT 16"
            )]
            if not ids:
                return total
            result = cleanup_detached(conn, ids)
            for name in ("removed_files", "removed_bytes", "removed_assets"):
                total[name] += result.get(name, 0)
            total["errors"].extend(result.get("errors", []))
            # Failed files remain inspectable/retryable through visual media cleanup.
            if result.get("errors"):
                conn.executemany("UPDATE media_cleanup_queue SET error=? WHERE asset_id=?", [("文件清理失败，请在图片检查中重试", asset_id) for asset_id in ids])
            else:
                conn.executemany("DELETE FROM media_cleanup_queue WHERE asset_id=?", [(asset_id,) for asset_id in ids])
        processed += len(ids)
        progress(processed)
