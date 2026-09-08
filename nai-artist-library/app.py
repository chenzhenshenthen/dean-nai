from __future__ import annotations

import json
import base64
import csv
import os
import random
import math
import webbrowser
import hashlib
import io
import sqlite3
import ssl
import time
import urllib.error
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path
from threading import Lock, Timer
from uuid import uuid4
from nai_token import normalize_novelai_token, has_novelai_token_format

from flask import Flask, abort, jsonify, request, send_file, send_from_directory
from PIL import Image, ImageOps
import certifi

from database import DATA_DIR, ORIGINALS_DIR, ROOT, connect, entry_media_dir, init_db, move_artist_to_manual_rating_group, move_entry_to_manual_position, place_artist_in_manual_rating_group, row_to_entry, utc_now
from image_metadata import extract_image_metadata, metadata_is_current
from library_media import cleanup_detached, unused_plan, clean_unused, data_root as media_data_root
from media_cleanup_queue import enqueue_cleanup, drain_cleanup
from library_audit import audit_library, markdown_report
from database import connect as maintenance_connect
from integrated_features import integrated, load_settings as load_integrated_settings, scan_local_gallery
from online_gallery import online_gallery
from docx_database_converter import (
    apply_incremental_update,
    build_incremental_plan,
    incremental_known_titles,
    read_incremental_document,
)
from vocabulary import (
    ensure_vocabulary,
    rebuild_vocabulary,
    search_vocabulary,
    search_vocabulary_page,
    set_vocabulary_pin,
    vocabulary_categories,
    vocabulary_status,
)

from external_library import external_libraries
from vocabulary_sync import (
    VocabularySyncError,
    configure_sync,
    set_translation,
    sync_global_incremental,
    sync_if_due,
    sync_scope,
    sync_status,
)

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 512 * 1024 * 1024
APP_VERSION = "2026.09.08.1"
MEDIA_CLEANUP_PREVIEWS: dict[str, tuple[float, dict]] = {}
MAINTENANCE_LOCK = Lock()
BACKUP_DIR = ROOT / "backups"
MOBILE_EXPORT_DIR = DATA_DIR / "mobile-exports"
BACKGROUND_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="nai-media")
MEDIA_DELETE_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="nai-media-delete")
MEDIA_QUEUE_CHECKED = set()
BACKGROUND_JOBS: dict[str, dict] = {}
BACKGROUND_JOBS_LOCK = Lock()
MOBILE_EXPORT_JOBS: dict[str, dict] = {}
MOBILE_EXPORT_JOBS_LOCK = Lock()
LIBRARY_IMPORT_DRAFTS: dict[str, tuple[float, dict]] = {}
LIBRARY_IMPORT_DRAFTS_LOCK = Lock()
DESKTOP_WEB_DIR = Path(os.environ.get("DEAN_DESKTOP_WEB_DIR") or (ROOT.parent / "deanai" / "desktop-web-dist"))


@app.after_request
def disable_dynamic_cache(response):
    immutable_thumb = request.path.startswith("/api/external-libraries/thumbnail/")
    if not immutable_thumb and (request.path in {"/", "/converter"} or request.path.startswith(("/api/", "/static/"))):
        response.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
        response.headers["Pragma"] = "no-cache"
    return response


def load_images(conn, entry_ids: list[int]) -> dict[int, list]:
    if not entry_ids:
        return {}
    placeholders = ",".join("?" for _ in entry_ids)
    rows = conn.execute(
        f"""
        SELECT assets.id, entry_images.entry_id, assets.path, assets.thumbnail_path,
               assets.sha256, assets.metadata_json, assets.external_path, assets.width, assets.height,
               entry_images.sort_order
        FROM entry_images JOIN assets ON assets.id = entry_images.asset_id
        WHERE entry_images.entry_id IN ({placeholders})
        ORDER BY entry_images.sort_order, assets.id
        """,
        entry_ids,
    ).fetchall()
    grouped: dict[int, list] = {}
    for row in rows:
        image = dict(row)
        try:
            image["metadata"] = json.loads(image.pop("metadata_json") or "{}")
        except json.JSONDecodeError:
            image["metadata"] = {}
        image["url"] = f"/asset/{image['id']}"
        image["thumbnail_url"] = f"/media/{image['thumbnail_path']}" if image.get("thumbnail_path") else image["url"]
        grouped.setdefault(image["entry_id"], []).append(image)
    return grouped


def load_entry_groups(conn, entry_ids: list[int]) -> dict[int, list]:
    if not entry_ids:
        return {}
    placeholders = ",".join("?" for _ in entry_ids)
    rows = conn.execute(
        f"""
        SELECT entry_groups.entry_id, custom_groups.id, custom_groups.name
        FROM entry_groups JOIN custom_groups ON custom_groups.id = entry_groups.group_id
        WHERE entry_groups.entry_id IN ({placeholders})
        ORDER BY custom_groups.name COLLATE NOCASE
        """,
        entry_ids,
    ).fetchall()
    grouped: dict[int, list] = {}
    for row in rows:
        grouped.setdefault(row["entry_id"], []).append({"id": row["id"], "name": row["name"]})
    return grouped


def entries_with_relations(conn, rows) -> list[dict]:
    ids = [row["id"] for row in rows]
    images = load_images(conn, ids)
    groups = load_entry_groups(conn, ids)
    entries = []
    for row in rows:
        entry = row_to_entry(row, images.get(row["id"], []))
        entry["groups"] = groups.get(row["id"], [])
        entries.append(entry)
    return entries


def backfill_asset_dimensions() -> int:
    updated = 0
    with connect() as conn:
        rows = conn.execute(
            "SELECT id, path, external_path FROM assets WHERE width IS NULL OR height IS NULL"
        ).fetchall()
        for row in rows:
            source = Path(row["external_path"]) if row["external_path"] else DATA_DIR / row["path"]
            if not source.is_file():
                continue
            try:
                with Image.open(source) as image:
                    width, height = ImageOps.exif_transpose(image).size
                conn.execute("UPDATE assets SET width = ?, height = ? WHERE id = ?", (width, height, row["id"]))
                updated += 1
            except Exception:
                continue
    return updated


@app.get("/")
def index():
    if os.environ.get("NYA_UNIFIED_DESKTOP") == "1" and (DESKTOP_WEB_DIR / "index.html").is_file():
        html = (DESKTOP_WEB_DIR / "index.html").read_text(encoding="utf-8")
        theme = load_integrated_settings()
        slots = theme["theme_slots"]
        active = theme["theme_active_slot"]
        color = slots[active]
        bootstrap = (
            "<script>try{"
            f"localStorage.setItem('nya-accent-slots',{json.dumps(json.dumps(slots))});"
            f"localStorage.setItem('nya-accent-active-slot','{active}');"
            "localStorage.setItem('nya-accent','custom');"
            f"localStorage.setItem('nya-accent-color','{color}');"
            "}catch(e){}</script>"
        )
        html = html.replace("<head>", "<head>" + bootstrap, 1)
        return app.response_class(html, mimetype="text/html")
    return send_from_directory(app.static_folder, "index.html")


@app.get("/library")
@app.get("/library/")
@app.get("/library-embed")
@app.get("/library-embed/")
def library_page():
    return send_from_directory(app.static_folder, "index.html")


@app.post("/api/novelai/subscription")
def novelai_subscription():
    payload = request.get_json(silent=True) or {}
    raw_token = payload.get("token") if isinstance(payload, dict) else None
    token = normalize_novelai_token(raw_token) if isinstance(raw_token, str) else ""
    if not has_novelai_token_format(token):
        abort(400, "Token 格式无效")
    upstream_request = urllib.request.Request(
        "https://image.novelai.net/user/subscription",
        headers={"Authorization": f"Bearer {token}", "Accept": "application/json",
                 "Content-Type": "application/json", "User-Agent": "deanai/2.0.0"},
    )
    try:
        # Match the working script's standard urllib TLS setup (verification stays on).
        # Use our own client identity, not another launcher's User-Agent.
        with urllib.request.urlopen(upstream_request, timeout=30) as response:
            return app.response_class(
                response.read(),
                status=response.status,
                content_type=response.headers.get("content-type", "application/json"),
                headers={"Cache-Control": "no-store"},
            )
    except urllib.error.HTTPError as error:
        return app.response_class(
            error.read(),
            status=error.code,
            content_type=error.headers.get("content-type", "application/json"),
            headers={"Cache-Control": "no-store"},
        )
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        return jsonify({"error": f"NovelAI 订阅接口暂时不可用：{error}"}), 502


@app.post("/api/library/import-drafts")
def create_library_import_draft():
    payload = request.get_json(silent=True) or {}
    request_id = str(payload.get("requestId") or "")
    if not request_id or len(request_id) > 80:
        abort(400, "无效的资料库草稿编号")
    if payload.get("type") != "nyanovel-library-import":
        abort(400, "无效的资料库草稿")
    if payload.get("kind") not in {"artist", "prompt"} or not isinstance(payload.get("content"), str):
        abort(400, "资料库草稿内容无效")
    now = time.monotonic()
    with LIBRARY_IMPORT_DRAFTS_LOCK:
        expired = [key for key, (created, _) in LIBRARY_IMPORT_DRAFTS.items() if now - created > 120]
        for key in expired:
            LIBRARY_IMPORT_DRAFTS.pop(key, None)
        LIBRARY_IMPORT_DRAFTS[request_id] = (now, payload)
    return jsonify({"ok": True, "requestId": request_id})


@app.get("/api/library/import-drafts/<request_id>")
def consume_library_import_draft(request_id: str):
    with LIBRARY_IMPORT_DRAFTS_LOCK:
        saved = LIBRARY_IMPORT_DRAFTS.pop(request_id, None)
    if not saved or time.monotonic() - saved[0] > 120:
        abort(404, "资料库草稿已过期或不存在")
    return jsonify(saved[1])


@app.get("/converter")
def converter_page():
    return send_from_directory(app.static_folder, "converter.html")


def parse_incremental_document(kind: str, payload: bytes, suffix: str):
    known_titles = incremental_known_titles(DATA_DIR / "library.db", kind)
    if kind not in {"prompt", "artist"}:
        abort(400, "更新类型必须是场景或画师串")
    return read_incremental_document(io.BytesIO(payload), kind, suffix, known_titles)


