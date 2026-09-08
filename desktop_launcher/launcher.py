from __future__ import annotations

import base64
import binascii
import json
import logging
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path


APP_NAME = "dean-nai"
APP_URL = "http://127.0.0.1:5179"
CREATE_NO_WINDOW = 0x08000000
EXPORT_ENDPOINTS = {
    "/api/export/json",
    "/api/export/mobile.json",
    "/api/export/artists.csv",
}


def prepare_log_dir(root: Path) -> tuple[Path, str]:
    """Use one folder per calendar day and remove only validated expired day folders."""
    log_root = (root / "logs").resolve()
    log_root.mkdir(parents=True, exist_ok=True)
    retention_raw = "30"
    settings_path = root / "nai-artist-library" / "data" / "integrated-settings.json"
    try:
        saved_settings = json.loads(settings_path.read_text(encoding="utf-8"))
        retention_raw = str(saved_settings.get("log_retention_days", retention_raw))
    except (OSError, ValueError, TypeError):
        pass
    retention_raw = os.environ.get("DEAN_NAI_LOG_RETENTION_DAYS", retention_raw)
    try:
        retention_days = min(3650, max(1, int(retention_raw)))
    except ValueError:
        retention_days = 30
    cutoff = datetime.now() - timedelta(days=retention_days)
    for candidate in log_root.iterdir():
        if not candidate.is_dir() or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", candidate.name):
            continue
        resolved = candidate.resolve()
        if resolved.parent != log_root:
            continue
        try:
            day = datetime.strptime(candidate.name, "%Y-%m-%d")
        except ValueError:
            continue
        if day < cutoff:
            shutil.rmtree(resolved, ignore_errors=True)
    day_dir = log_root / datetime.now().strftime("%Y-%m-%d")
    day_dir.mkdir(parents=True, exist_ok=True)
    run_id = f"desktop-{datetime.now().strftime('%H%M%S-%f')[:-3]}-{os.getpid()}"
    (log_root / "latest-session.txt").write_text(str(day_dir), encoding="utf-8")
    return day_dir, run_id


def find_project_root() -> Path:
    starts = [Path.cwd()]
    starts.append(Path(sys.executable).resolve().parent if getattr(sys, "frozen", False) else Path(__file__).resolve().parent)
    checked: set[Path] = set()
    for start in starts:
        for candidate in (start, *start.parents):
            candidate = candidate.resolve()
            if candidate in checked:
                continue
            checked.add(candidate)
            if (candidate / "deanai" / "desktop-web-dist" / "index.html").is_file() and (
                candidate / "nai-artist-library" / "app.py"
            ).is_file():
                return candidate
    raise RuntimeError("找不到桌面版文件。请把 dean-nai.exe 放在项目根目录，并先运行桌面构建脚本。")


def page_contains(url: str, marker: str, timeout: float = 1.5) -> bool:
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "dean-nai/0.1"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return marker in response.read(512_000).decode("utf-8", errors="replace")
    except (OSError, urllib.error.URLError):
        return False


