import { toast } from "sonner";
import type { GalleryImage } from "@/lib/db/gallery";
import { navigateDesktopWorkspace } from "@/lib/workspace-navigation";

type LibraryKind = "artist" | "prompt";

const LIBRARY_URL = process.env.NEXT_PUBLIC_NAI_LIBRARY_URL || "http://127.0.0.1:5179";
const IS_DESKTOP = process.env.NEXT_PUBLIC_LOCAL_DESKTOP === "1";

export async function openLibraryDraft(
  kind: LibraryKind,
  content: string,
  image: GalleryImage | null,
  negativePrompt = "",
) {
  const trimmed = content.trim();
  if (!trimmed) {
    toast.error(kind === "artist" ? "画师串还是空的。" : "场景提示词还是空的。");
    return;
  }

  const requestId = crypto.randomUUID();
  const destination = new URL("/library", LIBRARY_URL);
  destination.searchParams.set("nyanovel_import", requestId);
  const targetOrigin = destination.origin;
  let editorWindow: Window | null = null;
  let sent = false;

  const payload = {
    type: "nyanovel-library-import",
    requestId,
    kind,
    content: trimmed,
    negativePrompt: kind === "artist" ? negativePrompt.trim() : "",
    image: image ? { dataUrl: image.dataUrl, filename: image.filename || `deanai_${Date.now()}_1.png` } : null,
  };

  if (IS_DESKTOP) {
    try {
      const response = await fetch("/api/library/import-drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const libraryPath = "/library-embed/?nyanovel_import=" + encodeURIComponent(requestId);
      if (!navigateDesktopWorkspace("library", libraryPath)) window.location.assign(libraryPath);
    } catch (error) {
      toast.error("无法打开资料库新增页：" + (error instanceof Error ? error.message : String(error)));
    }
    return;
  }

  let expiryTimer = 0;
  const cleanup = () => {
    window.removeEventListener("message", onMessage);
    window.clearTimeout(expiryTimer);
  };
  const send = () => {
    if (sent || !editorWindow || editorWindow.closed) return;
    sent = true;
    editorWindow.postMessage(payload, targetOrigin);
  };
  const onMessage = (event: MessageEvent) => {
    if (event.origin !== targetOrigin || event.source !== editorWindow || event.data?.requestId !== requestId) return;
    if (event.data.type === "nya-library-ready") send();
    if (event.data.type === "nya-library-imported") {
      cleanup();
    }
    if (event.data.type === "nya-library-import-error") {
      cleanup();
      toast.error(event.data.message || "无法把内容带入资料库。");
    }
  };

  window.addEventListener("message", onMessage);
  editorWindow = window.open(destination, "nai-artist-library-editor");
  if (!editorWindow) {
    cleanup();
    toast.error("浏览器拦截了资料库窗口，请允许本站打开弹窗。");
    return;
  }

  expiryTimer = window.setTimeout(() => {
    cleanup();
    toast.error("资料库没有响应，请确认本地资料库已经启动。");
  }, 30_000);
}
