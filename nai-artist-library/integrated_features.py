from __future__ import annotations

import json
import os
import ctypes
import ssl
import sqlite3
import subprocess
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor, wait
from contextlib import closing
from datetime import datetime, timedelta
from io import BytesIO
from pathlib import Path
from threading import Lock
import time

from flask import Blueprint, abort, jsonify, request, send_file
from PIL import Image, ImageOps
import certifi
from gallery_search import gallery_search_clauses

from database import DATA_DIR
from image_metadata import extract_image_metadata, metadata_is_current


integrated = Blueprint("integrated", __name__)
SETTINGS_PATH = DATA_DIR / "integrated-settings.json"
GALLERY_DB = DATA_DIR / "local-gallery.db"
GALLERY_THUMB_DIR = DATA_DIR / "gallery-thumbnails"
DEFAULT_SETTINGS = {
    "gallery_roots": [],
    "gallery_extensions": [".png", ".jpg", ".jpeg", ".webp", ".mp4", ".webm", ".mov", ".m4v"],
    "online_timeout": 20,
    "gallery_page_size": 300,
    "auto_scan_on_start": False,
    "recursive_scan": False,
    "gelbooru_user_id": "",
    "gelbooru_api_key": "",
    "log_retention_days": 30,
    "theme_slots": ["#f35f52", "#4775d1", "#d9469d", "#8d43d4", "#2f9b75"],
    "theme_active_slot": 0,
}
METADATA_EXECUTOR = ThreadPoolExecutor(max_workers=4, thread_name_prefix="dean-gallery")
METADATA_FUTURES: set[Future] = set()
METADATA_FUTURES_LOCK = Lock()


def submit_metadata_refresh(*arguments) -> Future:
    future = METADATA_EXECUTOR.submit(refresh_local_metadata, *arguments)
    with METADATA_FUTURES_LOCK:
        METADATA_FUTURES.add(future)
    future.add_done_callback(discard_metadata_future)
    return future


def discard_metadata_future(future: Future) -> None:
    with METADATA_FUTURES_LOCK:
        METADATA_FUTURES.discard(future)


def wait_for_metadata_idle(timeout: float = 10) -> bool:
    deadline = time.monotonic() + timeout
    while True:
        with METADATA_FUTURES_LOCK:
            pending = set(METADATA_FUTURES)
        if not pending:
            return True
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return False
        wait(pending, timeout=remaining)


def load_settings() -> dict:
    settings = dict(DEFAULT_SETTINGS)
    if SETTINGS_PATH.is_file():
        try:
            payload = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(payload, dict):
                settings.update(payload)
        except (OSError, json.JSONDecodeError):
            pass
    settings["gallery_roots"] = [
        str(Path(value).expanduser().resolve())
        for value in settings.get("gallery_roots", [])
        if str(value).strip()
    ]
    settings["gallery_extensions"] = sorted({
        extension if str(extension).startswith(".") else f".{extension}"
        for extension in settings.get("gallery_extensions", DEFAULT_SETTINGS["gallery_extensions"])
    })
    settings["online_timeout"] = min(max(int(settings.get("online_timeout", 20)), 5), 120)
    settings["gallery_page_size"] = min(max(int(settings.get("gallery_page_size", 300)), 60), 1000)
    settings["auto_scan_on_start"] = bool(settings.get("auto_scan_on_start", False))
    settings["recursive_scan"] = bool(settings.get("recursive_scan", False))
    settings["gelbooru_user_id"] = str(settings.get("gelbooru_user_id", "")).strip()
    settings["gelbooru_api_key"] = str(settings.get("gelbooru_api_key", "")).strip()
    settings["log_retention_days"] = min(max(int(settings.get("log_retention_days", 30)), 1), 3650)
    raw_slots = settings.get("theme_slots", DEFAULT_SETTINGS["theme_slots"])
    valid_slots = [
        str(value).lower() for value in raw_slots
        if isinstance(value, str) and len(value) == 7 and value.startswith("#")
        and all(character in "0123456789abcdefABCDEF" for character in value[1:])
    ]
    settings["theme_slots"] = valid_slots[:5] if len(valid_slots) >= 5 else list(DEFAULT_SETTINGS["theme_slots"])
    settings["theme_active_slot"] = min(max(int(settings.get("theme_active_slot", 0)), 0), 4)
    return settings


