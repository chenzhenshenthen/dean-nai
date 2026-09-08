import { toast } from "sonner";
import { loadAppPreferences, saveAppPreferences } from "@/lib/app-preferences";
import { reportClientEvent } from "@/lib/client-log";
import { galleryImageEventId, recordRetainedImage } from "@/lib/generation-counter";

type NativeSaveResult = { ok?: boolean; path?: string; filename?: string; error?: string };
type RetentionIdentity = { id?: number; timestamp: string; filename?: string };
type DesktopBridge = {
  pick_folder?: () => Promise<string | null>;
  save_image?: (dataUrl: string, filename: string, directory: string) => Promise<NativeSaveResult>;
};

function desktopBridge(): DesktopBridge | undefined {
  return (window as typeof window & { pywebview?: { api?: DesktopBridge } }).pywebview?.api;
}

function browserDownload(dataUrl: string, filename: string) {
  const a = document.createElement("a");
  a.href = dataUrl;
  a.download = filename || "dean-nai-image.png";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export async function saveDataUrl(
  dataUrl: string,
  filename: string,
  options: { automatic?: boolean; quiet?: boolean; retentionIdentity?: RetentionIdentity } = {},
): Promise<NativeSaveResult> {
  const bridge = desktopBridge();
  try {
    if (bridge?.save_image) {
      let preferences = loadAppPreferences();
      let directory = preferences.saveDirectory;
      if (!directory && !options.automatic && bridge.pick_folder) {
        directory = (await bridge.pick_folder()) || "";
        if (directory) {
          preferences = saveAppPreferences({ ...preferences, saveDirectory: directory });
        }
      }
      if (!directory) throw new Error("请先在“设置 → 保存与文件名”中选择保存目录。");
      const result = await bridge.save_image(dataUrl, filename, directory);
      if (!result?.ok) throw new Error(result?.error || "Windows 保存接口没有返回成功状态。");
      if (result.path) {
        void fetch("/api/local-gallery/index-file", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ path: result.path }),
        }).catch(() => undefined);
      }
      if (!options.quiet) toast.success(`已保存：${result.filename || filename}`);
      if (options.retentionIdentity) recordRetainedImage(galleryImageEventId(options.retentionIdentity));
      reportClientEvent("image-save", `mode=desktop automatic=${Boolean(options.automatic)} ok=true bytes_base64=${dataUrl.length}`);
      return result;
    }

    browserDownload(dataUrl, filename);
    if (!options.quiet) toast.success(`已交给浏览器下载：${filename}`);
    if (options.retentionIdentity) recordRetainedImage(galleryImageEventId(options.retentionIdentity));
    reportClientEvent("image-save", `mode=browser automatic=${Boolean(options.automatic)} ok=true bytes_base64=${dataUrl.length}`);
    return { ok: true, filename };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportClientEvent("image-save", `mode=${bridge?.save_image ? "desktop" : "browser"} automatic=${Boolean(options.automatic)} ok=false error=${message.slice(0, 500)}`);
    if (!options.quiet) toast.error(`保存失败：${message}`);
    throw error;
  }
}

/** Manual download used by the canvas and lightbox. */
export function downloadDataUrl(dataUrl: string, filename: string, retentionIdentity?: RetentionIdentity) {
  return saveDataUrl(dataUrl, filename, { retentionIdentity });
}

/** Copy an image to the clipboard, falling back to copying the data-url text. */
export async function copyImageToClipboard(dataUrl: string) {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    toast.success("Image copied to clipboard");
  } catch {
    try {
      await navigator.clipboard.writeText(dataUrl);
      toast.success("Image data copied");
    } catch {
      toast.error("Couldn't copy image");
    }
  }
}
/** Re-encode pixels as PNG before copying, intentionally dropping all source metadata. */
export async function copyImageWithoutMetadata(source: string) {
  let bitmap: ImageBitmap | null = null;
  try {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    bitmap = await createImageBitmap(await response.blob());
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("浏览器无法创建图片画布");
    context.drawImage(bitmap, 0, 0);
    const clean = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("图片重新编码失败")), "image/png");
    });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": clean })]);
    toast.success("已复制无元数据图片（PNG）");
  } catch (error) {
    toast.error(`无法复制无元数据图片：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    bitmap?.close();
  }
}