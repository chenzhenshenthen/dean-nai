from __future__ import annotations

import gzip
import json
import re
from io import BytesIO
from pathlib import Path
from typing import Any, BinaryIO

from PIL import Image


METADATA_SCAN_VERSION = 1
MAX_TEXT_LENGTH = 200_000


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        for encoding in ("utf-8", "utf-16", "latin-1"):
            try:
                return value.decode(encoding).strip("\x00\ufeff ")
            except UnicodeDecodeError:
                continue
        return value.decode("utf-8", errors="replace").strip("\x00\ufeff ")
    if isinstance(value, str):
        return value.strip()
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)


def _json(value: Any) -> Any:
    if isinstance(value, (dict, list)):
        return value
    text = _text(value)
    if not text or text[0] not in "[{":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def _first(mapping: dict[str, Any], *names: str) -> Any:
    lowered = {str(key).casefold(): value for key, value in mapping.items()}
    for name in names:
        value = lowered.get(name.casefold())
        if value not in (None, ""):
            return value
    return None


def model_id_from_source(source: Any) -> str:
    value = _text(source).casefold()
    if not value:
        return ""
    if "naiv5" in value or "diffusion v5" in value or "diffusion-5" in value:
        return "nai-diffusion-5-full" if any(marker in value for marker in ("657484a5", "0adf9ab7", "full")) else "nai-diffusion-5-curated"
    if "v4.5" in value or "diffusion-4-5" in value:
        if "curated" in value:
            return "nai-diffusion-4-5-curated"
        if "4bde2a90" in value or "full" in value:
            return "nai-diffusion-4-5-full"
    if "furry" in value and "v3" in value:
        return "nai-diffusion-furry-3"
    if "v4" in value or "diffusion-4" in value:
        return "nai-diffusion-4-curated-preview" if "curated" in value else "nai-diffusion-4-full"
    if "v3" in value or "diffusion-3" in value:
        return "nai-diffusion-3"
    if "furry" in value:
        return "nai-diffusion-furry"
    return ""


def _caption_block(value: Any) -> tuple[str, list[str]]:
    if not isinstance(value, dict):
        return "", []
    caption = value.get("caption", value)
    if not isinstance(caption, dict):
        return _text(caption), []
    base = _text(caption.get("base_caption") or caption.get("caption"))
    characters = []
    for item in caption.get("char_captions") or caption.get("characters") or []:
        if isinstance(item, dict):
            prompt = _text(item.get("char_caption") or item.get("caption") or item.get("prompt"))
        else:
            prompt = _text(item)
        if prompt:
            characters.append(prompt)
    return base, characters


def _parse_webui_parameters(text: str) -> tuple[str, str, dict[str, Any]]:
    marker = "Negative prompt:"
    settings_match = re.search(
        r"(?:^|\n)(Steps:\s*\d+.*)$", text, flags=re.IGNORECASE | re.DOTALL
    )
    body = text[: settings_match.start(1)].rstrip() if settings_match else text.strip()
    settings_text = settings_match.group(1).strip() if settings_match else ""
    if marker.casefold() in body.casefold():
        position = body.casefold().index(marker.casefold())
        positive = body[:position].strip()
        negative = body[position + len(marker):].strip()
    else:
        positive, negative = body, ""
    parameters: dict[str, Any] = {}
    for part in re.split(r",\s*(?=[A-Za-z][A-Za-z _-]*:)", settings_text):
        if ":" not in part:
            continue
        key, value = part.split(":", 1)
        parameters[key.strip()] = value.strip()
    return positive, negative, parameters


def _decode_user_comment(value: Any) -> str:
    if not isinstance(value, bytes):
        return _text(value)
    if value.startswith(b"ASCII\x00\x00\x00"):
        return value[8:].decode("ascii", errors="replace").strip("\x00 ")
    if value.startswith(b"UNICODE\x00"):
        payload = value[8:]
        for encoding in ("utf-16", "utf-16-le", "utf-16-be"):
            try:
                return payload.decode(encoding).strip("\x00\ufeff ")
            except UnicodeDecodeError:
                continue
    return _text(value)