def gallery_connection() -> sqlite3.Connection:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(GALLERY_DB)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS local_images (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            size INTEGER NOT NULL,
            modified_ns INTEGER NOT NULL,
            width INTEGER NOT NULL DEFAULT 0,
            height INTEGER NOT NULL DEFAULT 0,
            prompt TEXT NOT NULL DEFAULT '',
            negative_prompt TEXT NOT NULL DEFAULT '',
            metadata_json TEXT NOT NULL DEFAULT '{}',
            indexed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    conn.execute("CREATE INDEX IF NOT EXISTS idx_local_images_modified ON local_images(modified_ns DESC)")
    conn.execute(
        """
        CREATE VIRTUAL TABLE IF NOT EXISTS local_images_fts USING fts5(
            name, prompt, negative_prompt,
            content='local_images', content_rowid='id'
        )
        """
    )
    conn.executescript(
        """
        CREATE TRIGGER IF NOT EXISTS local_images_fts_insert AFTER INSERT ON local_images BEGIN
          INSERT INTO local_images_fts(rowid,name,prompt,negative_prompt)
          VALUES (new.id,new.name,new.prompt,new.negative_prompt);
        END;
        CREATE TRIGGER IF NOT EXISTS local_images_fts_delete AFTER DELETE ON local_images BEGIN
          INSERT INTO local_images_fts(local_images_fts,rowid,name,prompt,negative_prompt)
          VALUES ('delete',old.id,old.name,old.prompt,old.negative_prompt);
        END;
        CREATE TRIGGER IF NOT EXISTS local_images_fts_update AFTER UPDATE OF name,prompt,negative_prompt ON local_images BEGIN
          INSERT INTO local_images_fts(local_images_fts,rowid,name,prompt,negative_prompt)
          VALUES ('delete',old.id,old.name,old.prompt,old.negative_prompt);
          INSERT INTO local_images_fts(rowid,name,prompt,negative_prompt)
          VALUES (new.id,new.name,new.prompt,new.negative_prompt);
        END;
        """
    )
    image_count = conn.execute("SELECT COUNT(*) FROM local_images").fetchone()[0]
    fts_count = conn.execute("SELECT COUNT(*) FROM local_images_fts").fetchone()[0]
    if image_count != fts_count:
        conn.execute("INSERT INTO local_images_fts(local_images_fts) VALUES ('rebuild')")
    conn.commit()
    return conn


@integrated.get("/api/integrated-settings")
def get_integrated_settings():
    return jsonify(load_settings())


@integrated.put("/api/theme-settings")
def put_theme_settings():
    payload = request.get_json(silent=True) or {}
    slots = payload.get("theme_slots")
    if not isinstance(slots, list) or len(slots) != 5:
        abort(400, "theme_slots \u5fc5\u987b\u5305\u542b 5 \u4e2a\u989c\u8272")
    normalized = [str(value).strip().lower() for value in slots]
    if any(
        len(value) != 7 or not value.startswith("#")
        or any(character not in "0123456789abcdef" for character in value[1:])
        for value in normalized
    ):
        abort(400, "\u989c\u8272\u5fc5\u987b\u4e3a #RRGGBB \u683c\u5f0f")
    active = min(max(int(payload.get("theme_active_slot", 0)), 0), 4)
    settings = load_settings()
    settings.update({"theme_slots": normalized, "theme_active_slot": active})
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify({"theme_slots": normalized, "theme_active_slot": active})


@integrated.put("/api/integrated-settings")
def put_integrated_settings():
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload.get("gallery_roots", []), list):
        abort(400, "gallery_roots 必须是路径数组")
    settings = load_settings()
    settings.update({
        "gallery_roots": [str(value).strip() for value in payload.get("gallery_roots", []) if str(value).strip()],
        "gallery_extensions": [
            str(value).strip().casefold()
            for value in payload.get("gallery_extensions", settings["gallery_extensions"])
            if str(value).strip()
        ],
        "online_timeout": payload.get("online_timeout", settings["online_timeout"]),
        "gallery_page_size": payload.get("gallery_page_size", settings["gallery_page_size"]),
        "auto_scan_on_start": payload.get("auto_scan_on_start", settings["auto_scan_on_start"]),
        "recursive_scan": payload.get("recursive_scan", settings["recursive_scan"]),
        "gelbooru_user_id": payload.get("gelbooru_user_id", settings["gelbooru_user_id"]),
        "gelbooru_api_key": payload.get("gelbooru_api_key", settings["gelbooru_api_key"]),
        "log_retention_days": payload.get("log_retention_days", settings["log_retention_days"]),
    })
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")
    return jsonify(load_settings())