def port_open(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as client:
        client.settimeout(0.4)
        return client.connect_ex(("127.0.0.1", port)) == 0


def stop_process_tree(process: subprocess.Popen[str]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=False,
            creationflags=CREATE_NO_WINDOW,
        )
    else:
        process.terminate()


def start_backend(root: Path, log_dir: Path, run_id: str) -> tuple[subprocess.Popen[str], object]:
    if page_contains(APP_URL, "dean-nai"):
        raise RuntimeError("端口 5179 已有 dean-nai 在运行。请直接用浏览器打开，或先关闭旧实例。")
    if port_open(5179):
        raise RuntimeError("端口 5179 被其他程序占用，请关闭占用程序后重试。")
    python = shutil.which("python")
    if not python:
        raise RuntimeError("PATH 中找不到 Python 3。")
    log_handle = (log_dir / "nai-artist-library.log").open("a", encoding="utf-8", buffering=1)
    log_handle.write(f"[{datetime.now().isoformat(timespec='milliseconds')}] [run:{run_id}] [launcher] desktop backend starting\n")
    environment = os.environ.copy()
    environment.update({"NYA_UNIFIED_DESKTOP": "1", "NAI_LIBRARY_NO_BROWSER": "1", "NAI_LIBRARY_PORT": "5179"})
    process = subprocess.Popen(
        [python, "app.py"],
        cwd=root / "nai-artist-library",
        env=environment,
        stdout=log_handle,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATE_NO_WINDOW if os.name == "nt" else 0,
    )
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        if process.poll() is not None:
            log_handle.close()
            raise RuntimeError(f"本地服务启动失败（退出码 {process.returncode}）。日志：{log_dir}")
        if page_contains(APP_URL, "dean-nai"):
            return process, log_handle
        time.sleep(0.35)
    stop_process_tree(process)
    log_handle.close()
    raise RuntimeError(f"本地服务启动超时。日志：{log_dir}")


def show_error(message: str) -> None:
    logging.exception(message)
    if os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, message, f"{APP_NAME} 启动失败", 0x10)


