from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import shutil
import re
import ssl
import threading
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from uuid import uuid4

import certifi
from flask import Blueprint, abort, jsonify, request, send_file
from PIL import Image, ImageOps

from database import DATA_DIR, ORIGINALS_DIR, connect, init_db, utc_now

external_libraries = Blueprint("external_libraries", __name__)
CACHE_ROOT = DATA_DIR / "external-libraries"
THUMB_ROOT = CACHE_ROOT / "thumbnails"
CUSTOM_SOURCES_PATH = CACHE_ROOT / "custom-sources.json"
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())
JOBS: dict[str, dict] = {}
JOBS_LOCK = threading.Lock()
SYNC_LOCK = threading.Lock()
EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="external-library")

def _http(url: str, *, binary=False, limit=32 * 1024 * 1024):
    req = urllib.request.Request(url, headers={"User-Agent": "dean-nai/1.0", "Accept": "*/*"})
    error = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=45, context=SSL_CONTEXT) as response:
                data = response.read(limit + 1)
            break
        except Exception as exc:
            error = exc
            if attempt < 2:
                threading.Event().wait(0.35 * (attempt + 1))
    else:
        raise error or RuntimeError("Remote request failed")
    if len(data) > limit:
        raise ValueError(f"Remote file is larger than {limit} bytes")
    return data if binary else json.loads(data.decode("utf-8-sig"))
def _valid_remote_url(value: str) -> str:
    value = str(value or "").strip()
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("catalog_url must be an http(s) URL")
    return value