@integrated.post("/api/folders/pick")
def pick_local_folder():
    if os.name != "nt":
        return jsonify({"error": "当前文件夹选择器仅支持 Windows"}), 501
    script = r"""
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '选择本地画廊文件夹'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Write($dialog.SelectedPath)
}
"""
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-STA", "-Command", script],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
            creationflags=0x08000000,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return jsonify({"error": f"无法打开文件夹选择器：{error}"}), 500
    selected = result.stdout.strip()
    if result.returncode != 0:
        return jsonify({"error": result.stderr.strip() or "文件夹选择器启动失败"}), 500
    return jsonify({"path": selected, "cancelled": not bool(selected)})


@integrated.post("/api/local/open-folder")
def open_local_folder():
    kind = (request.get_json(silent=True) or {}).get("kind", "data")
    target = DATA_DIR if kind == "data" else DATA_DIR.parent.parent / "logs" / datetime.now().strftime("%Y-%m-%d")
    target.mkdir(parents=True, exist_ok=True)
    if os.name != "nt":
        return jsonify({"error": "当前打开目录功能仅支持 Windows"}), 501
    os.startfile(target)  # type: ignore[attr-defined]
    return jsonify({"ok": True, "path": str(target)})


def refresh_local_metadata(path_text: str, expected_size: int, expected_mtime: int) -> None:
    path = Path(path_text)
    try:
        stat = path.stat()
        if stat.st_size != expected_size or stat.st_mtime_ns != expected_mtime:
            return
        # Read once and close the filesystem handle immediately. Pillow can
        # otherwise keep Windows files locked while parsing lazy metadata,
        # blocking a rename/move performed just after a scan.
        payload = path.read_bytes()
        with Image.open(BytesIO(payload)) as image:
            width, height = image.size
        metadata = extract_image_metadata(payload, include_stealth=False)
        metadata.setdefault("_scan", {}).update({"size": expected_size, "mtime_ns": expected_mtime})
        with closing(gallery_connection()) as conn, conn:
            conn.execute(
                """UPDATE local_images SET width=?, height=?, prompt=?, negative_prompt=?,
                   metadata_json=? WHERE path=? AND size=? AND modified_ns=?""",
                (
                    width, height, metadata.get("positive_prompt", ""),
                    metadata.get("negative_prompt", ""), json.dumps(metadata, ensure_ascii=False),
                    path_text, expected_size, expected_mtime,
                ),
            )
    except (OSError, ValueError, sqlite3.Error):
        return


