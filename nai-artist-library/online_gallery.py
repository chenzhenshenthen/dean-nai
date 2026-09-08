from __future__ import annotations

import json
import hashlib
import ssl
import urllib.error
import urllib.parse
import urllib.request
import time
from threading import Lock

import certifi
from flask import Blueprint, abort, jsonify, request, send_file
from PIL import Image, ImageOps

from integrated_features import load_settings
from database import DATA_DIR


online_gallery = Blueprint("online_gallery_v2", __name__)
ONLINE_CACHE = DATA_DIR / "online-gallery-cache"
AI_TAG_ASSET_HOSTS: set[str] = set()
AI_TAG_CONFIG_CACHE: tuple[float, dict] | None = None
AI_TAG_DETAIL_CACHE: dict[str, tuple[float, dict]] = {}
AI_TAG_CACHE_LOCK = Lock()


def fetch_json(url: str) -> object:
    timeout = load_settings()["online_timeout"]
    headers = {"Accept": "application/json", "User-Agent": "dean-nai/0.1"}
    req = urllib.request.Request(url, headers=headers)
    context = ssl.create_default_context(cafile=certifi.where())
    with urllib.request.urlopen(req, timeout=timeout, context=context) as response:
        return json.loads(response.read().decode("utf-8"))


def ai_tag_config() -> dict:
    global AI_TAG_CONFIG_CACHE
    with AI_TAG_CACHE_LOCK:
        if AI_TAG_CONFIG_CACHE and time.monotonic() - AI_TAG_CONFIG_CACHE[0] < 1800:
            return AI_TAG_CONFIG_CACHE[1]
        payload = fetch_json("https://aitag.win/api/config")
        if not isinstance(payload, dict):
            raise ValueError("AI TAG 配置格式错误")
        AI_TAG_CONFIG_CACHE = (time.monotonic(), payload)
        return payload


def normalized(source: str, row: dict) -> dict:
    raw_tags = row.get("tag_string") or row.get("tags") or ""
    tags = " ".join(str(value) for value in raw_tags) if isinstance(raw_tags, list) else str(raw_tags)
    return {
        "id": str(row.get("id") or ""),
        "source": source,
        "preview_url": row.get("large_file_url") or row.get("sample_url") or row.get("file_url") or row.get("preview_file_url") or row.get("preview_url") or "",
        "file_url": row.get("file_url") or row.get("large_file_url") or row.get("sample_url") or "",
        "tags": tags,
        "rating": row.get("rating") or "",
        "score": row.get("score") or 0,
        "title": row.get("title") or "",
        "author": row.get("userName") or row.get("author") or "",
        "prompt": row.get("prompt") or "",
        "negative_prompt": row.get("negative_prompt") or "",
    }


def donmai(source: str, query: str, page: int, limit: int, mode: str, period: str, date: str) -> list[dict]:
    host = "https://safebooru.donmai.us" if source == "safebooru" else "https://danbooru.donmai.us"
    if mode == "popular":
        endpoint = "/explore/posts/popular.json"
        params = {"scale": period, "page": page, "limit": limit}
        if date:
            params["date"] = date
    else:
        endpoint = "/posts.json"
        params = {"tags": query, "page": page, "limit": limit}
    payload = fetch_json(f"{host}{endpoint}?" + urllib.parse.urlencode(params))
    if not isinstance(payload, list):
        raise ValueError("Donmai 返回的数据不是数组")
    return [normalized(source, row) for row in payload if isinstance(row, dict) and normalized(source, row)["preview_url"]]


def gelbooru(query: str, page: int, limit: int) -> list[dict]:
    settings = load_settings()
    if not settings.get("gelbooru_api_key") or not settings.get("gelbooru_user_id"):
        raise ValueError("Gelbooru 当前要求 API Key 和 User ID，请先在设置中填写")
    params = {
        "page": "dapi", "s": "post", "q": "index", "json": "1",
        "tags": query, "pid": max(page - 1, 0), "limit": limit,
        "api_key": settings["gelbooru_api_key"], "user_id": settings["gelbooru_user_id"],
    }
    payload = fetch_json("https://gelbooru.com/index.php?" + urllib.parse.urlencode(params))
    rows = payload.get("post", []) if isinstance(payload, dict) else payload
    if not isinstance(rows, list):
        raise ValueError("Gelbooru 返回的数据格式无法识别")
    return [normalized("gelbooru", row) for row in rows if isinstance(row, dict) and normalized("gelbooru", row)["preview_url"]]


def ai_tag(query: str, page: int, limit: int, mode: str) -> list[dict]:
    endpoint = "/api/rank/monthly/real" if mode == "popular" else "/api/ai_works_search"
    params = {"page": page, "page_size": max(60, limit), "q": query}
    if mode != "popular":
        params["sort"] = "new"
    payload = fetch_json(f"https://aitag.win{endpoint}?" + urllib.parse.urlencode(params))
    rows = payload.get("items", []) if isinstance(payload, dict) else []
    if not isinstance(rows, list):
        raise ValueError("AI TAG 返回的数据格式无法识别")
    return [normalized("aitag", row) for row in rows[:limit] if isinstance(row, dict) and row.get("id")]


@online_gallery.get("/api/online-gallery/v2/search")
def search():
    source = request.args.get("source", "danbooru")
    if source not in {"danbooru", "safebooru", "gelbooru", "aitag"}:
        abort(400, "不支持的在线画廊来源")
    query = (request.args.get("q") or "").strip()[:500]
    page = min(max(request.args.get("page", 1, type=int), 1), 10000)
    limit = min(max(request.args.get("limit", 30, type=int), 1), 60)
    mode = "popular" if request.args.get("mode") == "popular" else "search"
    period = request.args.get("period", "week")
    if period not in {"day", "week", "month"}:
        period = "week"
    date = (request.args.get("date") or "").strip()[:10]
    try:
        if source == "aitag":
            items = ai_tag(query, page, limit, mode)
        elif source == "gelbooru":
            items = gelbooru(query, page, limit)
        else:
            items = donmai(source, query, page, limit, mode, period, date)
        return jsonify({"items": items, "page": page, "has_more": len(items) >= limit})
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
        return jsonify({"error": f"在线画廊请求失败：{error}"}), 502