def _custom_sources() -> list[dict]:
    if not CUSTOM_SOURCES_PATH.is_file():
        return []
    try:
        payload = json.loads(CUSTOM_SOURCES_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if not isinstance(payload, list):
        return []
    return [item for item in payload if isinstance(item, dict) and str(item.get("id", "")).startswith("custom:")]


def _save_custom_sources(sources: list[dict]) -> None:
    CUSTOM_SOURCES_PATH.parent.mkdir(parents=True, exist_ok=True)
    temp = CUSTOM_SOURCES_PATH.with_suffix(".tmp")
    temp.write_text(json.dumps(sources, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(CUSTOM_SOURCES_PATH)


def _normalize_custom_source(payload: dict, source_id: str | None = None) -> dict:
    catalog_url = _valid_remote_url(payload.get("catalog_url", ""))
    format_name = str(payload.get("format") or "auto").casefold()
    if format_name not in {"auto", "json", "jsonl", "csv"}:
        raise ValueError("format must be auto, json, jsonl or csv")
    title = str(payload.get("title") or "").strip()
    if not title:
        raise ValueError("title is required")
    field_map = payload.get("field_map") or {}
    if not isinstance(field_map, dict):
        raise ValueError("field_map must be an object")
    if not source_id:
        slug = re.sub(r"[^a-z0-9]+", "-", title.casefold()).strip("-")[:40] or "source"
        source_id = f"custom:{slug}-{uuid4().hex[:8]}"
    return {
        "id": source_id, "title": title, "catalog_url": catalog_url,
        "source_url": str(payload.get("source_url") or catalog_url).strip(),
        "author": str(payload.get("author") or "").strip(),
        "description": str(payload.get("description") or "").strip(),
        "format": format_name, "entries_path": str(payload.get("entries_path") or "").strip(),
        "asset_base_url": str(payload.get("asset_base_url") or "").strip(),
        "encoding": str(payload.get("encoding") or "utf-8-sig").strip(),
        "field_map": field_map, "nsfw": bool(payload.get("nsfw")),
        "max_bytes": min(268435456, max(1048576, int(payload.get("max_bytes") or 67108864))),
    }


def _source_terms_confirmed(payload) -> bool:
    return isinstance(payload, dict) and payload.get("terms_confirmed") is True

def _path_value(value, path):
    if not path:
        return None
    current = value
    for part in str(path).split("."):
        if isinstance(current, dict):
            current = current.get(part)
        elif isinstance(current, list) and part.isdigit() and int(part) < len(current):
            current = current[int(part)]
        else:
            return None
    return current


def _pick(item: dict, field_map: dict, name: str, aliases: tuple[str, ...]):
    configured = field_map.get(name)
    if isinstance(configured, list):
        paths = [str(path) for path in configured]
    elif configured:
        paths = [str(configured)]
    else:
        paths = list(aliases)
    for path in paths:
        value = _path_value(item, path)
        if value not in (None, "", []):
            return value
    return None


def _prompt_text(value) -> str:
    if isinstance(value, list):
        return ", ".join(str(item).strip() for item in value if str(item).strip())
    if isinstance(value, dict):
        value = value.get("prompt") or value.get("tags") or value.get("text") or ""
    return str(value or "").strip()


def _character_prompts(value) -> list[dict]:
    if isinstance(value, dict):
        if any(key in value for key in ("prompt", "tags", "text")):
            value = [value]
        else:
            value = [{"label": label, "prompt": prompt} for label, prompt in value.items()]
    elif isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    result = []
    for index, item in enumerate(value):
        if isinstance(item, str):
            label, prompt, negative = f"char{index + 1}", item.strip(), ""
        elif isinstance(item, dict):
            label = str(item.get("label") or item.get("name") or item.get("title") or f"char{index + 1}").strip()
            prompt = _prompt_text(item.get("prompt") or item.get("tags") or item.get("text"))
            negative = _prompt_text(item.get("negative_prompt") or item.get("negative") or item.get("uc"))
        else:
            continue
        if prompt:
            result.append({"label": label or f"char{index + 1}", "prompt": prompt, "negative_prompt": negative})
    return result


def _metadata_character_prompts(metadata: dict) -> list[dict]:
    if not isinstance(metadata, dict):
        return []
    return _character_prompts(
        metadata.get("character_prompts") or metadata.get("characterPrompts")
        or metadata.get("characters") or metadata.get("chars")
    )
def _category_text(value) -> str:
    if isinstance(value, list):
        return "/".join(str(item).strip().strip("/") for item in value if str(item).strip().strip("/"))
    return str(value or "").strip().strip("/")


def _image_values(value) -> list:
    if value in (None, "", []):
        return []
    return value if isinstance(value, list) else [value]


def _generic_rows(raw: bytes, config: dict) -> tuple[list[dict], dict]:
    format_name = str(config.get("format", "auto")).casefold()
    text = raw.decode(str(config.get("encoding", "utf-8-sig")), errors="replace")
    if format_name == "auto":
        suffix = urllib.parse.urlparse(config["catalog_url"]).path.casefold()
        format_name = "csv" if suffix.endswith(".csv") else "jsonl" if suffix.endswith((".jsonl", ".ndjson")) else "json"
    root_meta = {}
    if format_name == "csv":
        rows = list(csv.DictReader(io.StringIO(text)))
    elif format_name == "jsonl":
        rows = [json.loads(line) for line in text.splitlines() if line.strip()]
    else:
        payload = json.loads(text)
        root_meta = payload.get("source", payload.get("meta", {})) if isinstance(payload, dict) else {}
        entries_path = config.get("entries_path")
        if entries_path:
            rows = _path_value(payload, entries_path)
        elif isinstance(payload, list):
            rows = payload
        else:
            rows = next((payload.get(key) for key in ("entries", "data", "items", "prompts", "cards") if isinstance(payload.get(key), list)), [])
    if not isinstance(rows, list):
        raise ValueError("No entry array found; set entries_path in the source manifest")
    return [row for row in rows if isinstance(row, dict)], root_meta if isinstance(root_meta, dict) else {}


def _normalize_generic_entries(raw: bytes, config: dict) -> tuple[list[dict], dict]:
    rows, root_meta = _generic_rows(raw, config)
    field_map = config.get("field_map") if isinstance(config.get("field_map"), dict) else {}
    base_url = str(config.get("asset_base_url") or config.get("catalog_url") or "")
    entries = []
    for order, item in enumerate(rows):
        title = _prompt_text(_pick(item, field_map, "title", ("title", "name", "label")))
        prompt = _prompt_text(_pick(item, field_map, "prompt", ("prompt", "positive_prompt", "positive", "content", "tags", "tag")))
        negative = _prompt_text(_pick(item, field_map, "negative", ("negative_prompt", "negative", "uc")))
        category = _category_text(_pick(item, field_map, "category", ("category", "path", "group", "folder", "type")))
        external_id = _pick(item, field_map, "id", ("id", "key", "uuid", "slug"))
        if external_id in (None, ""):
            external_id = hashlib.sha1(f"{title}\0{prompt}\0{order}".encode("utf-8")).hexdigest()
        image_value = _pick(item, field_map, "images", ("images", "image", "thumbnail", "thumbnail_url", "preview", "cover"))
        images = []
        for image in _image_values(image_value):
            image = {"url": image} if isinstance(image, str) else image
            if not isinstance(image, dict):
                continue
            remote = image.get("url") or image.get("src") or image.get("path") or image.get("thumbnail")
            if not remote:
                continue
            images.append({
                "url": urllib.parse.urljoin(base_url, str(remote)),
                "revision": str(image.get("revision") or image.get("rev") or ""),
                "width": image.get("width"), "height": image.get("height"),
            })
        if not title:
            title = prompt[:60] or f"Entry {order + 1}"
        characters = _character_prompts(_pick(item, field_map, "characters", (
            "characterPrompts", "character_prompts", "characters", "chars",
        )))
        entries.append({
            "id": str(external_id), "title": title, "prompt": prompt, "negative": negative,
            "category": category, "note": _prompt_text(_pick(item, field_map, "note", ("note", "description", "summary"))),
            "images": images, "metadata": {"generic_source": True, "characterPrompts": characters},
        })
    return entries, root_meta


def _sync_custom(conn, job_id: str, config: dict) -> None:
    source_id = config["id"]
    _job(job_id, phase="index", message=f"{config.get('title') or source_id} index")
    raw = _http(_valid_remote_url(config["catalog_url"]), binary=True, limit=int(config.get("max_bytes", 64 * 1024 * 1024)))
    entries, root_meta = _normalize_generic_entries(raw, config)
    _upsert_source(conn, {
        "id": source_id, "provider": "generic", "title": config.get("title") or root_meta.get("title") or source_id,
        "author": config.get("author") or root_meta.get("author", ""),
        "source_url": config.get("source_url") or config["catalog_url"],
        "description": config.get("description") or root_meta.get("description", ""),
        "version": str(root_meta.get("version", "")), "nsfw": bool(config.get("nsfw")),
        "remote_state": str(len(entries)),
    })
    _upsert_entries(conn, source_id, entries)
    _job(job_id, current=len(entries), total=len(entries), message=config.get("title") or source_id)


def _job(job_id: str, **changes):
    with JOBS_LOCK:
        state = JOBS.setdefault(job_id, {"id": job_id, "cancelled": False})
        state.update(changes)
        return dict(state)

def _cancelled(job_id: str) -> bool:
    with JOBS_LOCK:
        return bool(JOBS.get(job_id, {}).get("cancelled"))

def _register_custom_sources(conn):
    """Expose only sources explicitly configured by the local user."""
    for config in _custom_sources():
        _upsert_source(conn, {
            "id": config["id"], "provider": "generic", "title": config["title"],
            "author": config.get("author", ""), "source_url": config["source_url"],
            "description": config.get("description", ""), "nsfw": config.get("nsfw", False),
            "status": "configured",
        })

def _upsert_source(conn, source: dict):
    now = utc_now()
    fields = {
        "id": source["id"], "provider": source.get("provider", ""), "parent_id": source.get("parent_id"),
        "is_collection": int(bool(source.get("is_collection"))), "upstream_id": source.get("upstream_id", ""),
        "title": source.get("title", source["id"]), "source_type": source.get("source_type", "prompt"),
        "author": source.get("author", ""), "version": source.get("version", ""),
        "source_url": source.get("source_url", ""), "description": source.get("description", ""),
        "nsfw": int(bool(source.get("nsfw"))), "status": source.get("status", "ready"),
        "remote_state": source.get("remote_state", ""), "error": "", "last_sync_at": now,
    }
    cols = list(fields) + ["created_at", "updated_at"]
    vals = list(fields.values()) + [now, now]
    updates = ",".join(f"{col}=excluded.{col}" for col in fields if col != "id") + ",updated_at=excluded.updated_at"
    conn.execute(f"INSERT INTO external_sources ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)}) ON CONFLICT(id) DO UPDATE SET {updates}", vals)

def _upsert_entries(conn, source_id: str, entries: list[dict]):
    now = utc_now()
    conn.execute("UPDATE external_entries SET available=0 WHERE source_id=?", (source_id,))
    for order, entry in enumerate(entries):
        external_id = str(entry.get("id") or order)
        conn.execute("""INSERT INTO external_entries
          (source_id,external_id,title,prompt,negative_prompt,category,source_note,metadata_json,available,sort_order,updated_at)
          VALUES (?,?,?,?,?,?,?,?,1,?,?)
          ON CONFLICT(source_id,external_id) DO UPDATE SET
          title=excluded.title,prompt=excluded.prompt,negative_prompt=excluded.negative_prompt,
          category=excluded.category,source_note=excluded.source_note,metadata_json=excluded.metadata_json,
          available=1,sort_order=excluded.sort_order,updated_at=excluded.updated_at""",
          (source_id, external_id, entry.get("title", ""), entry.get("prompt", ""), entry.get("negative", ""),
           entry.get("category", ""), entry.get("note", ""), json.dumps(entry.get("metadata", {}), ensure_ascii=False), order, now))
        images = entry.get("images", [])
        for index, image in enumerate(images):
            old = conn.execute("SELECT remote_url,asset_revision,thumb_path FROM external_entry_images WHERE source_id=? AND external_id=? AND image_index=?",
                               (source_id, external_id, index)).fetchone()
            rev = str(image.get("revision", ""))
            thumb = old["thumb_path"] if old and old["remote_url"] == image["url"] and old["asset_revision"] == rev else ""
            conn.execute("""INSERT INTO external_entry_images
              (source_id,external_id,image_index,remote_url,thumb_path,asset_revision,width,height,updated_at)
              VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id,image_index) DO UPDATE SET
              remote_url=excluded.remote_url,thumb_path=excluded.thumb_path,asset_revision=excluded.asset_revision,
              width=excluded.width,height=excluded.height,updated_at=excluded.updated_at""",
              (source_id, external_id, index, image["url"], thumb, rev, image.get("width"), image.get("height"), now))
        conn.execute("DELETE FROM external_entry_images WHERE source_id=? AND external_id=? AND image_index>=?",
                     (source_id, external_id, len(images)))

def _thumbnail_rel(source_id: str, external_id: str, index: int, remote_url: str) -> str:
    key = hashlib.sha256(f"{source_id}\0{external_id}\0{index}\0{remote_url}".encode()).hexdigest()
    return str(Path("external-libraries") / "thumbnails" / source_id.replace(":", "_") / f"{key}.webp").replace("\\", "/")

def _download_thumb(row) -> tuple[str, int, int]:
    raw = _http(row["remote_url"], binary=True, limit=40 * 1024 * 1024)
    with Image.open(io.BytesIO(raw)) as source:
        image = ImageOps.exif_transpose(source).convert("RGB")
        image.thumbnail((480, 480), Image.Resampling.LANCZOS)
        width, height = image.size
        target = DATA_DIR / _thumbnail_rel(row["source_id"], row["external_id"], row["image_index"], row["remote_url"])
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(".tmp")
        image.save(temp, "WEBP", quality=68, method=4)
        temp.replace(target)
    return str(target.relative_to(DATA_DIR)).replace("\\", "/"), width, height

def _source_filter(source_id: str):
    if source_id == "all":
        return "", []
    return " AND (i.source_id=? OR s.parent_id=?)", [source_id, source_id]

def _cache_thumbnails(source_id: str, job_id: str):
    clause, args = _source_filter(source_id)
    with connect() as conn:
        rows = conn.execute(f"""SELECT i.* FROM external_entry_images i
          JOIN external_sources s ON s.id=i.source_id JOIN external_entries e
          ON e.source_id=i.source_id AND e.external_id=i.external_id
          WHERE e.available=1{clause}
          ORDER BY i.source_id,e.sort_order,i.image_index""", args).fetchall()
    # A database path is not enough: users may clear the thumbnail directory
    # manually. Cache-only must also repair records whose file disappeared.
    rows = [row for row in rows if not row["thumb_path"] or not (DATA_DIR / row["thumb_path"]).is_file()]
    total = len(rows)
    _job(job_id, phase="images", current=0, total=total, message="Caching thumbnails")
    with ThreadPoolExecutor(max_workers=24, thread_name_prefix="external-thumb") as pool:
        futures = {pool.submit(_download_thumb, row): row for row in rows}
        for done, future in enumerate(as_completed(futures), 1):
            if _cancelled(job_id):
                for pending in futures:
                    pending.cancel()
                raise InterruptedError("cancelled")
            row = futures[future]
            try:
                # Download and image conversion happen before opening the short
                # write transaction, so a slow host cannot block local records.
                rel, width, height = future.result()
                size = (DATA_DIR / rel).stat().st_size
                with connect() as conn:
                    conn.execute("""UPDATE external_entry_images SET thumb_path=?,width=?,height=?,cached_bytes=?,updated_at=?
                      WHERE source_id=? AND external_id=? AND image_index=?""",
                      (rel, width, height, size, utc_now(), row["source_id"], row["external_id"], row["image_index"]))
            except Exception as exc:
                _job(job_id, last_error=str(exc))
            if done % 10 == 0 or done == total:
                _job(job_id, current=done)


def _refresh_counts(conn):
    conn.execute("""UPDATE external_sources SET
      entry_count=(SELECT COUNT(*) FROM external_entries e WHERE e.source_id=external_sources.id AND e.available=1),
      image_count=(SELECT COUNT(*) FROM external_entry_images i JOIN external_entries e
        ON e.source_id=i.source_id AND e.external_id=i.external_id WHERE i.source_id=external_sources.id AND e.available=1),
      cached_count=(SELECT COUNT(*) FROM external_entry_images i JOIN external_entries e
        ON e.source_id=i.source_id AND e.external_id=i.external_id WHERE i.source_id=external_sources.id
        AND e.available=1 AND i.thumb_path!=''),
      updated_at=?""", (utc_now(),))
    conn.execute("""UPDATE external_sources SET
      entry_count=(SELECT COALESCE(SUM(c.entry_count),0) FROM external_sources c WHERE c.parent_id=external_sources.id),
      image_count=(SELECT COALESCE(SUM(c.image_count),0) FROM external_sources c WHERE c.parent_id=external_sources.id),
      cached_count=(SELECT COALESCE(SUM(c.cached_count),0) FROM external_sources c WHERE c.parent_id=external_sources.id)
      WHERE is_collection=1""")

def _run_sync(job_id: str, source_id: str, cache_images: bool):
    try:
        with SYNC_LOCK:
            _job(job_id, status="running", phase="index", current=0, total=0)
            configs = _custom_sources()
            selected = configs if source_id == "all" else [item for item in configs if item["id"] == source_id]
            if source_id != "all" and not selected:
                raise ValueError("该来源不是由当前用户配置的结构化来源")
            with connect() as conn:
                _register_custom_sources(conn)
            for config in selected:
                with connect() as conn:
                    _sync_custom(conn, job_id, config)
            with connect() as conn:
                _refresh_counts(conn)
            if cache_images and not _cancelled(job_id):
                _cache_thumbnails(source_id, job_id)
            with connect() as conn:
                _refresh_counts(conn)
            status = "cancelled" if _cancelled(job_id) else "complete"
            _job(job_id, status=status, phase=status, finished_at=utc_now())
    except InterruptedError:
        _job(job_id, status="cancelled", phase="cancelled", finished_at=utc_now())
    except Exception as exc:
        _job(job_id, status="failed", phase="failed", error=str(exc), finished_at=utc_now())

def start_sync(source_id="all", cache_images=True):
    job_id = uuid4().hex
    _job(job_id, status="queued", source_id=source_id, cache_images=cache_images,
         phase="queued", current=0, total=0, started_at=utc_now())
    EXECUTOR.submit(_run_sync, job_id, source_id, cache_images)
    return job_id

def _run_cache_only(job_id: str, source_id: str):
    try:
        _job(job_id, status="running", phase="images", current=0, total=0)
        _cache_thumbnails(source_id, job_id)
        with connect() as conn:
            _refresh_counts(conn)
        _job(job_id, status="complete", phase="complete", finished_at=utc_now())
    except InterruptedError:
        _job(job_id, status="cancelled", phase="cancelled", finished_at=utc_now())
    except Exception as exc:
        _job(job_id, status="failed", phase="failed", error=str(exc), finished_at=utc_now())

def start_cache(source_id="all"):
    job_id = uuid4().hex
    _job(job_id, status="queued", source_id=source_id, phase="queued", current=0, total=0, started_at=utc_now())
    EXECUTOR.submit(_run_cache_only, job_id, source_id)
    return job_id

def _source_dict(row):
    item = dict(row)
    for key in ("is_collection", "nsfw"):
        item[key] = bool(item[key])
    return item

def _image_dict(row):
    item = dict(row)
    item["thumbnail_url"] = f"/api/external-libraries/thumbnail/{item['source_id']}/{item['external_id']}/{item['image_index']}"
    item.pop("remote_url", None)
    return item

@external_libraries.get("/api/external-libraries/sources")
def sources_api():
    with connect() as conn:
        _register_custom_sources(conn)
        rows = conn.execute("""SELECT * FROM external_sources
          ORDER BY parent_id IS NOT NULL,parent_id,provider,title COLLATE NOCASE""").fetchall()
        counts = conn.execute("""SELECT e.source_id,COUNT(DISTINCT e.external_id) entry_count,
          COUNT(i.image_index) image_count,
          SUM(CASE WHEN i.thumb_path!='' THEN 1 ELSE 0 END) cached_count
          FROM external_entries e LEFT JOIN external_entry_images i
          ON i.source_id=e.source_id AND i.external_id=e.external_id
          WHERE e.available=1 GROUP BY e.source_id""").fetchall()
    items = [_source_dict(row) for row in rows]
    count_map = {row["source_id"]: dict(row) for row in counts}
    for item in items:
        current = count_map.get(item["id"], {})
        item["entry_count"] = int(current.get("entry_count") or 0)
        item["image_count"] = int(current.get("image_count") or 0)
        item["cached_count"] = int(current.get("cached_count") or 0)
    for item in items:
        if item["is_collection"]:
            children = [child for child in items if child["parent_id"] == item["id"]]
            item["entry_count"] = sum(child["entry_count"] for child in children)
            item["image_count"] = sum(child["image_count"] for child in children)
            item["cached_count"] = sum(child["cached_count"] for child in children)
    return jsonify({"sources": items})

@external_libraries.get("/api/external-libraries/entries")
def entries_api():
    source_id = request.args.get("source", "all")
    search = request.args.get("search", "").strip()
    category = request.args.get("category", "").strip()
    favorites = request.args.get("favorites", "") == "1"
    pinned = request.args.get("pinned", "") == "1"
    try:
        page = max(1, int(request.args.get("page", 1)))
        page_size = min(120, max(1, int(request.args.get("page_size", 60))))
    except ValueError:
        abort(400)
    where = ["e.available=1"]
    args: list = []
    if source_id != "all":
        where.append("(e.source_id=? OR s.parent_id=?)")
        args.extend([source_id, source_id])
    if search:
        where.append("(e.title LIKE ? OR e.prompt LIKE ? OR e.category LIKE ? OR e.metadata_json LIKE ?)")
        token = f"%{search}%"
        args.extend([token, token, token, token])
    if category:
        where.append("e.category LIKE ?")
        args.append(category + "%")
    if favorites:
        where.append("COALESCE(u.favorite,0)=1")
    if pinned:
        where.append("COALESCE(u.pinned,0)=1")
    clause = " AND ".join(where)
    with connect() as conn:
        total = conn.execute(f"""SELECT COUNT(*) FROM external_entries e JOIN external_sources s ON s.id=e.source_id
          LEFT JOIN external_user_data u ON u.source_id=e.source_id AND u.external_id=e.external_id WHERE {clause}""", args).fetchone()[0]
        rows = conn.execute(f"""SELECT e.*,s.title source_title,s.source_url,COALESCE(u.favorite,0) favorite,
          COALESCE(u.pinned,0) pinned,COALESCE(u.personal_note,'') personal_note,u.saved_entry_id
          FROM external_entries e JOIN external_sources s ON s.id=e.source_id
          LEFT JOIN external_user_data u ON u.source_id=e.source_id AND u.external_id=e.external_id
          WHERE {clause} ORDER BY COALESCE(u.pinned,0) DESC,e.sort_order,e.title COLLATE NOCASE LIMIT ? OFFSET ?""",
          [*args, page_size, (page - 1) * page_size]).fetchall()
        results = []
        for row in rows:
            item = dict(row)
            item["favorite"] = bool(item["favorite"])
            item["pinned"] = bool(item["pinned"])
            try:
                item["metadata"] = json.loads(item.pop("metadata_json") or "{}")
            except json.JSONDecodeError:
                item["metadata"] = {}
            item["character_prompts"] = _metadata_character_prompts(item["metadata"])
            images = conn.execute("""SELECT source_id,external_id,image_index,thumb_path,asset_revision,width,height,cached_bytes
              FROM external_entry_images WHERE source_id=? AND external_id=? ORDER BY image_index""",
              (item["source_id"], item["external_id"])).fetchall()
            item["images"] = [_image_dict(x) for x in images]
            results.append(item)
    return jsonify({"entries": results, "total": total, "page": page, "page_size": page_size})

@external_libraries.get("/api/external-libraries/categories")
def categories_api():
    source_id = request.args.get("source", "all")
    clause, args = ("", []) if source_id == "all" else (" AND (e.source_id=? OR s.parent_id=?)", [source_id, source_id])
    with connect() as conn:
        rows = conn.execute(f"""SELECT e.category,MIN(e.metadata_json) metadata_json,COUNT(*) count FROM external_entries e
          JOIN external_sources s ON s.id=e.source_id WHERE e.available=1 AND e.category!=''{clause}
          GROUP BY e.category ORDER BY e.category COLLATE NOCASE""", args).fetchall()
    categories = []
    for row in rows:
        item = {"category": row["category"], "count": row["count"]}
        try:
            metadata = json.loads(row["metadata_json"] or "{}")
            parts = metadata.get("path")
            if isinstance(parts, list) and all(isinstance(part, str) for part in parts):
                item["parts"] = parts
        except (json.JSONDecodeError, TypeError):
            pass
        categories.append(item)
    return jsonify({"categories": categories})

@external_libraries.get("/api/external-libraries/custom-sources")
def custom_sources_api():
    return jsonify({"sources": _custom_sources()})


@external_libraries.post("/api/external-libraries/custom-sources")
def create_custom_source_api():
    payload = request.get_json(silent=True) or {}
    if not _source_terms_confirmed(payload):
        return jsonify({"error": "请先确认你有权访问和使用该来源"}), 400
    try:
        config = _normalize_custom_source(payload)
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400
    sources = _custom_sources()
    sources.append(config)
    _save_custom_sources(sources)
    with connect() as conn:
        _register_custom_sources(conn)
    return jsonify(config), 201


@external_libraries.put("/api/external-libraries/custom-sources/<path:source_id>")
def update_custom_source_api(source_id):
    sources = _custom_sources()
    index = next((index for index, item in enumerate(sources) if item["id"] == source_id), None)
    if index is None:
        abort(404)
    try:
        config = _normalize_custom_source(request.get_json(silent=True) or {}, source_id)
    except (TypeError, ValueError) as error:
        return jsonify({"error": str(error)}), 400
    sources[index] = config
    _save_custom_sources(sources)
    with connect() as conn:
        _register_custom_sources(conn)
    return jsonify(config)


@external_libraries.delete("/api/external-libraries/custom-sources/<path:source_id>")
def delete_custom_source_api(source_id):
    sources = _custom_sources()
    kept = [item for item in sources if item["id"] != source_id]
    if len(kept) == len(sources):
        abort(404)
    _save_custom_sources(kept)
    with connect() as conn:
        conn.execute("DELETE FROM external_entry_images WHERE source_id=?", (source_id,))
        conn.execute("DELETE FROM external_user_data WHERE source_id=?", (source_id,))
        conn.execute("DELETE FROM external_entries WHERE source_id=?", (source_id,))
        conn.execute("DELETE FROM external_sources WHERE id=?", (source_id,))
    return "", 204

@external_libraries.post("/api/external-libraries/sync")
def sync_api():
    data = request.get_json(silent=True) or {}
    source_id = str(data.get("source_id", "all"))
    return jsonify({"job_id": start_sync(source_id, bool(data.get("cache_images", True)))}), 202

@external_libraries.post("/api/external-libraries/cache")
def cache_api():
    data = request.get_json(silent=True) or {}
    source_id = str(data.get("source_id", "all"))
    return jsonify({"job_id": start_cache(source_id)}), 202


@external_libraries.get("/api/external-libraries/jobs/<job_id>")
def job_api(job_id):
    with JOBS_LOCK:
        state = JOBS.get(job_id)
    if not state:
        abort(404)
    return jsonify(state)

@external_libraries.post("/api/external-libraries/jobs/<job_id>/cancel")
def cancel_job_api(job_id):
    with JOBS_LOCK:
        if job_id not in JOBS:
            abort(404)
        JOBS[job_id]["cancelled"] = True
    return jsonify({"cancelled": True})

def _ensure_thumb(source_id: str, external_id: str, image_index: int) -> Path:
    with connect() as conn:
        row = conn.execute("""SELECT * FROM external_entry_images WHERE source_id=? AND external_id=? AND image_index=?""",
                           (source_id, external_id, image_index)).fetchone()
    if not row:
        abort(404)
    if row["thumb_path"] and (DATA_DIR / row["thumb_path"]).is_file():
        return DATA_DIR / row["thumb_path"]
    rel, width, height = _download_thumb(row)
    target = DATA_DIR / rel
    with connect() as conn:
        conn.execute("""UPDATE external_entry_images SET thumb_path=?,width=?,height=?,cached_bytes=?,updated_at=?
          WHERE source_id=? AND external_id=? AND image_index=?""",
          (rel, width, height, target.stat().st_size, utc_now(), source_id, external_id, image_index))
        _refresh_counts(conn)
    return target

@external_libraries.get("/api/external-libraries/thumbnail/<source_id>/<external_id>/<int:image_index>")
def thumbnail_api(source_id, external_id, image_index):
    return send_file(_ensure_thumb(source_id, external_id, image_index), mimetype="image/webp", max_age=31536000)

@external_libraries.put("/api/external-libraries/entries/<source_id>/<external_id>/user-data")
def user_data_api(source_id, external_id):
    data = request.get_json(silent=True) or {}
    with connect() as conn:
        exists = conn.execute("SELECT 1 FROM external_entries WHERE source_id=? AND external_id=?", (source_id, external_id)).fetchone()
        if not exists:
            abort(404)
        old = conn.execute("SELECT * FROM external_user_data WHERE source_id=? AND external_id=?", (source_id, external_id)).fetchone()
        favorite = int(bool(data.get("favorite", old["favorite"] if old else False)))
        pinned = int(bool(data.get("pinned", old["pinned"] if old else False)))
        note = str(data.get("personal_note", old["personal_note"] if old else ""))
        saved = old["saved_entry_id"] if old else None
        conn.execute("""INSERT INTO external_user_data(source_id,external_id,favorite,pinned,personal_note,saved_entry_id,updated_at)
          VALUES(?,?,?,?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET
          favorite=excluded.favorite,pinned=excluded.pinned,personal_note=excluded.personal_note,updated_at=excluded.updated_at""",
          (source_id, external_id, favorite, pinned, note, saved, utc_now()))
    return jsonify({"favorite": bool(favorite), "pinned": bool(pinned), "personal_note": note})

@external_libraries.post("/api/external-libraries/entries/<source_id>/<external_id>/save-local")
def save_local_api(source_id, external_id):
    with connect() as conn:
        row = conn.execute("""SELECT e.*,s.title source_title FROM external_entries e JOIN external_sources s ON s.id=e.source_id
          WHERE e.source_id=? AND e.external_id=?""", (source_id, external_id)).fetchone()
        image = conn.execute("""SELECT image_index FROM external_entry_images WHERE source_id=? AND external_id=?
          ORDER BY image_index LIMIT 1""", (source_id, external_id)).fetchone()
    if not row:
        abort(404)
    try:
        characters = _metadata_character_prompts(json.loads(row["metadata_json"] or "{}"))
    except json.JSONDecodeError:
        characters = []
    combined_prompt = "`n".join(
        part for part in [row["prompt"], *(item["prompt"] for item in characters)] if str(part).strip()
    )
    thumb = _ensure_thumb(source_id, external_id, image["image_index"]) if image else None
    now = utc_now()
    kind = "artist" if "artist" in source_id.lower() else "prompt"
    category = "\u5916\u7f6e\u8d44\u6599\u5e93/" + row["source_title"]
    if row["category"]:
        category += "/" + row["category"]
    with connect() as conn:
        user = conn.execute("SELECT saved_entry_id FROM external_user_data WHERE source_id=? AND external_id=?",
                            (source_id, external_id)).fetchone()
        entry_id = user["saved_entry_id"] if user else None
        if entry_id and not conn.execute("SELECT 1 FROM entries WHERE id=?", (entry_id,)).fetchone():
            entry_id = None
        if not entry_id:
            cursor = conn.execute("""INSERT INTO entries
              (kind,title,content,negative_prompt,category,notes,tags,created_at,updated_at)
              VALUES(?,?,?,?,?,?,?, ?,?)""",
              (kind, row["title"] or row["external_id"], combined_prompt, row["negative_prompt"], category,
               row["source_note"], "[]", now, now))
            entry_id = cursor.lastrowid
        else:
            conn.execute("""UPDATE entries SET title=?,content=?,negative_prompt=?,category=?,notes=?,updated_at=? WHERE id=?""",
                         (row["title"], combined_prompt, row["negative_prompt"], category, row["source_note"], now, entry_id))
        conn.execute("""INSERT INTO external_user_data(source_id,external_id,saved_entry_id,updated_at)
          VALUES(?,?,?,?) ON CONFLICT(source_id,external_id) DO UPDATE SET saved_entry_id=excluded.saved_entry_id,updated_at=excluded.updated_at""",
          (source_id, external_id, entry_id, now))
        if thumb:
            target_dir = ORIGINALS_DIR / "external-imports"
            target_dir.mkdir(parents=True, exist_ok=True)
            digest = hashlib.sha256(thumb.read_bytes()).hexdigest()
            target = target_dir / f"{digest}.webp"
            if not target.exists():
                shutil.copy2(thumb, target)
            rel = str(target.relative_to(ORIGINALS_DIR)).replace("\\", "/")
            conn.execute("""INSERT INTO assets(path,thumbnail_path,sha256,metadata_json,width,height,created_at)
              VALUES(?,?,?,?,?,?,?) ON CONFLICT(sha256) DO NOTHING""", (rel, rel, digest, "{}", None, None, now))
            asset = conn.execute("SELECT id FROM assets WHERE sha256=?", (digest,)).fetchone()
            conn.execute("INSERT OR IGNORE INTO entry_images(entry_id,asset_id,sort_order) VALUES(?,?,0)", (entry_id, asset["id"]))
    return jsonify({"entry_id": entry_id})

def cli():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", default="all")
    parser.add_argument("--no-images", action="store_true")
    parser.add_argument("--images-only", action="store_true")
    args = parser.parse_args()
    init_db()
    job_id = start_cache(args.source) if args.images_only else start_sync(args.source, not args.no_images)
    last = None
    while True:
        with JOBS_LOCK:
            state = dict(JOBS[job_id])
        marker = (state.get("phase"), state.get("current"), state.get("total"), state.get("message"))
        if marker != last and (state.get("current", 0) % 50 == 0 or state.get("phase") not in {"images"}):
            print(json.dumps(state, ensure_ascii=False), flush=True)
            last = marker
        if state.get("status") in {"complete", "failed", "cancelled"}:
            raise SystemExit(0 if state["status"] == "complete" else 1)
        threading.Event().wait(1)

if __name__ == "__main__":
    cli()