def scan_local_gallery() -> dict:
    settings = load_settings()
    extensions = {value.casefold() for value in settings["gallery_extensions"]}
    discovered: dict[str, tuple[Path, object]] = {}
    active_roots: list[Path] = []
    recursive = settings["recursive_scan"]
    for root_value in settings["gallery_roots"]:
        root = Path(root_value).resolve()
        if not root.is_dir():
            continue
        active_roots.append(root)
        candidates = root.rglob("*") if recursive else root.iterdir()
        for path in candidates:
            if not path.is_file() or path.suffix.casefold() not in extensions:
                continue
            try:
                discovered[str(path.resolve())] = (path.resolve(), path.stat())
            except OSError:
                continue

    added = updated = moved = 0
    metadata_pending: list[tuple[str, int, int]] = []
    with closing(gallery_connection()) as conn, conn:
        current = {row["path"]: row for row in conn.execute("SELECT id,path,size,modified_ns,width,height,metadata_json FROM local_images")}
        eligible_missing = {
            path_text for path_text in set(current) - set(discovered)
            if any(Path(path_text) == root or root in Path(path_text).parents for root in active_roots)
        }
        signature_candidates: dict[tuple[int, int], list[str]] = {}
        for path_text in eligible_missing:
            row = current[path_text]
            signature_candidates.setdefault((row["size"], row["modified_ns"]), []).append(path_text)
        moved_from: set[str] = set()
        for path_text, (path, stat) in discovered.items():
            previous = current.get(path_text)
            is_video = path.suffix.casefold() in {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"}
            if previous and previous["size"] == stat.st_size and previous["modified_ns"] == stat.st_mtime_ns:
                if not is_video:
                    try:
                        saved_metadata = json.loads(previous["metadata_json"] or "{}")
                    except (TypeError, json.JSONDecodeError):
                        saved_metadata = {}
                    if (
                        int(previous["width"] or 0) <= 0
                        or int(previous["height"] or 0) <= 0
                        or not metadata_is_current(saved_metadata, path)
                    ):
                        metadata_pending.append((path_text, stat.st_size, stat.st_mtime_ns))
                continue
            if previous:
                conn.execute(
                    """UPDATE local_images SET name=?, size=?, modified_ns=?,
                       indexed_at=CURRENT_TIMESTAMP WHERE path=?""",
                    (path.name, stat.st_size, stat.st_mtime_ns, path_text),
                )
                updated += 1
            else:
                candidates = signature_candidates.get((stat.st_size, stat.st_mtime_ns), [])
                candidates = [value for value in candidates if value not in moved_from]
                if len(candidates) == 1:
                    old_path = candidates[0]
                    conn.execute(
                        """UPDATE local_images SET path=?,name=?,indexed_at=CURRENT_TIMESTAMP
                           WHERE path=?""",
                        (path_text, path.name, old_path),
                    )
                    moved_from.add(old_path)
                    moved += 1
                else:
                    conn.execute(
                        """INSERT INTO local_images
                           (path,name,size,modified_ns) VALUES (?,?,?,?)""",
                        (path_text, path.name, stat.st_size, stat.st_mtime_ns),
                    )
                    added += 1
                    if not is_video:
                        metadata_pending.append((path_text, stat.st_size, stat.st_mtime_ns))
                    continue
            if not is_video:
                metadata_pending.append((path_text, stat.st_size, stat.st_mtime_ns))
        # Do not purge an index merely because an external drive or configured folder is
        # temporarily unavailable. Only remove missing files beneath roots scanned this run.
        missing = eligible_missing - moved_from
        removed = 0
        if missing:
            conn.executemany("DELETE FROM local_images WHERE path=?", [(value,) for value in missing])
            removed = len(missing)
    for task in metadata_pending:
        submit_metadata_refresh(*task)
    return {
        "added": added, "updated": updated, "moved": moved, "removed": removed,
        "total": len(discovered), "metadata_pending": len(metadata_pending),
        "recursive": recursive,
    }


@integrated.post("/api/local-gallery/scan")
def scan_local_gallery_api():
    try:
        return jsonify(scan_local_gallery())
    except OSError as error:
        return jsonify({"error": str(error)}), 500


@integrated.post("/api/local-gallery/index-file")
def index_local_gallery_file():
    payload = request.get_json(silent=True) or {}
    raw_path = str(payload.get("path", "")).strip()
    if not raw_path:
        abort(400, "缺少图片路径")
    path = Path(raw_path).expanduser().resolve()
    settings = load_settings()
    roots = [Path(value).resolve() for value in settings["gallery_roots"]]
    if not any(path == root or root in path.parents for root in roots):
        return jsonify({"ok": True, "indexed": False, "reason": "not_in_gallery_roots"})
    if not path.is_file() or path.suffix.casefold() not in set(settings["gallery_extensions"]):
        return jsonify({"ok": True, "indexed": False, "reason": "unsupported_or_missing"})
    try:
        stat = path.stat()
        with closing(gallery_connection()) as conn, conn:
            conn.execute(
                """INSERT INTO local_images (path,name,size,modified_ns)
                   VALUES (?,?,?,?)
                   ON CONFLICT(path) DO UPDATE SET
                     name=excluded.name,size=excluded.size,modified_ns=excluded.modified_ns,
                     indexed_at=CURRENT_TIMESTAMP""",
                (str(path), path.name, stat.st_size, stat.st_mtime_ns),
            )
        # The native bridge returns only after the file is fully written. Parse
        # it before replying so the first gallery refresh cannot observe the
        # placeholder 0x0 row. This also fixes the old call accidentally
        # passing refresh_local_metadata itself as the path argument.
        refresh_local_metadata(str(path), stat.st_size, stat.st_mtime_ns)
        return jsonify({"ok": True, "indexed": True, "path": str(path)})
    except (OSError, sqlite3.Error) as error:
        return jsonify({"error": f"图片即时入库失败：{error}"}), 500


@integrated.get("/api/local-gallery/images")
def local_gallery_images():
    configured_limit = load_settings()["gallery_page_size"]
    limit = min(max(request.args.get("limit", configured_limit, type=int), 1), 1000)
    requested_page = max(request.args.get("page", 0, type=int), 0)
    offset = (requested_page - 1) * limit if requested_page else max(request.args.get("offset", 0, type=int), 0)
    query = (request.args.get("q") or "").strip()
    clauses = []
    params = []
    if request.args.get("restrict_ids") == "1":
        raw_ids = (request.args.get("ids") or "").split(",")
        image_ids = []
        for value in raw_ids:
            try:
                image_id = int(value)
            except ValueError:
                continue
            if image_id > 0:
                image_ids.append(image_id)
        if image_ids:
            clauses.append(f"id IN ({','.join('?' for _ in image_ids)})")
            params.extend(image_ids)
        else:
            clauses.append("1 = 0")
    if query:
        try:
            query_clauses, query_params = gallery_search_clauses(query)
        except ValueError as error:
            return jsonify({"error": str(error)}), 400
        clauses.extend(query_clauses)
        params.extend(query_params)
    for argument, operator in (("date_from", ">="), ("date_to", "<")):
        value = (request.args.get(argument) or "").strip()
        if value:
            try:
                moment = datetime.fromisoformat(value)
                if argument == "date_to":
                    moment += timedelta(days=1)
                clauses.append(f"modified_ns {operator} ?")
                params.append(int(moment.timestamp() * 1_000_000_000))
            except ValueError:
                abort(400, f"{argument} 日期格式无效")
    model = (request.args.get("model") or "").strip()
    sampler = (request.args.get("sampler") or "").strip()
    source_expr = "lower(COALESCE(json_extract(metadata_json,'$.raw_fields.Source'),''))"
    inferred_model = f"""CASE
      WHEN {source_expr} LIKE '%diffusion v5%' OR {source_expr} LIKE '%naiv5%' THEN
        CASE WHEN {source_expr} LIKE '%657484a5%' OR {source_expr} LIKE '%0adf9ab7%' OR {source_expr} LIKE '%full%'
             THEN 'nai-diffusion-5-full' ELSE 'nai-diffusion-5-curated' END
      WHEN {source_expr} LIKE '%v4.5%' THEN
        CASE WHEN {source_expr} LIKE '%curated%' THEN 'nai-diffusion-4-5-curated'
             WHEN {source_expr} LIKE '%4bde2a90%' OR {source_expr} LIKE '%full%' THEN 'nai-diffusion-4-5-full' ELSE '' END
      WHEN {source_expr} LIKE '%furry%' AND {source_expr} LIKE '%v3%' THEN 'nai-diffusion-furry-3'
      WHEN {source_expr} LIKE '%v4%' THEN CASE WHEN {source_expr} LIKE '%curated%' THEN 'nai-diffusion-4-curated-preview' ELSE 'nai-diffusion-4-full' END
      WHEN {source_expr} LIKE '%v3%' THEN 'nai-diffusion-3'
      ELSE '' END"""
    model_expr = f"COALESCE(json_extract(metadata_json,'$.parameters.model'),json_extract(metadata_json,'$.model'),({inferred_model}),'')"
    sampler_expr = "COALESCE(json_extract(metadata_json,'$.parameters.sampler'),json_extract(metadata_json,'$.sampler'),'')"
    steps_expr = "COALESCE(json_extract(metadata_json,'$.parameters.steps'),json_extract(metadata_json,'$.steps'))"
    cfg_expr = "COALESCE(json_extract(metadata_json,'$.parameters.scale'),json_extract(metadata_json,'$.parameters.cfg_scale'),json_extract(metadata_json,'$.scale'),json_extract(metadata_json,'$.cfg_scale'))"
    if model:
        clauses.append(f"{model_expr} = ?")
        params.append(model)
    if sampler:
        clauses.append(f"{sampler_expr} = ?")
        params.append(sampler)
    for argument, expression, operator in (
        ("steps_from", steps_expr, ">="), ("steps_to", steps_expr, "<="),
        ("cfg_from", cfg_expr, ">="), ("cfg_to", cfg_expr, "<="),
    ):
        value = request.args.get(argument)
        if value not in (None, ""):
            try:
                clauses.append(f"CAST({expression} AS REAL) {operator} ?")
                params.append(float(value))
            except ValueError:
                abort(400, f"{argument} 数值无效")
    orientation = request.args.get("orientation")
    if orientation == "portrait":
        clauses.append("height > width")
    elif orientation == "landscape":
        clauses.append("width > height")
    elif orientation == "square":
        clauses.append("width = height AND width > 0")
    resolution = (request.args.get("resolution") or "").lower().replace("×", "x")
    if "x" in resolution:
        try:
            width, height = (int(value) for value in resolution.split("x", 1))
            clauses.extend(("width = ?", "height = ?"))
            params.extend((width, height))
        except ValueError:
            abort(400, "分辨率格式无效")
    where = "WHERE " + " AND ".join(clauses) if clauses else ""
    with closing(gallery_connection()) as conn, conn:
        total = conn.execute(f"SELECT COUNT(*) FROM local_images {where}", params).fetchone()[0]
        rows = conn.execute(
            f"""SELECT id,path,name,size,width,height,prompt,negative_prompt,metadata_json,modified_ns
                FROM local_images {where} ORDER BY modified_ns DESC, id DESC LIMIT ? OFFSET ?""",
            [*params, limit, offset],
        ).fetchall()
        models = [row[0] for row in conn.execute(f"SELECT DISTINCT {model_expr} FROM local_images WHERE {model_expr} <> '' ORDER BY 1").fetchall()]
        samplers = [row[0] for row in conn.execute(f"SELECT DISTINCT {sampler_expr} FROM local_images WHERE {sampler_expr} <> '' ORDER BY 1").fetchall()]
    images = []
    for row in rows:
        item = dict(row)
        try:
            item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
        except json.JSONDecodeError:
            item["metadata"] = {}
        item["media_type"] = "video" if Path(item["path"]).suffix.casefold() in {".mp4", ".webm", ".mov", ".m4v", ".avi", ".mkv"} else "image"
        images.append(item)
    return jsonify({"images": images, "total": total, "page_size": limit, "roots": load_settings()["gallery_roots"], "models": models, "samplers": samplers})


@integrated.get("/api/local-gallery/stats")
def local_gallery_stats():
    with closing(gallery_connection()) as conn, conn:
        row = conn.execute(
            """SELECT COUNT(*) AS total, COALESCE(SUM(size),0) AS bytes,
               SUM(CASE WHEN prompt <> '' THEN 1 ELSE 0 END) AS with_prompt,
               MIN(modified_ns) AS oldest, MAX(modified_ns) AS newest
               FROM local_images"""
        ).fetchone()
        generated_rows = conn.execute(
            """SELECT name,size,width,height,modified_ns,metadata_json
               FROM local_images
               WHERE lower(name) GLOB 'deanai_*' OR lower(name) GLOB 'dean-nai*'
                  OR lower(name) GLOB 'nyanovel_*'
               ORDER BY modified_ns DESC"""
        ).fetchall()
    history = []
    parameter_keys = {
        "model", "steps", "width", "height", "scale", "cfg_rescale", "seed",
        "sampler", "noise_schedule", "dynamic_thresholding", "sm", "sm_dyn",
    }
    for image in generated_rows:
        try:
            metadata = json.loads(image["metadata_json"] or "{}")
        except (TypeError, json.JSONDecodeError):
            metadata = {}
        parameters = metadata.get("parameters") if isinstance(metadata.get("parameters"), dict) else {}
        raw_fields = metadata.get("raw_fields") if isinstance(metadata.get("raw_fields"), dict) else {}
        history.append({
            "timestamp": datetime.fromtimestamp(image["modified_ns"] / 1_000_000_000).astimezone().isoformat(),
            "size": image["size"],
            "width": image["width"],
            "height": image["height"],
            "metadata": {
                "parameters": {key: parameters[key] for key in parameter_keys if key in parameters},
                "raw_fields": {"Source": raw_fields.get("Source", "")},
            },
        })
    payload = dict(row)
    payload["generated_total"] = len(history)
    payload["history"] = history
    return jsonify(payload)


@integrated.get("/api/local-gallery/image/<int:image_id>")
def local_gallery_image(image_id: int):
    with closing(gallery_connection()) as conn, conn:
        row = conn.execute("SELECT path FROM local_images WHERE id=?", (image_id,)).fetchone()
    if not row or not Path(row["path"]).is_file():
        abort(404)
    return send_file(row["path"], conditional=True, max_age=3600)


@integrated.delete("/api/local-gallery/image/<int:image_id>")
def delete_local_gallery_image(image_id: int):
    if os.name != "nt":
        return jsonify({"error": "当前仅支持在 Windows 中移到回收站"}), 501
    with closing(gallery_connection()) as conn, conn:
        row = conn.execute("SELECT path FROM local_images WHERE id=?", (image_id,)).fetchone()
    if not row:
        abort(404)
    target = Path(row["path"]).resolve()
    if not target.is_file():
        abort(404)

    class SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", ctypes.c_void_p), ("wFunc", ctypes.c_uint), ("pFrom", ctypes.c_wchar_p),
            ("pTo", ctypes.c_wchar_p), ("fFlags", ctypes.c_ushort),
            ("fAnyOperationsAborted", ctypes.c_int), ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", ctypes.c_wchar_p),
        ]

    operation = SHFILEOPSTRUCTW()
    operation.wFunc = 3  # FO_DELETE
    operation.pFrom = str(target) + "\0\0"
    operation.fFlags = 0x0040 | 0x0010 | 0x0004 | 0x0400  # undo, no UI
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(operation))
    if result != 0 or operation.fAnyOperationsAborted:
        return jsonify({"error": f"无法移到回收站（Windows 错误 {result}）"}), 500
    with closing(gallery_connection()) as conn, conn:
        conn.execute("DELETE FROM local_images WHERE id=?", (image_id,))
    for thumbnail in GALLERY_THUMB_DIR.glob(f"{image_id}-*.webp"):
        thumbnail.unlink(missing_ok=True)
    return jsonify({"ok": True, "recycled": True})