class DesktopApi:
    def __init__(self) -> None:
        # Leading underscore keeps the native Window object out of pywebview's JS bridge
        # serializer; exposing it recursively walks WebView2 COM objects.
        self._window = None

    def attach(self, window: object) -> None:
        self._window = window

    def pick_folder(self) -> str | None:
        if self._window is None:
            return None
        from webview import FileDialog
        selected = self._window.create_file_dialog(FileDialog.FOLDER)  # type: ignore[attr-defined]
        return str(selected[0]) if selected else None

    def _save_bytes(self, payload: bytes, filename: str, file_types: tuple[str, ...]) -> dict[str, object]:
        if self._window is None:
            return {"ok": False, "error": "桌面窗口尚未初始化。"}
        from webview import FileDialog
        safe_name = Path(filename or "dean-nai-export.bin").name
        selected = self._window.create_file_dialog(  # type: ignore[attr-defined]
            FileDialog.SAVE,
            save_filename=safe_name,
            file_types=file_types,
        )
        if not selected:
            return {"ok": False, "cancelled": True}
        target = Path(selected[0]).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.parent / f".{target.name}.{os.getpid()}.tmp"
        try:
            temporary.write_bytes(payload)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        logging.info("export saved filename=%s bytes=%s", target.name, len(payload))
        return {"ok": True, "path": str(target), "filename": target.name}

    def _emit_export_progress(self, phase: str, current: int = 0, total: int = 0) -> None:
        if self._window is None:
            return
        detail = json.dumps({"phase": phase, "current": current, "total": total}, ensure_ascii=False)
        try:
            self._window.evaluate_js(  # type: ignore[attr-defined]
                f"window.dispatchEvent(new CustomEvent('deanai-export-save-progress',{{detail:{detail}}}))"
            )
        except Exception:
            logging.debug("could not emit export progress", exc_info=True)

    def _save_response(self, response, filename: str, file_types: tuple[str, ...]) -> dict[str, object]:
        if self._window is None:
            return {"ok": False, "error": "桌面窗口尚未初始化。"}
        from webview import FileDialog
        safe_name = Path(filename or "dean-nai-export.bin").name
        selected = self._window.create_file_dialog(  # type: ignore[attr-defined]
            FileDialog.SAVE,
            save_filename=safe_name,
            file_types=file_types,
        )
        if not selected:
            self._emit_export_progress("cancelled")
            return {"ok": False, "cancelled": True}
        target = Path(selected[0]).expanduser().resolve()
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.parent / f".{target.name}.{os.getpid()}.tmp"
        try:
            total = int(response.headers.get("Content-Length") or 0)
        except (TypeError, ValueError):
            total = 0
        written = 0
        self._emit_export_progress("saving", written, total)
        try:
            with temporary.open("wb") as output:
                while True:
                    chunk = response.read(4 * 1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
                    written += len(chunk)
                    self._emit_export_progress("saving", written, total)
            os.replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
        self._emit_export_progress("complete", written, total or written)
        logging.info("export streamed filename=%s bytes=%s", target.name, written)
        return {"ok": True, "path": str(target), "filename": target.name, "bytes": written}

    def save_export(self, endpoint: str) -> dict[str, object]:
        """Stream a known local export endpoint to disk through a native Save dialog."""
        try:
            parsed = urllib.parse.urlsplit(str(endpoint or ""))
            path = parsed.path.rstrip("/") or "/"
            mobile_job_download = re.fullmatch(r"/api/export/mobile/jobs/[0-9a-f]{32}/download", path)
            if path not in EXPORT_ENDPOINTS and not mobile_job_download:
                raise ValueError("不允许保存这个导出地址。")
            url = APP_URL + path + (("?" + parsed.query) if parsed.query else "")
            self._emit_export_progress("connecting")
            with urllib.request.urlopen(url, timeout=3600) as response:
                filename = response.headers.get_filename() or Path(path).name or "dean-nai-export.bin"
                content_type = response.headers.get_content_type()
                file_types = {
                    "application/json": ("JSON files (*.json)", "All files (*.*)"),
                    "text/csv": ("CSV files (*.csv)", "All files (*.*)"),
                }.get(content_type, ("All files (*.*)",))
                return self._save_response(response, filename, file_types)
        except Exception as error:
            self._emit_export_progress("failed")
            logging.exception("export save failed endpoint=%s", endpoint)
            return {"ok": False, "error": str(error)}
    def save_mobile_incremental(self, scope: str, manifest: dict) -> dict[str, object]:
        """Compatibility bridge for older web bundles; stream without a package size limit."""
        try:
            if scope not in {"local", "external"} or not isinstance(manifest, dict):
                raise ValueError("增量导出参数无效。")
            body = json.dumps({"manifest": manifest}, ensure_ascii=False).encode("utf-8")
            request = urllib.request.Request(
                f"{APP_URL}/api/export/mobile.json?scope={scope}&mode=incremental",
                data=body,
                headers={"Content-Type": "application/json"},
                method="POST",
            )
            self._emit_export_progress("connecting")
            with urllib.request.urlopen(request, timeout=3600) as response:
                filename = response.headers.get_filename() or "deanai-mobile-incremental.json"
                return self._save_response(
                    response, filename, ("JSON files (*.json)", "All files (*.*)"),
                )
        except Exception as error:
            self._emit_export_progress("failed")
            logging.exception("incremental mobile export failed scope=%s", scope)
            return {"ok": False, "error": str(error)}
    def save_text(self, content: str, filename: str) -> dict[str, object]:
        try:
            payload = str(content or "").encode("utf-8")
            if len(payload) > 50 * 1024 * 1024:
                raise ValueError("文本导出超过 50 MiB 上限。")
            return self._save_bytes(payload, filename, ("Markdown files (*.md)", "Text files (*.txt)", "All files (*.*)"))
        except Exception as error:
            logging.exception("text save failed filename=%s", filename)
            return {"ok": False, "error": str(error)}

    def show_in_folder(self, path_text: str) -> bool:
        path = Path(path_text).expanduser().resolve()
        if not path.exists() or os.name != "nt":
            return False
        subprocess.Popen(["explorer.exe", "/select,", str(path)])
        return True

    def save_image(self, data_url: str, filename: str, directory: str) -> dict[str, object]:
        """Persist a generated image without relying on WebView2 download handling."""
        try:
            target_dir = Path(directory).expanduser().resolve()
            if not target_dir.is_dir():
                raise ValueError("保存目录不存在，请在设置中重新选择。")
            if not isinstance(data_url, str) or "," not in data_url:
                raise ValueError("图片数据格式无效。")
            header, encoded = data_url.split(",", 1)
            if ";base64" not in header.lower():
                raise ValueError("图片不是受支持的 base64 数据。")
            try:
                payload = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as error:
                raise ValueError("图片 base64 数据损坏。") from error
            if not payload or len(payload) > 100 * 1024 * 1024:
                raise ValueError("图片为空或超过 100 MiB 保存上限。")

            safe_name = Path(str(filename or "dean-nai-image.png")).name
            safe_name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "-", safe_name).rstrip(". ")
            if not safe_name.lower().endswith(".png"):
                safe_name = f"{safe_name}.png"
            if not safe_name:
                safe_name = "dean-nai-image.png"

            candidate = target_dir / safe_name
            stem, suffix = candidate.stem, candidate.suffix
            collision = 2
            while candidate.exists():
                candidate = target_dir / f"{stem} ({collision}){suffix}"
                collision += 1

            temporary = target_dir / f".{candidate.name}.{os.getpid()}.tmp"
            try:
                temporary.write_bytes(payload)
                os.replace(temporary, candidate)
            finally:
                temporary.unlink(missing_ok=True)
            logging.info(
                "image saved filename=%s bytes=%s directory=%s",
                candidate.name,
                len(payload),
                target_dir,
            )
            return {"ok": True, "path": str(candidate), "filename": candidate.name}
        except Exception as error:
            logging.exception("image save failed filename=%s directory=%s", filename, directory)
            return {"ok": False, "error": str(error)}

    def toggle_fullscreen(self) -> bool:
        """Toggle immersive fullscreen from the in-app control."""
        if self._window is None:
            return False
        self._window.toggle_fullscreen()  # type: ignore[attr-defined]
        return True