def _extract_stealth(image: Image.Image) -> dict[str, Any] | None:
    if image.format != "PNG" or "A" not in image.getbands():
        return None
    alpha = image.getchannel("A")
    bits = (pixel & 1 for pixel in alpha.getdata())

    def read_bytes(length: int) -> bytes:
        output = bytearray()
        for _ in range(length):
            byte = 0
            for _ in range(8):
                byte = (byte << 1) | next(bits)
            output.append(byte)
        return bytes(output)

    try:
        signature = read_bytes(15).decode("ascii", errors="ignore")
        if signature not in {"stealth_pnginfo", "stealth_pngcomp"}:
            return None
        bit_length = int.from_bytes(read_bytes(4), "big")
        if bit_length <= 0 or bit_length > alpha.width * alpha.height:
            return None
        payload = read_bytes((bit_length + 7) // 8)
        if signature == "stealth_pngcomp":
            payload = gzip.decompress(payload)
        decoded = json.loads(payload.decode("utf-8"))
        return decoded if isinstance(decoded, dict) else {"value": decoded}
    except (EOFError, StopIteration, OSError, ValueError, json.JSONDecodeError):
        return None


def _stat_marker(path: Path | None, byte_length: int | None) -> dict[str, Any]:
    marker: dict[str, Any] = {"version": METADATA_SCAN_VERSION}
    if path is not None:
        try:
            stat = path.stat()
            marker.update({"size": stat.st_size, "mtime_ns": stat.st_mtime_ns})
        except OSError:
            pass
    elif byte_length is not None:
        marker["size"] = byte_length
    return marker


def metadata_is_current(metadata: dict[str, Any] | None, path: Path) -> bool:
    if not isinstance(metadata, dict):
        return False
    marker = metadata.get("_scan")
    if not isinstance(marker, dict) or marker.get("version") != METADATA_SCAN_VERSION:
        return False
    try:
        stat = path.stat()
    except OSError:
        return False
    return marker.get("size") == stat.st_size and marker.get("mtime_ns") == stat.st_mtime_ns


def extract_image_metadata(
    source: Path | str | bytes | bytearray | BinaryIO,
    *,
    include_stealth: bool = False,
) -> dict[str, Any]:
    path: Path | None = None
    byte_length: int | None = None
    if isinstance(source, (str, Path)):
        path = Path(source)
        image_source: Any = path
    elif isinstance(source, (bytes, bytearray)):
        byte_length = len(source)
        image_source = BytesIO(source)
    else:
        image_source = source

    result: dict[str, Any] = {
        "source": "none",
        "positive_prompt": "",
        "negative_prompt": "",
        "characters": [],
        "parameters": {},
        "raw_fields": {},
        "_scan": _stat_marker(path, byte_length),
    }
    with Image.open(image_source) as image:
        raw: dict[str, Any] = {}
        for key, value in image.info.items():
            text = _text(value)
            if text:
                raw[str(key)] = text[:MAX_TEXT_LENGTH]
        try:
            exif = image.getexif()
            if exif:
                user_comment = exif.get(0x9286)
                if user_comment:
                    raw["EXIF UserComment"] = _decode_user_comment(user_comment)[:MAX_TEXT_LENGTH]
        except (AttributeError, OSError, ValueError):
            pass
        if include_stealth and not any(key.casefold() in {"description", "comment", "parameters"} for key in raw):
            stealth = _extract_stealth(image)
            if stealth:
                raw["stealth_png"] = json.dumps(stealth, ensure_ascii=False)[:MAX_TEXT_LENGTH]

    result["raw_fields"] = raw
    comment_value = _first(raw, "Comment")
    comment = _json(comment_value)
    description = _text(_first(raw, "Description", "prompt"))
    webui = _text(_first(raw, "parameters", "EXIF UserComment"))
    stealth = _json(raw.get("stealth_png"))

    if isinstance(comment, dict):
        result["source"] = "NovelAI"
        positive = _text(_first(comment, "prompt", "description", "input")) or description
        negative = _text(_first(comment, "uc", "negative_prompt", "negative prompt"))
        v4_positive, characters = _caption_block(comment.get("v4_prompt"))
        v4_negative, negative_characters = _caption_block(comment.get("v4_negative_prompt"))
        result["positive_prompt"] = v4_positive or positive
        result["negative_prompt"] = v4_negative or negative
        result["characters"] = characters
        if negative_characters:
            result["negative_characters"] = negative_characters
        ignored = {"prompt", "description", "input", "uc", "negative_prompt", "v4_prompt", "v4_negative_prompt"}
        result["parameters"] = {
            key: value for key, value in comment.items()
            if key not in ignored and isinstance(value, (str, int, float, bool))
        }
        model = model_id_from_source(_first(raw, "Source"))
        if model:
            result["parameters"].setdefault("model", model)
    elif isinstance(stealth, dict):
        result["source"] = "stealth_png"
        result["positive_prompt"] = _text(_first(stealth, "prompt", "description"))
        result["negative_prompt"] = _text(_first(stealth, "negative_prompt", "uc"))
        result["parameters"] = {
            key: value for key, value in stealth.items()
            if key not in {"prompt", "description", "negative_prompt", "uc"}
            and isinstance(value, (str, int, float, bool))
        }
    elif webui:
        positive, negative, parameters = _parse_webui_parameters(webui)
        result.update({
            "source": "WebUI/EXIF",
            "positive_prompt": positive or description,
            "negative_prompt": negative,
            "parameters": parameters,
        })
    elif description:
        result.update({"source": "image text", "positive_prompt": description})

    result["has_prompt"] = bool(result["positive_prompt"] or result["negative_prompt"] or result["characters"])
    return result