@integrated.get("/api/local-gallery/thumbnail/<int:image_id>")
def local_gallery_thumbnail(image_id: int):
    """Serve a small cached WebP instead of making the grid decode every full-size image."""
    with closing(gallery_connection()) as conn, conn:
        row = conn.execute(
            "SELECT path,modified_ns FROM local_images WHERE id=?", (image_id,)
        ).fetchone()
    if not row or not Path(row["path"]).is_file():
        abort(404)
    GALLERY_THUMB_DIR.mkdir(parents=True, exist_ok=True)
    target = GALLERY_THUMB_DIR / f"{image_id}-{row['modified_ns']}.webp"
    if not target.is_file():
        temporary = target.with_suffix(".tmp.webp")
        try:
            with Image.open(row["path"]) as source:
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((480, 640), Image.Resampling.LANCZOS)
                image.save(temporary, "WEBP", quality=68, method=4)
            temporary.replace(target)
        except (OSError, ValueError):
            temporary.unlink(missing_ok=True)
            abort(404)
    return send_file(target, mimetype="image/webp", conditional=True, max_age=86400)


def fetch_json(url: str, timeout: int) -> object:
    req = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": "NyaLocal/0.2"})
    ssl_context = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=timeout, context=ssl_context) as response:
        return json.loads(response.read().decode("utf-8"))