def close_smoke_test(window: object) -> None:
    time.sleep(2)
    title = window.evaluate_js("document.title")  # type: ignore[attr-defined]
    storage = window.evaluate_js(  # type: ignore[attr-defined]
        "localStorage.setItem('nya-desktop-smoke','ok'); localStorage.getItem('nya-desktop-smoke')"
    )
    picker = window.evaluate_js("typeof window.pywebview?.api?.pick_folder")  # type: ignore[attr-defined]
    saver = window.evaluate_js("typeof window.pywebview?.api?.save_image")  # type: ignore[attr-defined]
    logging.info(
        "smoke test title=%s localStorage=%s folderPicker=%s imageSaver=%s",
        title,
        storage,
        picker,
        saver,
    )
    window.destroy()  # type: ignore[attr-defined]


def main() -> int:
    process: subprocess.Popen[str] | None = None
    log_handle = None
    try:
        root = find_project_root()
        log_dir, run_id = prepare_log_dir(root)
        logging.basicConfig(
            filename=log_dir / "dean-nai-desktop.log", level=logging.INFO, encoding="utf-8",
            format=f"[%(asctime)s] [run:{run_id}] [%(levelname)s] %(message)s",
        )
        logging.info("desktop launcher starting; logs=%s", log_dir)
        process, log_handle = start_backend(root, log_dir, run_id)
        import webview
        desktop_api = DesktopApi()
        window = webview.create_window(
            APP_NAME,
            url=APP_URL,
            js_api=desktop_api,
            width=1460,
            height=920,
            min_size=(960, 640),
            background_color="#090c12",
            maximized=True,
        )
        desktop_api.attach(window)
        options = {"debug": False, "private_mode": False, "storage_path": str(root / ".desktop-webview")}
        if os.environ.get("NYA_DESKTOP_SMOKE_TEST") == "1":
            webview.start(close_smoke_test, [window], **options)
        else:
            webview.start(**options)
        return 0
    except Exception as reason:
        show_error(str(reason))
        return 1
    finally:
        if process is not None:
            stop_process_tree(process)
        if log_handle is not None:
            log_handle.close()


if __name__ == "__main__":
    raise SystemExit(main())