def allowed_image_url(url: str) -> bool:
    parsed = urllib.parse.urlparse(url)
    host = (parsed.hostname or "").lower()
    allowed = ("donmai.us", "gelbooru.com", "aitag.win", "aitag.top")
    return parsed.scheme == "https" and (host in AI_TAG_ASSET_HOSTS or any(host == suffix or host.endswith(f".{suffix}") for suffix in allowed))


@online_gallery.get("/api/online-gallery/v2/image")
def proxy_image():
    """Local allow-listed cache avoids browser CORS/referrer and repeated remote downloads."""
    url = (request.args.get("url") or "").strip()
    if not allowed_image_url(url):
        abort(400, "不允许的图片来源")
    thumb = request.args.get("thumb", "1") != "0"
    ONLINE_CACHE.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(url.encode("utf-8")).hexdigest()
    original = ONLINE_CACHE / f"{digest}.source"
    target = ONLINE_CACHE / f"{digest}.webp" if thumb else original
    try:
        if not original.is_file():
            req = urllib.request.Request(url, headers={"User-Agent": "dean-nai/0.1", "Accept": "image/*"})
            context = ssl.create_default_context(cafile=certifi.where())
            with urllib.request.urlopen(req, timeout=load_settings()["online_timeout"], context=context) as response:
                data = response.read(32 * 1024 * 1024 + 1)
            if len(data) > 32 * 1024 * 1024:
                abort(413)
            original.write_bytes(data)
        if thumb and not target.is_file():
            temporary = target.with_suffix(".tmp.webp")
            with Image.open(original) as source:
                image = ImageOps.exif_transpose(source).convert("RGB")
                image.thumbnail((480, 640), Image.Resampling.LANCZOS)
                image.save(temporary, "WEBP", quality=70, method=4)
            temporary.replace(target)
        return send_file(target, mimetype="image/webp" if thumb else None, conditional=True, max_age=86400)
    except (OSError, ValueError, urllib.error.URLError) as error:
        return jsonify({"error": f"图片代理失败：{error}"}), 502


@online_gallery.get("/api/online-gallery/v2/detail")
def detail():
    source = request.args.get("source", "")
    item_id = request.args.get("id", "")
    if source != "aitag" or not item_id.isdigit():
        abort(400, "当前详情接口只用于 AI TAG")
    with AI_TAG_CACHE_LOCK:
        cached = AI_TAG_DETAIL_CACHE.get(item_id)
        if cached and time.monotonic() - cached[0] < 600:
            return jsonify(cached[1])
    try:
        config = ai_tag_config()
        payload = fetch_json(f"https://aitag.win/api/work/{item_id}")
        if not isinstance(config, dict) or not isinstance(payload, dict):
            raise ValueError("AI TAG 详情格式错误")
        work = payload.get("work") if isinstance(payload.get("work"), dict) else {"id": item_id}
        images = payload.get("images") if isinstance(payload.get("images"), list) else []
        media = []
        asset_base = str(config.get("asset_base_url") or "").rstrip("/")
        asset_host = (urllib.parse.urlparse(asset_base).hostname or "").lower()
        if asset_host:
            AI_TAG_ASSET_HOSTS.add(asset_host)
        for image in images:
            if not isinstance(image, dict):
                continue
            image_type, author_id, file_name = image.get("image_type"), image.get("author_id"), image.get("file_name")
            if not all((image_type, author_id, file_name)):
                continue
            media.append({
                "url": f"{asset_base}/{image_type}/{author_id}/{file_name}.webp",
                "prompt": image.get("prompt_text") or "",
                "raw_metadata": image.get("ai_json") or "",
            })
        if not media:
            abort(404)
        item = normalized("aitag", work)
        raw_metadata = media[0].get("raw_metadata")
        parsed_metadata = {}
        if isinstance(raw_metadata, dict):
            parsed_metadata = raw_metadata
        elif isinstance(raw_metadata, str) and raw_metadata.strip().startswith(("{", "[")):
            try:
                parsed_metadata = json.loads(raw_metadata)
            except json.JSONDecodeError:
                parsed_metadata = {}
        parameters = parsed_metadata.get("parameters", parsed_metadata) if isinstance(parsed_metadata, dict) else {}
        item.update({
            "preview_url": media[0]["url"], "file_url": media[0]["url"],
            "prompt": media[0]["prompt"], "media": media,
            "metadata": {
                "positive_prompt": media[0]["prompt"],
                "negative_prompt": parsed_metadata.get("negative_prompt", parsed_metadata.get("uc", "")) if isinstance(parsed_metadata, dict) else "",
                "parameters": parameters if isinstance(parameters, dict) else {},
            },
        })
        with AI_TAG_CACHE_LOCK:
            if len(AI_TAG_DETAIL_CACHE) >= 256:
                oldest = min(AI_TAG_DETAIL_CACHE, key=lambda key: AI_TAG_DETAIL_CACHE[key][0])
                AI_TAG_DETAIL_CACHE.pop(oldest, None)
            AI_TAG_DETAIL_CACHE[item_id] = (time.monotonic(), item)
        return jsonify(item)
    except (urllib.error.URLError, TimeoutError, ValueError, json.JSONDecodeError) as error:
        return jsonify({"error": f"AI TAG 详情请求失败：{error}"}), 502