def danbooru_items(source: str, query: str, page: str, limit: int, timeout: int) -> list[dict]:
    host = "https://safebooru.donmai.us" if source == "safebooru" else "https://danbooru.donmai.us"
    url = f"{host}/posts.json?" + urllib.parse.urlencode({"tags": query, "page": page, "limit": limit})
    payload = fetch_json(url, timeout)
    if not isinstance(payload, list):
        raise ValueError("站点返回的不是图片数组")
    return [{
        "id": str(row.get("id", "")), "source": source,
        "preview_url": row.get("large_file_url") or row.get("file_url") or row.get("preview_file_url") or "",
        "file_url": row.get("file_url") or row.get("large_file_url") or "",
        "tags": row.get("tag_string") or "",
        "rating": row.get("rating") or "", "score": row.get("score") or 0,
    } for row in payload if isinstance(row, dict) and (row.get("preview_file_url") or row.get("large_file_url") or row.get("file_url"))]


def aitag_cover(work: dict, asset_base: str, timeout: int) -> dict | None:
    work_id = work.get("id")
    detail = fetch_json(f"https://aitag.win/api/work/{work_id}", timeout)
    if not isinstance(detail, dict) or not isinstance(detail.get("images"), list) or not detail["images"]:
        return None
    image = detail["images"][0]
    if not isinstance(image, dict):
        return None
    image_type, author_id, file_name = image.get("image_type"), image.get("author_id"), image.get("file_name")
    if not all((image_type, author_id, file_name)):
        return None
    url = f"{asset_base.rstrip('/')}/{image_type}/{author_id}/{file_name}.webp"
    tags = work.get("tags") or []
    return {
        "id": str(work_id), "source": "aitag", "preview_url": url, "file_url": url,
        "tags": " ".join(tags) if isinstance(tags, list) else str(tags),
        "rating": "", "score": work.get("score") or 0,
    }