def incremental_plan_token(plan: dict) -> str:
    return hashlib.sha256(
        json.dumps(plan, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


@app.post("/api/converter/preview")
def preview_incremental_update():
    uploaded = request.files.get("document")
    kind = str(request.form.get("kind") or "")
    delete_missing = request.form.get("delete_missing") == "1"
    if not uploaded or not uploaded.filename:
        abort(400, "请选择 DOCX 或 Markdown 文件")
    suffix = Path(uploaded.filename).suffix.lower()
    if suffix not in {".docx", ".md", ".markdown"}:
        abort(400, "只支持 .docx、.md 或 .markdown 文件")
    payload = uploaded.read()
    if not payload:
        abort(400, "更新文件为空")
    try:
        records = parse_incremental_document(kind, payload, suffix)
        plan = build_incremental_plan(DATA_DIR / "library.db", kind, records, delete_missing=delete_missing)
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        abort(400, str(error))
    return jsonify({
        "filename": Path(uploaded.filename).name,
        "document_digest": hashlib.sha256(payload).hexdigest(),
        "plan_token": incremental_plan_token(plan),
        "plan": plan,
    })


@app.post("/api/converter/apply")
def apply_incremental_update_api():
    uploaded = request.files.get("document")
    kind = str(request.form.get("kind") or "")
    delete_missing = request.form.get("delete_missing") == "1"
    expected_document = str(request.form.get("document_digest") or "")
    expected_plan = str(request.form.get("plan_token") or "")
    if not uploaded or not uploaded.filename or not expected_document or not expected_plan:
        abort(400, "请先预览同一个 Word 文件，再确认应用")
    suffix = Path(uploaded.filename).suffix.lower()
    if suffix not in {".docx", ".md", ".markdown"}:
        abort(400, "只支持 .docx、.md 或 .markdown 文件")
    payload = uploaded.read()
    if hashlib.sha256(payload).hexdigest() != expected_document:
        abort(409, "Word 文件在预览后发生变化，请重新预览")
    try:
        records = parse_incremental_document(kind, payload, suffix)
        current_plan = build_incremental_plan(DATA_DIR / "library.db", kind, records, delete_missing=delete_missing)
        if incremental_plan_token(current_plan) != expected_plan:
            abort(409, "数据库或更新选项在预览后发生变化，请重新预览")
        applied_plan, backup_path = apply_incremental_update(
            DATA_DIR / "library.db", kind, records, delete_missing=delete_missing, backup_dir=BACKUP_DIR,
        )
    except (OSError, ValueError, zipfile.BadZipFile) as error:
        abort(400, str(error))
    return jsonify({
        "ok": True,
        "kind": kind,
        "counts": applied_plan["counts"],
        "backup": str(backup_path),
        'media_cleanup': applied_plan.get('media_cleanup'),
    })


@app.get("/api/vocabulary/status")
def vocabulary_status_api():
    with connect() as conn:
        return jsonify(vocabulary_status(conn))


@app.post("/api/vocabulary/reindex")
def vocabulary_reindex_api():
    try:
        with connect() as conn:
            return jsonify(rebuild_vocabulary(conn))
    except (OSError, ValueError, json.JSONDecodeError) as error:
        abort(400, f"\u91cd\u5efa\u8bcd\u5e93\u5931\u8d25\uff1a{error}")


@app.get("/api/vocabulary/search")
def vocabulary_search_api():
    query = str(request.args.get("q") or "").strip()
    try:
        limit = int(request.args.get("limit") or 20)
        offset = int(request.args.get("offset") or 0)
    except ValueError:
        abort(400, "limit \u548c offset \u5fc5\u987b\u662f\u6574\u6570")
    prefix = str(request.args.get("prefix") or "").lower() in {"1", "true", "yes"}
    category = str(request.args.get("category") or "").strip()
    pinned_only = str(request.args.get("pinned") or "").lower() in {"1", "true", "yes"}
    with connect() as conn:
        status = ensure_vocabulary(conn)
        if not status["available"]:
            return jsonify({"items": [], "total": 0, "status": status})
        page = search_vocabulary_page(
            conn, query, limit=limit, offset=offset, prefix=prefix, category=category, pinned_only=pinned_only
        )
        return jsonify({**page, "status": status})


@app.put("/api/vocabulary/pin")
def vocabulary_pin_api():
    payload = request.get_json(silent=True) or {}
    name = str(payload.get("name") or "").strip()
    pinned = bool(payload.get("pinned"))
    with connect() as conn:
        if not set_vocabulary_pin(conn, name, pinned):
            abort(404, "\u6807\u7b7e\u4e0d\u5b58\u5728")
    return jsonify({"name": name, "pinned": pinned})


@app.get("/api/vocabulary/categories")
def vocabulary_categories_api():
    with connect() as conn:
        status = ensure_vocabulary(conn)
        return jsonify({"items": vocabulary_categories(conn) if status["ready"] else [], "status": status})


@app.get("/api/vocabulary/sync/status")
def vocabulary_sync_status_api():
    with connect() as conn:
        return jsonify(sync_status(conn))


@app.put("/api/vocabulary/sync/settings")
def vocabulary_sync_settings_api():
    payload = request.get_json(silent=True) or {}
    try:
        interval_hours = int(payload.get("interval_hours") or 24)
    except (TypeError, ValueError):
        abort(400, "\u540c\u6b65\u95f4\u9694\u5fc5\u987b\u662f\u6574\u6570")
    with connect() as conn:
        return jsonify(configure_sync(
            conn,
            enabled=bool(payload.get("enabled", True)),
            interval_hours=interval_hours,
        ))


@app.post("/api/vocabulary/sync/global")
def vocabulary_sync_global_api():
    try:
        with connect() as conn:
            result = sync_global_incremental(conn)
            return jsonify({"result": result, "status": sync_status(conn), "vocabulary": vocabulary_status(conn)})
    except VocabularySyncError as error:
        abort(502, str(error))


@app.post("/api/vocabulary/sync/scope")
def vocabulary_sync_scope_api():
    payload = request.get_json(silent=True) or {}
    scope = str(payload.get("scope") or "")
    try:
        category_value = payload.get("category", 4)
        category = None if category_value in (None, "", "all") else int(category_value)
        min_posts = max(0, int(payload.get("min_posts") or 1))
    except (TypeError, ValueError):
        abort(400, "\u7c7b\u522b\u548c\u6700\u4f4e\u4f7f\u7528\u91cf\u5fc5\u987b\u662f\u6574\u6570")
    try:
        with connect() as conn:
            result = sync_scope(
                conn,
                scope,
                category=category,
                min_posts=min_posts,
                include_deprecated=bool(payload.get("include_deprecated", False)),
            )
            return jsonify({"result": result, "status": sync_status(conn), "vocabulary": vocabulary_status(conn)})
    except VocabularySyncError as error:
        abort(502, str(error))


@app.put("/api/vocabulary/translation")
def vocabulary_translation_api():
    payload = request.get_json(silent=True) or {}
    try:
        with connect() as conn:
            return jsonify(set_translation(
                conn,
                str(payload.get("name") or ""),
                str(payload.get("translation") or ""),
            ))
    except VocabularySyncError as error:
        abort(400, str(error))

def index_vocabulary_background() -> None:
    try:
        with connect() as conn:
            ensure_vocabulary(conn)
        # Finish local index writes before any slow remote request.
        # Network latency must never extend a SQLite write transaction.
        with connect() as conn:
            result = sync_if_due(conn)
            if result:
                app.logger.info("Danbooru vocabulary sync complete: %s", result)
    except Exception as error:
        app.logger.warning("\u540e\u53f0\u5efa\u7acb\u8bcd\u5e93\u7d22\u5f15\u5931\u8d25\uff1a%s", error)
    finally:
        timer = Timer(60 * 60, lambda: BACKGROUND_EXECUTOR.submit(index_vocabulary_background))
        timer.daemon = True
        timer.start()


@app.get("/api/version")
def version():

    return jsonify({"version": APP_VERSION})


@app.get("/media/<path:filename>")
def media(filename: str):
    return send_from_directory(DATA_DIR, filename)


def asset_source_path(row) -> Path:
    if row["external_path"]:
        return Path(row["external_path"])
    if str(row["path"]).startswith("原图/"):
        return ROOT / Path(row["path"])
    return DATA_DIR / Path(row["path"])


@app.get("/asset/<int:asset_id>")
def external_asset(asset_id: int):
    with connect() as conn:
        row = conn.execute("SELECT path, external_path FROM assets WHERE id = ?", (asset_id,)).fetchone()
    if not row:
        abort(404)
    path = asset_source_path(row)
    path = path.resolve()
    if not path.is_file():
        abort(404, "本地原图已移动或不存在")
    return send_file(path)


@app.get("/api/assets/<int:asset_id>/metadata")
def asset_metadata(asset_id: int):
    deep = request.args.get("deep") == "1"
    with connect() as conn:
        row = conn.execute(
            "SELECT id, path, external_path, metadata_json FROM assets WHERE id = ?", (asset_id,)
        ).fetchone()
        if not row:
            abort(404, "图片不存在")
        path = asset_source_path(row).resolve()
        if not path.is_file():
            abort(404, "本地原图已移动或不存在")
        try:
            cached = json.loads(row["metadata_json"] or "{}")
        except json.JSONDecodeError:
            cached = {}
        if deep or not metadata_is_current(cached, path):
            try:
                cached = extract_image_metadata(path, include_stealth=deep)
            except (OSError, ValueError) as error:
                abort(422, f"无法读取图片元数据：{error}")
            conn.execute(
                "UPDATE assets SET metadata_json = ? WHERE id = ?",
                (json.dumps(cached, ensure_ascii=False), asset_id),
            )
    return jsonify(cached)


@app.get("/api/settings")
def settings():
    ORIGINALS_DIR.mkdir(parents=True, exist_ok=True)
    return jsonify({"media_dir": str(ORIGINALS_DIR), "originals_dir": str(ORIGINALS_DIR)})


@app.get("/api/export/json")
def export_json():
    with connect() as conn:
        rows = conn.execute("SELECT * FROM entries ORDER BY kind, category, title COLLATE ZH_PINYIN").fetchall()
        entries = entries_with_relations(conn, rows)
    for entry in entries:
        for image in entry["images"]:
            if "metadata" not in image:
                try:
                    image["metadata"] = json.loads(image.pop("metadata_json", "{}") or "{}")
                except json.JSONDecodeError:
                    image["metadata"] = {}
    payload = {
        "format": "nai-artist-library-export",
        "format_version": 1,
        "app_version": APP_VERSION,
        "exported_at": utc_now(),
        "media_dir": str(ORIGINALS_DIR),
        "entries": entries,
    }
    data = json.dumps(payload, ensure_ascii=False, indent=2).encode("utf-8")
    filename = f"nai资料库-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    return send_file(io.BytesIO(data), mimetype="application/json; charset=utf-8", as_attachment=True, download_name=filename)


def _portable_data_url(path_value: str | None) -> str:
    path = DATA_DIR / path_value if path_value else None
    if not path or not path.is_file():
        return ""
    suffix = path.suffix.lower()
    mime = {".png": "image/png", ".webp": "image/webp", ".gif": "image/gif"}.get(suffix, "image/jpeg")
    return f"data:{mime};base64,{base64.b64encode(path.read_bytes()).decode('ascii')}"


def _mobile_local_entries() -> list[dict]:
    with connect() as conn:
        rows = conn.execute("SELECT * FROM entries ORDER BY kind, manual_order <= 0, manual_order, id").fetchall()
        entries = entries_with_relations(conn, rows)
    for entry in entries:
        entry["images"] = [{
            "id": image["id"], "width": image.get("width"), "height": image.get("height"),
            "thumbnail_data_url": _portable_data_url(image.get("thumbnail_path")),
        } for image in entry.get("images", [])]
    return entries


def _resolve_mobile_external_sources(requested_ids: list[str] | None) -> tuple[list[dict], set[str]]:
    with connect() as conn:
        rows = [dict(row) for row in conn.execute(
            "SELECT * FROM external_sources ORDER BY parent_id IS NOT NULL,parent_id,title COLLATE NOCASE"
        ).fetchall()]
    by_id = {str(row["id"]): row for row in rows}
    if requested_ids is None:
        entry_source_ids = set(by_id)
    else:
        unknown = sorted(set(requested_ids) - set(by_id))
        if unknown:
            raise ValueError(f"外置资料源不存在：{', '.join(unknown)}")
        entry_source_ids = set(requested_ids)
        changed = True
        while changed:
            before = len(entry_source_ids)
            entry_source_ids.update(
                source_id for source_id, row in by_id.items()
                if row.get("parent_id") in entry_source_ids
            )
            changed = len(entry_source_ids) != before

    metadata_ids = set(entry_source_ids)
    for source_id in tuple(metadata_ids):
        parent_id = by_id.get(source_id, {}).get("parent_id")
        while parent_id and parent_id not in metadata_ids:
            metadata_ids.add(parent_id)
            parent_id = by_id.get(parent_id, {}).get("parent_id")
    sources = [row for row in rows if str(row["id"]) in metadata_ids]
    for source in sources:
        source["is_collection"] = bool(source.get("is_collection"))
        source["nsfw"] = bool(source.get("nsfw"))
    return sources, entry_source_ids


def _mobile_external_data(
    source_ids: list[str] | None = None,
    progress=None,
) -> tuple[list[dict], list[dict]]:
    sources, entry_source_ids = _resolve_mobile_external_sources(source_ids)
    if source_ids is not None and not entry_source_ids:
        return sources, []
    where = "e.available=1"
    args: tuple[str, ...] = ()
    if source_ids is not None:
        marks = ",".join("?" for _ in entry_source_ids)
        where += f" AND e.source_id IN ({marks})"
        args = tuple(sorted(entry_source_ids))
    with connect() as conn:
        rows = conn.execute(f"""SELECT e.*,s.title source_title,s.source_url,
          COALESCE(u.favorite,0) favorite,COALESCE(u.pinned,0) pinned,
          COALESCE(u.personal_note,'') personal_note,u.saved_entry_id
          FROM external_entries e JOIN external_sources s ON s.id=e.source_id
          LEFT JOIN external_user_data u ON u.source_id=e.source_id AND u.external_id=e.external_id
          WHERE {where} ORDER BY e.source_id,e.sort_order,e.title COLLATE NOCASE""", args).fetchall()
        entries = []
        total = len(rows)
        for index, row in enumerate(rows, 1):
            item = dict(row)
            item["favorite"] = bool(item["favorite"])
            item["pinned"] = bool(item["pinned"])
            try:
                item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            except json.JSONDecodeError:
                item["metadata"] = {}
            images = conn.execute("""SELECT image_index,thumb_path,width,height,cached_bytes
              FROM external_entry_images WHERE source_id=? AND external_id=? ORDER BY image_index LIMIT 1""",
              (item["source_id"], item["external_id"])).fetchall()
            item["images"] = []
            for image in images:
                thumbnail_data = _portable_data_url(image["thumb_path"])
                if not thumbnail_data:
                    continue
                item["images"].append({
                    "image_index": image["image_index"], "width": image["width"], "height": image["height"],
                    "cached_bytes": image["cached_bytes"], "thumbnail_data_url": thumbnail_data,
                })
            entries.append(item)
            if progress and (index == total or index % 20 == 0):
                progress(index, total)
    return sources, entries


def _mobile_item_hash(value: dict) -> str:
    data = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(data).hexdigest()


def _update_mobile_export_job(job_id: str, **values) -> None:
    with MOBILE_EXPORT_JOBS_LOCK:
        if job_id in MOBILE_EXPORT_JOBS:
            MOBILE_EXPORT_JOBS[job_id].update(values)


def _public_mobile_export_job(job: dict) -> dict:
    return {key: value for key, value in job.items() if key != "path"}


def _cleanup_mobile_export_files() -> None:
    MOBILE_EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    cutoff = time.time() - 24 * 60 * 60
    for candidate in MOBILE_EXPORT_DIR.glob("*.json"):
        try:
            if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                candidate.unlink()
        except OSError:
            pass


def _build_mobile_export_job(
    job_id: str,
    scope: str,
    mode: str,
    source_ids: list[str] | None,
    baseline_manifest: dict[str, str],
) -> None:
    target = MOBILE_EXPORT_DIR / f"{job_id}.json"
    temporary = target.with_suffix(".tmp")
    try:
        _cleanup_mobile_export_files()
        _update_mobile_export_job(job_id, status="running", phase="正在整理本地资料", processed=0, total=None)
        entries = _mobile_local_entries() if scope in {"local", "all"} else []

        def external_progress(current: int, total: int) -> None:
            _update_mobile_export_job(
                job_id, phase="正在读取外置资料和缩略图", processed=current, total=total,
            )

        if scope in {"external", "all"}:
            external_sources, external_entries = _mobile_external_data(source_ids, external_progress)
        else:
            external_sources, external_entries = [], []

        _update_mobile_export_job(
            job_id,
            phase="正在计算增量清单",
            processed=0,
            total=len(entries) + len(external_entries),
        )
        manifest = {f"local:{item['id']}": _mobile_item_hash(item) for item in entries}
        manifest.update({
            f"external:{item['source_id']}:{item['external_id']}": _mobile_item_hash(item)
            for item in external_entries
        })
        if mode == "incremental":
            entries = [
                item for item in entries
                if baseline_manifest.get(f"local:{item['id']}") != manifest[f"local:{item['id']}"]
            ]
            external_entries = [
                item for item in external_entries
                if baseline_manifest.get(f"external:{item['source_id']}:{item['external_id']}")
                != manifest[f"external:{item['source_id']}:{item['external_id']}"]
            ]

        payload = {
            "format": "nai-artist-library-mobile", "format_version": 2, "app_version": APP_VERSION,
            "exported_at": utc_now(), "scope": scope, "mode": mode, "manifest": manifest,
            "entries": entries, "external_sources": external_sources, "external_entries": external_entries,
        }
        _update_mobile_export_job(job_id, phase="正在写入资料包", processed=0, total=None)
        with temporary.open("w", encoding="utf-8", newline="") as output:
            json.dump(payload, output, ensure_ascii=False, separators=(",", ":"))
        os.replace(temporary, target)
        suffix = "增量" if mode == "incremental" else "完整"
        scope_label = {"local": "本地", "external": "外置", "all": "本地加外置"}[scope]
        if source_ids is not None and scope in {"external", "all"}:
            scope_label += f"-{len(source_ids)}库"
        filename = f"deanai便携资料-{scope_label}-{suffix}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
        _update_mobile_export_job(
            job_id,
            status="complete",
            phase="资料包已生成",
            processed=1,
            total=1,
            filename=filename,
            bytes=target.stat().st_size,
            local_count=len(entries),
            external_count=len(external_entries),
            source_count=len(source_ids) if source_ids is not None else len(external_sources),
            path=str(target),
        )
    except Exception as error:
        temporary.unlink(missing_ok=True)
        target.unlink(missing_ok=True)
        _update_mobile_export_job(job_id, status="failed", phase="导出失败", error=str(error))


@app.post("/api/export/mobile/jobs")
def start_mobile_export_job():
    payload = request.get_json(silent=True) or {}
    scope = str(payload.get("scope") or "local").strip().lower()
    mode = str(payload.get("mode") or "full").strip().lower()
    if scope not in {"local", "external", "all"} or mode not in {"full", "incremental"}:
        abort(400, "导出范围或模式无效")
    raw_source_ids = payload.get("source_ids")
    source_ids = None
    if raw_source_ids is not None:
        if not isinstance(raw_source_ids, list) or not all(isinstance(item, str) for item in raw_source_ids):
            abort(400, "外置资料源选择无效")
        source_ids = list(dict.fromkeys(item.strip() for item in raw_source_ids if item.strip()))
    if scope in {"external", "all"} and source_ids == []:
        abort(400, "请至少选择一个外置资料库")
    baseline_manifest = payload.get("manifest") or {}
    if not isinstance(baseline_manifest, dict):
        abort(400, "增量基线清单无效")
    job_id = uuid4().hex
    job = {
        "id": job_id, "status": "queued", "phase": "等待导出", "processed": 0,
        "total": None, "filename": None, "bytes": None, "error": "",
    }
    with MOBILE_EXPORT_JOBS_LOCK:
        MOBILE_EXPORT_JOBS[job_id] = job
    BACKGROUND_EXECUTOR.submit(
        _build_mobile_export_job, job_id, scope, mode, source_ids, baseline_manifest,
    )
    return jsonify(_public_mobile_export_job(job)), 202


@app.get("/api/export/mobile/jobs/<job_id>")
def mobile_export_job_status(job_id: str):
    with MOBILE_EXPORT_JOBS_LOCK:
        job = MOBILE_EXPORT_JOBS.get(job_id)
        if not job:
            abort(404, "导出任务不存在或程序已经重启")
        return jsonify(_public_mobile_export_job(dict(job)))


@app.get("/api/export/mobile/jobs/<job_id>/download")
def download_mobile_export_job(job_id: str):
    with MOBILE_EXPORT_JOBS_LOCK:
        job = dict(MOBILE_EXPORT_JOBS.get(job_id) or {})
    if not job:
        abort(404, "导出任务不存在或程序已经重启")
    if job.get("status") != "complete":
        abort(409, "资料包尚未生成完成")
    path = Path(str(job.get("path") or ""))
    if not path.is_file() or path.resolve().parent != MOBILE_EXPORT_DIR.resolve():
        abort(404, "导出文件已经失效，请重新导出")
    cleanup_timer = Timer(60 * 60, lambda: path.unlink(missing_ok=True))
    cleanup_timer.daemon = True
    cleanup_timer.start()
    return send_file(
        path,
        mimetype="application/json; charset=utf-8",
        as_attachment=True,
        download_name=str(job.get("filename") or "deanai便携资料.json"),
    )


@app.route("/api/export/mobile.json", methods=["GET", "POST"])
def export_mobile_library():
    """Portable package containing local cards and/or cached external data."""
    scope = request.args.get("scope", "local").strip().lower()
    mode = request.args.get("mode", "full").strip().lower()
    if scope not in {"local", "external", "all"} or mode not in {"full", "incremental"}:
        abort(400)
    baseline = request.get_json(silent=True) if request.method == "POST" else {}
    baseline_manifest = baseline.get("manifest", {}) if isinstance(baseline, dict) else {}
    if not isinstance(baseline_manifest, dict):
        baseline_manifest = {}

    entries = _mobile_local_entries() if scope in {"local", "all"} else []
    requested_sources = request.args.getlist("source") or None
    try:
        external_sources, external_entries = (
            _mobile_external_data(requested_sources) if scope in {"external", "all"} else ([], [])
        )
    except ValueError as error:
        abort(400, str(error))
    manifest = {f"local:{item['id']}": _mobile_item_hash(item) for item in entries}
    manifest.update({f"external:{item['source_id']}:{item['external_id']}": _mobile_item_hash(item) for item in external_entries})
    if mode == "incremental":
        entries = [item for item in entries if baseline_manifest.get(f"local:{item['id']}") != manifest[f"local:{item['id']}"]]
        external_entries = [item for item in external_entries
                            if baseline_manifest.get(f"external:{item['source_id']}:{item['external_id']}")
                            != manifest[f"external:{item['source_id']}:{item['external_id']}"]]

    payload = {
        "format": "nai-artist-library-mobile", "format_version": 2, "app_version": APP_VERSION,
        "exported_at": utc_now(), "scope": scope, "mode": mode, "manifest": manifest,
        "entries": entries, "external_sources": external_sources, "external_entries": external_entries,
    }
    data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    suffix = "增量" if mode == "incremental" else "完整"
    scope_label = {"local": "本地", "external": "外置", "all": "本地加外置"}[scope]
    if requested_sources and scope in {"external", "all"}:
        scope_label += f"-{len(requested_sources)}库"
    filename = f"deanai便携资料-{scope_label}-{suffix}-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    return send_file(io.BytesIO(data), mimetype="application/json; charset=utf-8", as_attachment=True, download_name=filename)

@app.get("/api/export/artists.csv")
def export_artists_csv():
    output = io.StringIO(newline="")
    writer = csv.writer(output)
    writer.writerow(["名称", "评分（满分5）", "风格", "目录", "收藏", "画师串/内容", "负面提示词", "图片数量"])
    with connect() as conn:
        rows = conn.execute(
            """
            SELECT entries.*,
                   (SELECT COUNT(*) FROM entry_images WHERE entry_images.entry_id = entries.id) AS image_count
            FROM entries WHERE kind = 'artist'
            ORDER BY rating IS NULL, rating DESC, title COLLATE ZH_PINYIN
            """
        ).fetchall()
    for row in rows:
        writer.writerow([
            row["title"], row["rating"] / 2 if row["rating"] else "未评分", row["style"], row["category"],
            "是" if row["favorite"] else "否", row["content"], row["negative_prompt"],
            row["image_count"],
        ])
    data = ("\ufeff" + output.getvalue()).encode("utf-8")
    filename = f"画师串评分表-{datetime.now().strftime('%Y%m%d-%H%M%S')}.csv"
    return send_file(io.BytesIO(data), mimetype="text/csv; charset=utf-8", as_attachment=True, download_name=filename)


@app.post("/api/backups")
def create_backup():
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    archive_path = BACKUP_DIR / f"nai资料库备份-{stamp}.zip"
    snapshot_path = BACKUP_DIR / f".library-{stamp}.db"
    source = sqlite3.connect(DATA_DIR / "library.db")
    target = sqlite3.connect(snapshot_path)
    try:
        source.backup(target)
    finally:
        target.close()
        source.close()

    manifest = {
        "format": "nai-artist-library-backup",
        "format_version": 1,
        "app_version": APP_VERSION,
        "created_at": utc_now(),
        "media_dir": str(ORIGINALS_DIR),
    }
    try:
        with zipfile.ZipFile(archive_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.write(snapshot_path, "data/library.db")
            archive.writestr("manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
            for base, prefix in ((ORIGINALS_DIR, "data/media"), (DATA_DIR / "thumbs", "data/thumbs")):
                if base.exists():
                    for path in sorted(base.rglob("*")):
                        if path.is_file():
                            archive.write(path, f"{prefix}/{path.relative_to(base).as_posix()}")
            with connect() as conn:
                external = conn.execute(
                    "SELECT id, external_path FROM assets WHERE external_path IS NOT NULL ORDER BY id"
                ).fetchall()
            for row in external:
                path = Path(row["external_path"])
                if path.is_file() and ORIGINALS_DIR.resolve() not in path.resolve().parents:
                    archive.write(path, f"外部原图/{row['id']}-{path.name}")
    finally:
        snapshot_path.unlink(missing_ok=True)
    return jsonify({"filename": archive_path.name, "path": str(archive_path), "size": archive_path.stat().st_size})


def entry_filters(args):
    kind = args.get("kind", "artist")
    if kind not in ("artist", "prompt"):
        abort(400, "无效资料库类型")
    query = (args.get("q") or "").strip()
    search_scope = (args.get("search_scope") or "directory").strip()
    search_field = (args.get("search_field") or "all").strip()
    if search_field not in ("all", "title", "content", "negative", "tags", "path"):
        search_field = "all"
    global_search = bool(query and search_scope == "all")
    category = (args.get("category") or "").strip()
    category_prefixes = []
    for raw_prefix in args.getlist("category_prefix"):
        prefix = str(raw_prefix or "").strip().strip("/")
        if prefix and prefix not in category_prefixes:
            category_prefixes.append(prefix)
    rating_min = args.get("rating_min", type=int)
    exact_ratings = list(dict.fromkeys(value.strip() for value in (args.get("ratings") or "").split(",") if value.strip()))
    if any(value not in {str(n) for n in range(1, 11)} | {"unrated"} for value in exact_ratings):
        abort(400, "评分选项无效")
    rating_max = args.get("rating_max", type=int)
    unrated_only = args.get("unrated_only") == "1"
    include_unrated = args.get("include_unrated") == "1"
    style = (args.get("style") or "").strip()
    style_unclassified = args.get("style_unclassified") == "1"
    favorites_only = args.get("favorites_only") == "1"
    group_id = args.get("group_id", type=int)
    image_filter = (args.get("image_filter") or "").strip()
    include_image_ids = []
    for value in (args.get("image_filter_include_ids") or "").split(","):
        if value.strip().isdigit():
            include_image_ids.append(int(value.strip()))
    include_image_ids = sorted(set(include_image_ids))[:1000]
    negative_only = args.get("negative_only") == "1"

    where = ["kind = ?"]
    params: list = [kind]
    if query:
        needle = f"%{query}%"
        search_columns = {
            "title": ["title"],
            "content": ["content"],
            "negative": ["negative_prompt"],
            "tags": ["tags"],
            "path": ["category"],
            "all": ["title", "content", "negative_prompt", "tags", "category", "style"],
        }[search_field]
        if search_scope != "all" and search_field == "all":
            search_columns = ["title", "content", "negative_prompt", "tags"]
        where.append("(" + " OR ".join(f"{column} LIKE ?" for column in search_columns) + ")")
        params.extend([needle] * len(search_columns))
    if not global_search and category:
        where.append("category = ?")
        params.append(category)
    elif not global_search and category_prefixes:
        clauses = []
        for prefix in category_prefixes:
            clauses.append("(category = ? OR category LIKE ?)")
            params.extend([prefix, f"{prefix}/%"])
        where.append("(" + " OR ".join(clauses) + ")")
    if exact_ratings:
        numbers = [int(value) for value in exact_ratings if value != "unrated"]
        clauses = ["rating IN (" + ",".join("?" for _ in numbers) + ")"] if numbers else []
        params.extend(numbers)
        if "unrated" in exact_ratings:
            clauses.append("rating IS NULL")
        where.append("(" + " OR ".join(clauses) + ")")
    elif unrated_only:
        where.append("rating IS NULL")
    elif rating_min is not None:
        where.append("(rating >= ? OR rating IS NULL)" if include_unrated else "rating >= ?")
        params.append(rating_min)
    if not exact_ratings and not unrated_only and rating_max is not None:
        where.append("rating <= ?")
        params.append(rating_max)
    if kind == "artist" and style_unclassified:
        where.append("TRIM(style) = ''")
    elif kind == "artist" and style:
        where.append("style = ?")
        params.append(style)
    if favorites_only:
        where.append("favorite = 1")
    if group_id is not None and not global_search:
        where.append("EXISTS (SELECT 1 FROM entry_groups WHERE entry_groups.entry_id = entries.id AND entry_groups.group_id = ?)")
        params.append(group_id)
    if image_filter == "with":
        where.append("EXISTS (SELECT 1 FROM entry_images WHERE entry_images.entry_id = entries.id)")
    elif image_filter == "without":
        if include_image_ids:
            placeholders = ",".join("?" for _ in include_image_ids)
            where.append(f"(NOT EXISTS (SELECT 1 FROM entry_images WHERE entry_images.entry_id = entries.id) OR entries.id IN ({placeholders}))")
            params.extend(include_image_ids)
        else:
            where.append("NOT EXISTS (SELECT 1 FROM entry_images WHERE entry_images.entry_id = entries.id)")
    if negative_only:
        where.append("category = '负面提示词'")
    return kind, " AND ".join(where), params


@app.get("/api/entries")
def list_entries():
    kind, where_sql, params = entry_filters(request.args)
    sort = request.args.get("sort", "rating_desc")
    limit = min(max(request.args.get("limit", 200, type=int), 1), 1000)
    offset = max(request.args.get("offset", 0, type=int), 0)

    orders = {
        "rating_desc": "pinned DESC, rating IS NULL, rating DESC, title COLLATE ZH_PINYIN ASC",
        "rating_asc": "pinned DESC, rating IS NULL, rating ASC, title COLLATE ZH_PINYIN ASC",
        "newest": "pinned DESC, updated_at DESC, title COLLATE ZH_PINYIN ASC",
        "created_desc": "pinned DESC, created_at DESC, id DESC",
        "title": "pinned DESC, title COLLATE ZH_PINYIN ASC",
        "manual": "manual_order <= 0, manual_order ASC, id ASC",
        "usage_desc": (
            "usage_count DESC, last_used_at IS NULL, last_used_at DESC, rating IS NULL, rating DESC, title COLLATE ZH_PINYIN ASC"
            if kind == "artist"
            else "usage_count DESC, last_used_at IS NULL, last_used_at DESC, updated_at DESC, title COLLATE ZH_PINYIN ASC"
        ),
    }
    order = orders.get(sort, orders["rating_desc"])
    with connect() as conn:
        total = conn.execute(f"SELECT COUNT(*) FROM entries WHERE {where_sql}", params).fetchone()[0]
        rows = conn.execute(
            f"SELECT * FROM entries WHERE {where_sql} ORDER BY {order} LIMIT ? OFFSET ?",
            [*params, limit, offset],
        ).fetchall()
        entries = entries_with_relations(conn, rows)
    query = (request.args.get("q") or "").strip().casefold()
    search_field = (request.args.get("search_field") or "all").strip()
    if query:
        field_values = {
            "title": ("title",),
            "content": ("content",),
            "negative": ("negative_prompt",),
            "tags": ("tags",),
            "path": ("category",),
            "all": ("title", "content", "negative_prompt", "tags", "category", "style"),
        }
        enabled = field_values.get(search_field, field_values["all"])
        if request.args.get("search_scope") != "all" and search_field == "all":
            enabled = ("title", "content", "negative_prompt", "tags")
        for entry in entries:
            entry["search_matches"] = [
                field for field in enabled
                if query in (json.dumps(entry.get(field), ensure_ascii=False) if field == "tags" else str(entry.get(field) or "")).casefold()
            ]
    return jsonify({"entries": entries, "total": total})


@app.get("/api/entries/random-scene")
def random_scene_entry():
    with connect() as conn:
        row = conn.execute("SELECT * FROM entries WHERE kind = 'prompt' ORDER BY RANDOM() LIMIT 1").fetchone()
        if not row:
            abort(404, "场景提示词库为空")
        entry = entries_with_relations(conn, [row])[0]
    return jsonify(entry)


@app.get("/api/entries/random")
def random_library_entry():
    kind, where_sql, params = entry_filters(request.args)
    weighting = (request.args.get("weighting") or "uniform").strip()
    if weighting not in ("uniform", "rating", "usage", "rating_usage", "custom"):
        abort(400, "无效的随机权重")
    custom_rating = min(max(request.args.get("rating_weight", 1.0, type=float), 0.0), 10.0)
    custom_usage = min(max(request.args.get("usage_weight", 1.0, type=float), 0.0), 10.0)
    exclude_ids = []
    for value in (request.args.get("exclude_ids") or "").split(","):
        if value.strip().isdigit():
            exclude_ids.append(int(value.strip()))
    exclude_ids = sorted(set(exclude_ids))[:100]

    def load_candidates(conn, excluded):
        sql = f"SELECT * FROM entries WHERE {where_sql}"
        values = list(params)
        if excluded:
            placeholders = ",".join("?" for _ in excluded)
            sql += f" AND id NOT IN ({placeholders})"
            values.extend(excluded)
        return conn.execute(sql + " LIMIT 20000", values).fetchall()

    with connect() as conn:
        rows = load_candidates(conn, exclude_ids)
        if not rows and exclude_ids:
            rows = load_candidates(conn, [])
        if not rows:
            abort(404, "当前随机范围内没有资料卡")
        weights = []
        max_usage = max(float(row["usage_count"] or 0) for row in rows)
        for row in rows:
            rating_weight = max(1.0, float(row["rating"] or 0) + 1.0)
            usage_weight = max(1.0, float(row["usage_count"] or 0) + 1.0)
            if weighting == "rating":
                weight = rating_weight
            elif weighting == "usage":
                weight = usage_weight
            elif weighting == "rating_usage":
                weight = rating_weight * (usage_weight ** 0.5)
            elif weighting == "custom":
                rating_score = float(row["rating"] or 0) / 10.0
                usage_score = math.log1p(float(row["usage_count"] or 0)) / math.log1p(max_usage) if max_usage > 0 else 0.0
                weight = max(0.001, custom_rating * rating_score + custom_usage * usage_score)
            else:
                weight = 1.0
            weights.append(weight)
        row = random.choices(rows, weights=weights, k=1)[0]
        entry = entries_with_relations(conn, [row])[0]
    return jsonify(entry)


@app.put("/api/entries/order")
def reorder_entries():
    payload = request.get_json(force=True) or {}
    kind = payload.get("kind")
    if kind not in ("artist", "prompt"):
        abort(400, "无效资料库类型")
    raw_ids = payload.get("entry_ids") or []
    if not isinstance(raw_ids, list):
        abort(400, "排序条目格式错误")
    ordered_ids = []
    for value in raw_ids:
        try:
            entry_id = int(value)
        except (TypeError, ValueError):
            abort(400, "排序条目格式错误")
        if entry_id not in ordered_ids:
            ordered_ids.append(entry_id)
    if len(ordered_ids) < 2:
        return jsonify({"updated": 0})

    with connect() as conn:
        rows = conn.execute(
            "SELECT id FROM entries WHERE kind = ? ORDER BY manual_order <= 0, manual_order, id",
            (kind,),
        ).fetchall()
        all_ids = [row["id"] for row in rows]
        known = set(all_ids)
        if any(entry_id not in known for entry_id in ordered_ids):
            abort(400, "排序中包含其他资料库的条目")
        visible = set(ordered_ids)
        slots = [index for index, entry_id in enumerate(all_ids) if entry_id in visible]
        if len(slots) != len(ordered_ids):
            abort(400, "排序条目不完整")
        for index, entry_id in zip(slots, ordered_ids):
            all_ids[index] = entry_id
        conn.executemany(
            "UPDATE entries SET manual_order = ? WHERE id = ?",
            [(index + 1, entry_id) for index, entry_id in enumerate(all_ids)],
        )
    return jsonify({"updated": len(ordered_ids)})


@app.post("/api/entries/<int:entry_id>/use")
def record_entry_use(entry_id: int):
    now = utc_now()
    with connect() as conn:
        cursor = conn.execute(
            "UPDATE entries SET usage_count = usage_count + 1, last_used_at = ? WHERE id = ?",
            (now, entry_id),
        )
        if cursor.rowcount == 0:
            abort(404)
        row = conn.execute("SELECT usage_count, last_used_at FROM entries WHERE id = ?", (entry_id,)).fetchone()
    return jsonify({"usage_count": row["usage_count"], "last_used_at": row["last_used_at"]})


@app.get("/api/entries/ids")
def list_entry_ids():
    _, where_sql, params = entry_filters(request.args)
    with connect() as conn:
        rows = conn.execute(f"SELECT id FROM entries WHERE {where_sql} ORDER BY id", params).fetchall()
    return jsonify({"ids": [row["id"] for row in rows], "total": len(rows)})


@app.get("/api/entries/<int:entry_id>")
def get_entry(entry_id: int):
    with connect() as conn:
        row = conn.execute("SELECT * FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not row:
            abort(404)
        entry = entries_with_relations(conn, [row])[0]
    return jsonify(entry)


def clean_payload(payload: dict, partial: bool = False) -> dict:
    result = {}
    if "kind" in payload or not partial:
        kind = payload.get("kind", "artist")
        if kind not in ("artist", "prompt"):
            abort(400, "无效资料库类型")
        result["kind"] = kind
    for field in ("title", "content", "negative_prompt", "category", "style"):
        if field in payload or not partial:
            default = "未分类" if field == "category" else ""
            result[field] = str(payload.get(field, default)).strip()
    if "title" in result and not result["title"]:
        abort(400, "标题不能为空")
    if "rating" in payload or not partial:
        rating = payload.get("rating")
        if rating in (None, ""):
            result["rating"] = None
        else:
            try:
                rating = int(rating)
            except (TypeError, ValueError):
                abort(400, "评分必须是 1–10 的整数")
            if not 1 <= rating <= 10:
                abort(400, "评分必须在 0.5–5★ 之间")
            result["rating"] = rating
    if "tags" in payload or not partial:
        tags = payload.get("tags", [])
        if isinstance(tags, str):
            tags = [part.strip() for part in tags.split(",") if part.strip()]
        if not isinstance(tags, list):
            abort(400, "标签格式错误")
        result["tags"] = json.dumps([str(tag).strip() for tag in tags if str(tag).strip()], ensure_ascii=False)
    if "favorite" in payload:
        result["favorite"] = 1 if payload.get("favorite") else 0
    if "pinned" in payload:
        result["pinned"] = 1 if payload.get("pinned") else 0
    return result


@app.post("/api/entries")
def create_entry():
    payload = request.get_json(force=True) or {}
    data = clean_payload(payload)
    raw_group_ids = payload.get("group_ids", [])
    if not isinstance(raw_group_ids, list):
        abort(400, "分组列表格式错误")
    try:
        group_ids = sorted({int(value) for value in raw_group_ids})
    except (TypeError, ValueError):
        abort(400, "分组编号无效")
    now = utc_now()
    columns = [*data.keys(), "created_at", "updated_at"]
    values = [*data.values(), now, now]
    with connect() as conn:
        cursor = conn.execute(
            f"INSERT INTO entries ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
            values,
        )
        entry_id = cursor.lastrowid
        if group_ids:
            placeholders = ",".join("?" for _ in group_ids)
            valid = conn.execute(
                f"SELECT id FROM custom_groups WHERE kind = ? AND id IN ({placeholders})",
                [data["kind"], *group_ids],
            ).fetchall()
            if len(valid) != len(group_ids):
                abort(400, "包含不属于当前资料库的分组")
            conn.executemany(
                "INSERT INTO entry_groups (entry_id, group_id) VALUES (?, ?)",
                [(entry_id, group_id) for group_id in group_ids],
            )
        if data["kind"] == "artist":
            place_artist_in_manual_rating_group(conn, entry_id, data.get("rating"))
    return jsonify({"id": entry_id}), 201


@app.put("/api/entries/<int:entry_id>")
def update_entry(entry_id: int):
    data = clean_payload(request.get_json(force=True) or {}, partial=True)
    if not data:
        return jsonify({"id": entry_id})
    data["updated_at"] = utc_now()
    assignments = ", ".join(f"{field} = ?" for field in data)
    with connect() as conn:
        previous = conn.execute(
            "SELECT kind, rating, manual_order FROM entries WHERE id = ?",
            (entry_id,),
        ).fetchone()
        if not previous:
            abort(404)
        conn.execute(f"UPDATE entries SET {assignments} WHERE id = ?", [*data.values(), entry_id])
        final_kind = data.get("kind", previous["kind"])
        final_rating = data.get("rating", previous["rating"])
        manual_order = None
        if final_kind != previous["kind"]:
            previous_order = int(previous["manual_order"] or 0)
            if previous_order > 0:
                conn.execute(
                    """UPDATE entries SET manual_order = manual_order - 1
                       WHERE kind = ? AND id != ? AND manual_order > ?""",
                    (previous["kind"], entry_id, previous_order),
                )
            conn.execute("UPDATE entries SET manual_order = 0 WHERE id = ?", (entry_id,))
            if final_kind == "artist":
                manual_order = place_artist_in_manual_rating_group(conn, entry_id, final_rating)
            else:
                manual_order = int(conn.execute(
                    "SELECT COALESCE(MAX(manual_order), 0) + 1 FROM entries WHERE kind = ? AND id != ?",
                    (final_kind, entry_id),
                ).fetchone()[0])
                conn.execute("UPDATE entries SET manual_order = ? WHERE id = ?", (manual_order, entry_id))
        elif final_kind == "artist" and "rating" in data and final_rating != previous["rating"]:
            manual_order = move_artist_to_manual_rating_group(conn, entry_id, final_rating)
    return jsonify({"id": entry_id, "manual_order": manual_order})


@app.put("/api/entries/<int:entry_id>/manual-order")
def set_entry_manual_order(entry_id: int):
    payload = request.get_json(force=True) or {}
    try:
        position = int(payload.get("position"))
    except (TypeError, ValueError):
        abort(400, "自定义排序 ID 必须是正整数")
    if position < 1:
        abort(400, "自定义排序 ID 必须是正整数")
    with connect() as conn:
        actual, total = move_entry_to_manual_position(conn, entry_id, position)
        if not actual:
            abort(404)
    return jsonify({"id": entry_id, "manual_order": actual, "total": total})


@app.delete("/api/entries/<int:entry_id>")
def delete_entry(entry_id: int):
    with connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        asset_ids = [row[0] for row in conn.execute('SELECT asset_id FROM entry_images WHERE entry_id=?', (entry_id,))]
        cursor = conn.execute("DELETE FROM entries WHERE id = ?", (entry_id,))
        if cursor.rowcount == 0:
            abort(404)
        database_path = enqueue_cleanup(conn, asset_ids)
    cleanup = schedule_media_cleanup(database_path, len(asset_ids))
    return jsonify({'deleted': 1, 'cleanup': cleanup})


@app.post("/api/entries/batch-delete")
def batch_delete_entries():
    raw_ids = (request.get_json(force=True) or {}).get("ids", [])
    if not isinstance(raw_ids, list):
        abort(400, "资料编号列表格式错误")
    try:
        entry_ids = sorted({int(value) for value in raw_ids})
    except (TypeError, ValueError):
        abort(400, "资料编号无效")
    if not entry_ids:
        abort(400, "请至少选择一条资料")
    if len(entry_ids) > 50000:
        abort(400, "一次最多删除 50000 条资料")
    placeholders = ",".join("?" for _ in entry_ids)
    with connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        asset_ids = [row[0] for row in conn.execute(f'SELECT DISTINCT asset_id FROM entry_images WHERE entry_id IN ({placeholders})', entry_ids)]
        cursor = conn.execute(f"DELETE FROM entries WHERE id IN ({placeholders})", entry_ids)
        database_path = enqueue_cleanup(conn, asset_ids)
    cleanup = schedule_media_cleanup(database_path, len(asset_ids))
    return jsonify({'requested': len(entry_ids), 'deleted': cursor.rowcount, 'cleanup': cleanup})


ALLOWED_IMAGE_SUFFIXES = {".png", ".jpg", ".jpeg", ".webp", ".gif"}


@app.post("/api/entries/<int:entry_id>/images")
def upload_images(entry_id: int):
    files = request.files.getlist("images")
    if not files:
        abort(400, "请选择至少一张图片")
    thumbs_dir = DATA_DIR / "thumbs" / "uploads"
    thumbs_dir.mkdir(parents=True, exist_ok=True)
    added = 0
    reused = 0
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM entries WHERE id = ?", (entry_id,)).fetchone():
            abort(404)
        entry = conn.execute("SELECT kind, category, title FROM entries WHERE id = ?", (entry_id,)).fetchone()
        uploads_dir = entry_media_dir(entry["kind"], entry["category"], entry["title"])
        uploads_dir.mkdir(parents=True, exist_ok=True)
        next_order = conn.execute(
            "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM entry_images WHERE entry_id = ?", (entry_id,)
        ).fetchone()[0]
        for uploaded in files:
            suffix = Path(uploaded.filename or "").suffix.lower()
            if suffix not in ALLOWED_IMAGE_SUFFIXES:
                continue
            payload = uploaded.read()
            if not payload:
                continue
            digest = hashlib.sha256(payload).hexdigest()
            asset = conn.execute("SELECT id FROM assets WHERE sha256 = ?", (digest,)).fetchone()
            if asset:
                asset_id = asset["id"]
                reused += 1
            else:
                image_path = uploads_dir / f"{digest}{suffix}"
                thumb_path = thumbs_dir / f"{digest}.jpg"
                image_path.write_bytes(payload)
                try:
                    embedded_metadata = extract_image_metadata(image_path)
                    with Image.open(io.BytesIO(payload)) as image:
                        image = ImageOps.exif_transpose(image)
                        width, height = image.size
                        image = image.convert("RGB")
                        image.thumbnail((720, 720), Image.Resampling.LANCZOS)
                        image.save(thumb_path, "JPEG", quality=84, optimize=True)
                except Exception:
                    image_path.unlink(missing_ok=True)
                    continue
                asset_id = conn.execute(
                    """
                    INSERT INTO assets
                        (path, thumbnail_path, sha256, metadata_json, width, height, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        image_path.relative_to(DATA_DIR).as_posix(),
                        thumb_path.relative_to(DATA_DIR).as_posix(),
                        digest,
                        json.dumps(embedded_metadata, ensure_ascii=False),
                        width,
                        height,
                        utc_now(),
                    ),
                ).lastrowid
            before = conn.total_changes
            conn.execute(
                "INSERT OR IGNORE INTO entry_images (entry_id, asset_id, sort_order) VALUES (?, ?, ?)",
                (entry_id, asset_id, next_order),
            )
            if conn.total_changes > before:
                added += 1
                next_order += 1
    return jsonify({"added": added, "reused": reused})


@app.post("/api/entries/<int:entry_id>/link-folder")
def link_folder(entry_id: int):
    payload = request.get_json(force=True) or {}
    raw_path = str(payload.get("path") or "").strip().strip('"')
    folder = Path(raw_path).expanduser()
    if not folder.is_absolute():
        folder = ORIGINALS_DIR / folder
    folder = folder.resolve()
    if not folder.is_dir():
        abort(400, "本地文件夹不存在或无法读取")
    recursive = bool(payload.get("recursive", True))
    with connect() as conn:
        if not conn.execute("SELECT 1 FROM entries WHERE id = ?", (entry_id,)).fetchone():
            abort(404)
    job_id = uuid4().hex
    with BACKGROUND_JOBS_LOCK:
        BACKGROUND_JOBS[job_id] = {
            "id": job_id, "status": "queued", "phase": "等待扫描", "processed": 0,
            "total": None, "entry_id": entry_id, "folder": str(folder), "result": None,
        }
    BACKGROUND_EXECUTOR.submit(scan_folder_job, job_id, entry_id, folder, recursive)
    return jsonify(BACKGROUND_JOBS[job_id]), 202


def update_background_job(job_id: str, **values) -> None:
    with BACKGROUND_JOBS_LOCK:
        if job_id in BACKGROUND_JOBS:
            BACKGROUND_JOBS[job_id].update(values)


def scan_folder_job(job_id: str, entry_id: int, folder: Path, recursive: bool) -> None:
    try:
        update_background_job(job_id, status="running", phase="正在扫描文件")
        iterator = folder.rglob("*") if recursive else folder.iterdir()
        files = sorted(path for path in iterator if path.is_file() and path.suffix.lower() in ALLOWED_IMAGE_SUFFIXES)
        if not files:
            raise ValueError("文件夹中没有支持的图片")
        if len(files) > 5000:
            raise ValueError("一次最多关联 5000 张图片，请拆分文件夹")
        update_background_job(job_id, phase="正在生成缩略图", total=len(files))

        thumb_dir = DATA_DIR / "thumbs" / "external"
        thumb_dir.mkdir(parents=True, exist_ok=True)
        added = reused = failed = 0
        with connect() as conn:
            if not conn.execute("SELECT 1 FROM entries WHERE id = ?", (entry_id,)).fetchone():
                raise ValueError("资料已不存在")
            next_order = conn.execute(
                "SELECT COALESCE(MAX(sort_order), -1) + 1 FROM entry_images WHERE entry_id = ?", (entry_id,)
            ).fetchone()[0]
            for index, source in enumerate(files, 1):
                try:
                    digest_hash = hashlib.sha256()
                    with source.open("rb") as stream:
                        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                            digest_hash.update(chunk)
                    digest = digest_hash.hexdigest()
                    asset = conn.execute("SELECT id FROM assets WHERE sha256 = ?", (digest,)).fetchone()
                    if asset:
                        asset_id = asset["id"]
                        reused += 1
                    else:
                        thumb_path = thumb_dir / f"{digest}.jpg"
                        embedded_metadata = extract_image_metadata(source)
                        with Image.open(source) as image:
                            image = ImageOps.exif_transpose(image)
                            width, height = image.size
                            image = image.convert("RGB")
                            image.thumbnail((720, 720), Image.Resampling.LANCZOS)
                            image.save(thumb_path, "JPEG", quality=84, optimize=True)
                        asset_id = conn.execute(
                            """
                            INSERT INTO assets
                                (path, thumbnail_path, sha256, metadata_json, external_path, width, height, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                            """,
                            (
                                f"external/{digest}{source.suffix.lower()}",
                                thumb_path.relative_to(DATA_DIR).as_posix(), digest,
                                json.dumps(embedded_metadata, ensure_ascii=False),
                                str(source), width, height, utc_now(),
                            ),
                        ).lastrowid
                    before = conn.total_changes
                    conn.execute(
                        "INSERT OR IGNORE INTO entry_images (entry_id, asset_id, sort_order) VALUES (?, ?, ?)",
                        (entry_id, asset_id, next_order),
                    )
                    if conn.total_changes > before:
                        added += 1
                        next_order += 1
                except (OSError, ValueError):
                    failed += 1
                if index % 5 == 0 or index == len(files):
                    update_background_job(job_id, processed=index)
        result = {"found": len(files), "added": added, "reused": reused, "failed": failed, "folder": str(folder)}
        update_background_job(job_id, status="completed", phase="完成", processed=len(files), result=result)
    except Exception as error:
        update_background_job(job_id, status="failed", phase="失败", error=str(error))


@app.get("/api/jobs/<job_id>")
def background_job(job_id: str):
    with BACKGROUND_JOBS_LOCK:
        job = BACKGROUND_JOBS.get(job_id)
        if not job:
            abort(404, "后台任务不存在或程序已重启")
        return jsonify(dict(job))


@app.delete("/api/entries/<int:entry_id>/images/<int:asset_id>")
def unlink_image(entry_id: int, asset_id: int):
    with connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        cursor = conn.execute(
            "DELETE FROM entry_images WHERE entry_id = ? AND asset_id = ?", (entry_id, asset_id)
        )
        if cursor.rowcount == 0:
            abort(404)
        conn.execute('DELETE FROM images WHERE entry_id=? AND sha256=(SELECT sha256 FROM assets WHERE id=?)', (entry_id, asset_id))
        database_path = enqueue_cleanup(conn, [asset_id])
    cleanup = schedule_media_cleanup(database_path, 1)
    return jsonify({'removed': True, 'cleanup': cleanup})


def schedule_media_cleanup(database_path, count):
    if not count:
        return {'removed_files': 0, 'removed_bytes': 0, 'errors': []}
    job_id = uuid4().hex
    with BACKGROUND_JOBS_LOCK:
        # Keep completed automatic-cleanup status bounded.
        finished = [key for key, job in BACKGROUND_JOBS.items() if job.get('operation') == 'detached-cleanup' and job.get('status') in {'completed', 'failed'}]
        for key in finished[:-32]:
            BACKGROUND_JOBS.pop(key, None)
        BACKGROUND_JOBS[job_id] = {'id': job_id, 'operation': 'detached-cleanup', 'status': 'queued', 'processed': 0}
    def work():
        try:
            update_background_job(job_id, status='running')
            result = drain_cleanup(database_path, lambda processed: update_background_job(job_id, processed=processed))
            update_background_job(job_id, status='completed', result=result)
        except Exception as error:
            update_background_job(job_id, status='failed', error=str(error))
    MEDIA_DELETE_EXECUTOR.submit(work)
    return {'queued': True, 'job_id': job_id, 'assets': count}


@app.before_request
def resume_pending_media_cleanup():
    # One cheap check per database/process. A crash after committing card deletion
    # cannot lose the queued file cleanup.
    with connect() as conn:
        database_path = Path(conn.execute('PRAGMA database_list').fetchone()[2]).resolve()
        with BACKGROUND_JOBS_LOCK:
            if database_path in MEDIA_QUEUE_CHECKED:
                return
            MEDIA_QUEUE_CHECKED.add(database_path)
        count = conn.execute('SELECT COUNT(*) FROM media_cleanup_queue WHERE error IS NULL').fetchone()[0]
    if count:
        schedule_media_cleanup(database_path, count)


@app.post('/api/library-maintenance/jobs')
def start_library_maintenance():
    payload = request.get_json(force=True) or {}
    operation = payload.get('operation')
    if operation not in {'audit', 'preview', 'cleanup'}:
        abort(400, '检查操作无效')
    if not MAINTENANCE_LOCK.acquire(blocking=False):
        abort(409, '已有资料库检查或清理正在运行')
    try:
        plan = None
        if operation == 'cleanup':
            saved = MEDIA_CLEANUP_PREVIEWS.pop(str(payload.get('token') or ''), None)
            if not saved or time.time() - saved[0] > 1800:
                abort(409, '清理预览已过期，请重新检查')
            plan = saved[1]
        with connect() as conn:
            database_path = media_data_root(conn) / Path(conn.execute('PRAGMA database_list').fetchone()[2]).name
        job_id = uuid4().hex
        with BACKGROUND_JOBS_LOCK:
            BACKGROUND_JOBS[job_id] = {'id': job_id, 'status': 'queued', 'phase': '等待处理', 'processed': 0, 'total': None}
        BACKGROUND_EXECUTOR.submit(run_library_maintenance, job_id, database_path, operation, payload, plan)
    except Exception:
        MAINTENANCE_LOCK.release()
        raise
    return jsonify({'id': job_id}), 202


def run_library_maintenance(job_id, database_path, operation, payload, plan):
    try:
        update_background_job(job_id, status='running', phase='正在检查图片' if operation == 'audit' else '正在核对无引用副本')
        if operation == 'audit':
            _, _, report = audit_library(database_path, deep=bool(payload.get('deep')), full=bool(payload.get('full')),
                progress=lambda current, total: update_background_job(job_id, processed=current, total=total))
            result = {'operation': operation, 'report': report, 'markdown': markdown_report(report)}
        else:
            with maintenance_connect(database_path) as conn:
                conn.execute('BEGIN IMMEDIATE')
                if operation == 'preview':
                    plan = unused_plan(conn, loose=True)
                    plan['loose'] = True
                    token = uuid4().hex
                    MEDIA_CLEANUP_PREVIEWS.clear()
                    MEDIA_CLEANUP_PREVIEWS[token] = (time.time(), plan)
                    result = {'operation': operation, 'token': token, 'assets': len(plan['asset_ids']),
                              'files': len(plan['files']), 'bytes': plan['bytes'], 'external_kept': plan['external_kept'],
                              'examples': list(plan['files'])[:100]}
                else:
                    result = {'operation': operation, **clean_unused(conn, plan)}
        update_background_job(job_id, status='completed', phase='完成', result=result)
    except Exception as error:
        update_background_job(job_id, status='failed', phase='失败', error=str(error))
    finally:
        MAINTENANCE_LOCK.release()


@app.put("/api/entries/<int:entry_id>/images/cover")
def set_cover_image(entry_id: int):
    try:
        asset_id = int((request.get_json(force=True) or {}).get("asset_id"))
    except (TypeError, ValueError):
        abort(400, "图片编号无效")
    with connect() as conn:
        rows = conn.execute(
            "SELECT asset_id FROM entry_images WHERE entry_id = ? ORDER BY sort_order, asset_id",
            (entry_id,),
        ).fetchall()
        ordered_ids = [row["asset_id"] for row in rows]
        if asset_id not in ordered_ids:
            abort(404, "这张图片不属于当前资料")
        ordered_ids = [asset_id, *(value for value in ordered_ids if value != asset_id)]
        conn.executemany(
            "UPDATE entry_images SET sort_order = ? WHERE entry_id = ? AND asset_id = ?",
            [(index, entry_id, value) for index, value in enumerate(ordered_ids)],
        )
    return jsonify({"entry_id": entry_id, "cover_asset_id": asset_id})


def normalized_category_path(value: str) -> str:
    return "/".join(part.strip() for part in str(value).replace("\\", "/").split("/") if part.strip())


@app.post("/api/entries/batch-move")
def batch_move_entries():
    payload = request.get_json(force=True) or {}
    raw_ids = payload.get("ids", [])
    if not isinstance(raw_ids, list):
        abort(400, "资料编号列表格式错误")
    try:
        entry_ids = sorted({int(value) for value in raw_ids})
    except (TypeError, ValueError):
        abort(400, "资料编号无效")
    if not entry_ids:
        abort(400, "请至少选择一条资料")
    if len(entry_ids) > 50000:
        abort(400, "一次最多移动 50000 条资料")
    kind = str(payload.get("kind") or "")
    if kind not in {"artist", "prompt"}:
        abort(400, "资料类型无效")
    category = normalized_category_path(payload.get("category") or "") or "未分类"
    placeholders = ",".join("?" for _ in entry_ids)
    now = utc_now()
    with connect() as conn:
        conn.execute(
            "INSERT OR IGNORE INTO categories (kind, path, created_at) VALUES (?, ?, ?)",
            (kind, category, now),
        )
        cursor = conn.execute(
            f"UPDATE entries SET category = ?, updated_at = ? WHERE kind = ? AND id IN ({placeholders})",
            [category, now, kind, *entry_ids],
        )
    return jsonify({"requested": len(entry_ids), "moved": cursor.rowcount, "category": category})


def category_parent(path: str) -> str:
    return path.rsplit("/", 1)[0] if "/" in path else ""


def all_category_paths(conn, kind: str) -> set[str]:
    raw_paths = {row["path"] for row in conn.execute("SELECT path FROM categories WHERE kind = ?", (kind,))}
    raw_paths.update(row["category"] for row in conn.execute("SELECT DISTINCT category FROM entries WHERE kind = ?", (kind,)))
    paths: set[str] = set()
    for path in raw_paths:
        parts = path.split("/")
        paths.update("/".join(parts[:index]) for index in range(1, len(parts) + 1))
    return paths


@app.post("/api/categories")
def create_category():
    payload = request.get_json(force=True) or {}
    kind = str(payload.get("kind") or "")
    path = normalized_category_path(payload.get("path") or "")
    if kind not in ("artist", "prompt") or not path:
        abort(400, "资料库类型或目录路径无效")
    with connect() as conn:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO categories (kind, path, created_at) VALUES (?, ?, ?)",
            (kind, path, utc_now()),
        )
    return jsonify({"path": path, "created": cursor.rowcount > 0}), 201


@app.put("/api/categories")
def rename_category():
    payload = request.get_json(force=True) or {}
    kind = str(payload.get("kind") or "")
    old_path = normalized_category_path(payload.get("old_path") or "")
    new_path = normalized_category_path(payload.get("new_path") or "")
    if kind not in ("artist", "prompt") or not old_path or not new_path:
        abort(400, "目录路径无效")
    if new_path == old_path or new_path.startswith(f"{old_path}/"):
        abort(400, "不能把目录移动到自身内部")
    with connect() as conn:
        stored = conn.execute(
            "SELECT path FROM categories WHERE kind = ? AND (path = ? OR path LIKE ?)",
            (kind, old_path, f"{old_path}/%"),
        ).fetchall()
        conn.execute(
            """
            UPDATE entries
            SET category = ? || substr(category, ?), updated_at = ?
            WHERE kind = ? AND (category = ? OR category LIKE ?)
            """,
            (new_path, len(old_path) + 1, utc_now(), kind, old_path, f"{old_path}/%"),
        )
        mapped = [new_path + row["path"][len(old_path):] for row in stored] or [new_path]
        for path in mapped:
            conn.execute(
                "INSERT OR IGNORE INTO categories (kind, path, created_at) VALUES (?, ?, ?)",
                (kind, path, utc_now()),
            )
        conn.execute(
            "DELETE FROM categories WHERE kind = ? AND (path = ? OR path LIKE ?)",
            (kind, old_path, f"{old_path}/%"),
        )
    return jsonify({"old_path": old_path, "new_path": new_path})


@app.put("/api/categories/reorder")
def reorder_category():
    payload = request.get_json(force=True) or {}
    kind = str(payload.get("kind") or "")
    source = normalized_category_path(payload.get("source_path") or "")
    target = normalized_category_path(payload.get("target_path") or "")
    position = str(payload.get("position") or "")
    if kind not in ("artist", "prompt") or not source or not target or source == target:
        abort(400, "目录拖放参数无效")
    if position not in ("before", "after"):
        abort(400, "同级排序位置无效")
    if category_parent(source) != category_parent(target):
        abort(400, "自定义排序只能用于同一级目录；跨级请使用“成为子目录”")
    with connect() as conn:
        paths = all_category_paths(conn, kind)
        if source not in paths or target not in paths:
            abort(404, "目录不存在")
        parent = category_parent(source)
        siblings = [path for path in paths if category_parent(path) == parent]
        order_rows = conn.execute(
            "SELECT path, sort_order FROM categories WHERE kind = ?", (kind,)
        ).fetchall()
        orders = {row["path"]: row["sort_order"] for row in order_rows}
        siblings.sort(key=lambda path: (orders.get(path, 0) <= 0, orders.get(path, 0), path.casefold()))
        siblings.remove(source)
        target_index = siblings.index(target) + (1 if position == "after" else 0)
        siblings.insert(target_index, source)
        now = utc_now()
        for index, path in enumerate(siblings, 1):
            conn.execute(
                """INSERT INTO categories (kind, path, sort_order, created_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(kind, path) DO UPDATE SET sort_order = excluded.sort_order""",
                (kind, path, index * 10, now),
            )
    return jsonify({"source_path": source, "target_path": target, "position": position})


@app.put("/api/categories/place")
def place_category():
    payload = request.get_json(force=True) or {}
    kind = str(payload.get("kind") or "")
    source = normalized_category_path(payload.get("source_path") or "")
    parent = normalized_category_path(payload.get("parent_path") or "")
    before = normalized_category_path(payload.get("before_path") or "")
    if kind not in ("artist", "prompt") or not source:
        abort(400, "目录放置参数无效")
    if parent == source or parent.startswith(f"{source}/"):
        abort(400, "不能把目录放到自身内部")
    leaf = source.rsplit("/", 1)[-1]
    new_path = f"{parent}/{leaf}" if parent else leaf
    with connect() as conn:
        paths = all_category_paths(conn, kind)
        if source not in paths:
            abort(404, "被拖动的目录不存在")
        if before and (before not in paths or category_parent(before) != parent):
            abort(400, "插入位置已经变化，请重新拖放")
        if new_path != source and new_path in paths:
            abort(409, "目标层级已经存在同名目录；如需合并，请拖到该目录标题上")
        if new_path != source:
            stored = conn.execute(
                "SELECT path, sort_order FROM categories WHERE kind = ? AND (path = ? OR path LIKE ?)",
                (kind, source, f"{source}/%"),
            ).fetchall()
            conn.execute(
                """UPDATE entries SET category = ? || substr(category, ?), updated_at = ?
                   WHERE kind = ? AND (category = ? OR category LIKE ?)""",
                (new_path, len(source) + 1, utc_now(), kind, source, f"{source}/%"),
            )
            for row in stored:
                mapped = new_path + row["path"][len(source):]
                conn.execute(
                    "INSERT OR IGNORE INTO categories (kind, path, sort_order, created_at) VALUES (?, ?, ?, ?)",
                    (kind, mapped, row["sort_order"], utc_now()),
                )
            conn.execute(
                "DELETE FROM categories WHERE kind = ? AND (path = ? OR path LIKE ?)",
                (kind, source, f"{source}/%"),
            )
        paths = all_category_paths(conn, kind)
        siblings = [path for path in paths if category_parent(path) == parent and path != new_path]
        order_rows = conn.execute("SELECT path, sort_order FROM categories WHERE kind = ?", (kind,)).fetchall()
        orders = {row["path"]: row["sort_order"] for row in order_rows}
        siblings.sort(key=lambda path: (orders.get(path, 0) <= 0, orders.get(path, 0), path.casefold()))
        insert_at = siblings.index(before) if before else len(siblings)
        siblings.insert(insert_at, new_path)
        now = utc_now()
        for index, path in enumerate(siblings, 1):
            conn.execute(
                """INSERT INTO categories (kind, path, sort_order, created_at) VALUES (?, ?, ?, ?)
                   ON CONFLICT(kind, path) DO UPDATE SET sort_order = excluded.sort_order""",
                (kind, path, index * 10, now),
            )
    return jsonify({"old_path": source, "new_path": new_path, "parent_path": parent, "before_path": before})


@app.delete("/api/categories")
def delete_category():
    payload = request.get_json(force=True) or {}
    kind = str(payload.get("kind") or "")
    path = normalized_category_path(payload.get("path") or "")
    if kind not in ("artist", "prompt") or not path:
        abort(400, "目录路径无效")
    fallback = "未分类"
    with connect() as conn:
        moved = conn.execute(
            "UPDATE entries SET category = ?, updated_at = ? WHERE kind = ? AND (category = ? OR category LIKE ?)",
            (fallback, utc_now(), kind, path, f"{path}/%"),
        ).rowcount
        conn.execute(
            "DELETE FROM categories WHERE kind = ? AND (path = ? OR path LIKE ?)",
            (kind, path, f"{path}/%"),
        )
        if moved:
            conn.execute(
                "INSERT OR IGNORE INTO categories (kind, path, created_at) VALUES (?, ?, ?)",
                (kind, fallback, utc_now()),
            )
    return jsonify({"deleted": path, "moved_entries": moved, "fallback": fallback})


@app.post("/api/groups")
def create_group():
    payload = request.get_json(force=True) or {}
    kind = str(payload.get("kind") or "")
    name = str(payload.get("name") or "").strip()
    if kind not in ("artist", "prompt") or not name or len(name) > 80:
        abort(400, "分组名称或资料库类型无效")
    with connect() as conn:
        cursor = conn.execute(
            "INSERT OR IGNORE INTO custom_groups (kind, name, created_at) VALUES (?, ?, ?)",
            (kind, name, utc_now()),
        )
        row = conn.execute("SELECT id, name FROM custom_groups WHERE kind = ? AND name = ?", (kind, name)).fetchone()
    return jsonify({"id": row["id"], "name": row["name"], "created": cursor.rowcount > 0}), 201


@app.put("/api/groups/<int:group_id>")
def rename_group(group_id: int):
    name = str((request.get_json(force=True) or {}).get("name") or "").strip()
    if not name or len(name) > 80:
        abort(400, "分组名称无效")
    with connect() as conn:
        row = conn.execute("SELECT kind FROM custom_groups WHERE id = ?", (group_id,)).fetchone()
        if not row:
            abort(404)
        try:
            conn.execute("UPDATE custom_groups SET name = ? WHERE id = ?", (name, group_id))
        except sqlite3.IntegrityError:
            abort(409, "同名分组已经存在")
    return jsonify({"id": group_id, "name": name})


@app.delete("/api/groups/<int:group_id>")
def delete_group(group_id: int):
    with connect() as conn:
        cursor = conn.execute("DELETE FROM custom_groups WHERE id = ?", (group_id,))
        if cursor.rowcount == 0:
            abort(404)
    return "", 204


@app.put("/api/entries/<int:entry_id>/groups")
def set_entry_groups(entry_id: int):
    raw_ids = (request.get_json(force=True) or {}).get("group_ids", [])
    if not isinstance(raw_ids, list):
        abort(400, "分组列表格式错误")
    try:
        group_ids = sorted({int(value) for value in raw_ids})
    except (TypeError, ValueError):
        abort(400, "分组编号无效")
    with connect() as conn:
        entry = conn.execute("SELECT kind FROM entries WHERE id = ?", (entry_id,)).fetchone()
        if not entry:
            abort(404)
        if group_ids:
            placeholders = ",".join("?" for _ in group_ids)
            valid = conn.execute(
                f"SELECT id FROM custom_groups WHERE kind = ? AND id IN ({placeholders})",
                [entry["kind"], *group_ids],
            ).fetchall()
            if len(valid) != len(group_ids):
                abort(400, "包含不属于当前资料库的分组")
        conn.execute("DELETE FROM entry_groups WHERE entry_id = ?", (entry_id,))
        conn.executemany(
            "INSERT INTO entry_groups (entry_id, group_id) VALUES (?, ?)",
            [(entry_id, group_id) for group_id in group_ids],
        )
    return jsonify({"entry_id": entry_id, "group_ids": group_ids})


@app.get("/api/navigation")
def navigation():
    with connect() as conn:
        rows = conn.execute(
            "SELECT kind, category, COUNT(*) AS count FROM entries GROUP BY kind, category ORDER BY category"
        ).fetchall()
        stored_categories = conn.execute("SELECT kind, path, sort_order FROM categories ORDER BY path").fetchall()
        group_rows = conn.execute(
            """
            SELECT custom_groups.id, custom_groups.kind, custom_groups.name, COUNT(entry_groups.entry_id) AS count
            FROM custom_groups LEFT JOIN entry_groups ON entry_groups.group_id = custom_groups.id
            GROUP BY custom_groups.id ORDER BY custom_groups.name COLLATE NOCASE
            """
        ).fetchall()
        totals = conn.execute("SELECT kind, COUNT(*) AS count FROM entries GROUP BY kind").fetchall()
        favorites = conn.execute("SELECT kind, COUNT(*) AS count FROM entries WHERE favorite = 1 GROUP BY kind").fetchall()
        image_counts = conn.execute(
            """
            SELECT kind, COUNT(*) AS all_count,
                   SUM(EXISTS (SELECT 1 FROM entry_images WHERE entry_images.entry_id = entries.id)) AS with_images
            FROM entries GROUP BY kind
            """
        ).fetchall()
        rating_counts = conn.execute(
            """
            SELECT COUNT(*) AS all_count,
                   SUM(rating >= 9) AS at_least_9,
                   SUM(rating = 8) AS exactly_8,
                   SUM(rating BETWEEN 6 AND 7) AS between_6_and_7,
                   SUM(rating >= 8) AS at_least_8,
                   SUM(rating >= 6) AS at_least_6,
                   SUM(rating <= 5) AS at_most_5,
                   SUM(rating IS NULL) AS unrated
            FROM entries WHERE kind = 'artist'
            """
        ).fetchone()
        style_rows = conn.execute(
            """
            SELECT TRIM(style) AS name,
                   COUNT(*) AS all_count,
                   SUM(rating >= 9) AS at_least_9,
                   SUM(rating = 8) AS exactly_8,
                   SUM(rating BETWEEN 6 AND 7) AS between_6_and_7,
                   SUM(rating <= 5) AS at_most_5,
                   SUM(rating IS NULL) AS unrated
            FROM entries WHERE kind = 'artist'
            GROUP BY TRIM(style)
            ORDER BY TRIM(style) = '', TRIM(style) COLLATE ZH_PINYIN
            """
        ).fetchall()
    category_counts = {"artist": {}, "prompt": {}}
    for row in rows:
        parts = [part for part in row["category"].split("/") if part]
        if not parts:
            category_counts[row["kind"]][row["category"]] = row["count"]
            continue
        for depth in range(1, len(parts) + 1):
            path = "/".join(parts[:depth])
            category_counts[row["kind"]][path] = category_counts[row["kind"]].get(path, 0) + row["count"]
    category_orders = {"artist": {}, "prompt": {}}
    for row in stored_categories:
        category_counts[row["kind"]].setdefault(row["path"], 0)
        category_orders[row["kind"]][row["path"]] = row["sort_order"]
    categories = {
        kind: [{"name": name, "count": count, "sort_order": category_orders[kind].get(name, 0)} for name, count in sorted(values.items())]
        for kind, values in category_counts.items()
    }
    return jsonify({
        "categories": categories,
        "totals": {row["kind"]: row["count"] for row in totals},
        "favorites": {row["kind"]: row["count"] for row in favorites},
        "image_counts": {
            kind: {
                "all": next((row["all_count"] for row in image_counts if row["kind"] == kind), 0),
                "with_images": next((row["with_images"] for row in image_counts if row["kind"] == kind), 0) or 0,
                "without_images": next((row["all_count"] - (row["with_images"] or 0) for row in image_counts if row["kind"] == kind), 0),
            }
            for kind in ("artist", "prompt")
        },
        "ratings": dict(rating_counts),
        "styles": [dict(row) for row in style_rows],
        "groups": {
            kind: [dict(row) for row in group_rows if row["kind"] == kind]
            for kind in ("artist", "prompt")
        },
    })


@app.get("/api/stats")
def stats():
    with connect() as conn:
        entries = conn.execute("SELECT kind, COUNT(*) count FROM entries GROUP BY kind").fetchall()
        images = conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0]
    return jsonify({"entries": {row["kind"]: row["count"] for row in entries}, "images": images})


@app.post("/api/client-log")
def client_log():
    payload = request.get_json(silent=True) or {}

    def clipped(value, limit=12000):
        return str(value or "")[:limit]

    kind = clipped(payload.get("kind") or "error", 80)
    source = clipped(payload.get("source"), 2000)
    location = f" at {source}:{payload.get('line') or 0}:{payload.get('column') or 0}" if source else ""
    stack = clipped(payload.get("stack"))
    app.logger.error(
        "[browser:%s] %s%s%s",
        kind,
        clipped(payload.get("message")),
        location,
        f"\n{stack}" if stack else "",
    )
    return "", 204


app.register_blueprint(integrated)
app.register_blueprint(online_gallery)
app.register_blueprint(external_libraries)


@app.get("/api/library/navigation")
def desktop_library_navigation():
    return navigation()


@app.get("/api/library/entries")
def desktop_library_entries():
    return list_entries()


@app.get("/api/library/assets/<int:asset_id>")
def desktop_library_asset(asset_id: int):
    return external_asset(asset_id)


@app.post("/api/library/entries/<int:entry_id>/use")
def desktop_library_entry_use(entry_id: int):
    return record_entry_use(entry_id)


@app.get("/<path:desktop_path>")
def desktop_static_file(desktop_path: str):
    if os.environ.get("NYA_UNIFIED_DESKTOP") != "1" or not DESKTOP_WEB_DIR.is_dir():
        abort(404)
    candidate = (DESKTOP_WEB_DIR / desktop_path).resolve()
    try:
        candidate.relative_to(DESKTOP_WEB_DIR.resolve())
    except ValueError:
        abort(404)
    if candidate.is_file():
        return send_from_directory(DESKTOP_WEB_DIR, desktop_path)
    # Next static export stores nested-page RSC payloads as
    #   /route/__next.route/__PAGE__.txt
    # while the client asks for the static-host spelling
    #   /route/__next.route.__PAGE__.txt
    # Map that spelling explicitly so client-side navigation does not fall
    # back to a full document reload.
    page_suffix = ".__PAGE__.txt"
    if candidate.name.startswith("__next.") and candidate.name.endswith(page_suffix):
        payload_dir = candidate.name[:-len(page_suffix)]
        payload_file = candidate.parent / payload_dir / "__PAGE__.txt"
        if payload_file.is_file():
            return send_from_directory(payload_file.parent, payload_file.name)
    index_file = candidate / "index.html"
    if index_file.is_file():
        return send_from_directory(index_file.parent, "index.html")
    abort(404)


def main():
    init_db()
    backfill_asset_dimensions()
    BACKGROUND_EXECUTOR.submit(index_vocabulary_background)
    if load_integrated_settings().get("auto_scan_on_start"):
        BACKGROUND_EXECUTOR.submit(scan_local_gallery)
    host = "127.0.0.1"
    port = int(os.environ.get("NAI_LIBRARY_PORT", "5179"))
    if os.environ.get("NAI_LIBRARY_NO_BROWSER") != "1":
        Timer(0.8, lambda: webbrowser.open(f"http://{host}:{port}")).start()
    app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()