def aitag_items(query: str, page: str, limit: int, timeout: int) -> list[dict]:
    config = fetch_json("https://aitag.win/api/config", timeout)
    if not isinstance(config, dict) or not config.get("asset_base_url"):
        raise ValueError("AI TAG 配置中缺少资源地址")
    url = "https://aitag.win/api/ai_works_search?" + urllib.parse.urlencode({
        "page": page, "page_size": max(60, limit), "q": query, "sort": "new",
    })
    payload = fetch_json(url, timeout)
    works = payload.get("items", [])[:limit] if isinstance(payload, dict) else []
    with ThreadPoolExecutor(max_workers=min(8, max(1, len(works)))) as pool:
        covers = list(pool.map(lambda work: aitag_cover(work, config["asset_base_url"], timeout), works))
    return [cover for cover in covers if cover]


@integrated.get("/api/online-gallery/search")
def online_gallery_search():
    source = request.args.get("source", "danbooru")
    if source not in {"danbooru", "safebooru", "aitag"}:
        abort(400, "不支持的在线画廊来源")
    query = (request.args.get("q") or "").strip()[:500]
    page = (request.args.get("page") or "1")[:40]
    limit = min(max(request.args.get("limit", 40, type=int), 1), 60)
    timeout = load_settings()["online_timeout"]
    try:
        items = aitag_items(query, page, limit, timeout) if source == "aitag" else danbooru_items(source, query, page, limit, timeout)
        return jsonify({"items": items, "source": source, "page": page})
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
        return jsonify({"error": f"在线画廊请求失败：{error}"}), 502
