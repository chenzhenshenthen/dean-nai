"use client";

import { useMemo, useState } from "react";
import { motion } from "motion/react";
import { AlertTriangle, ImageOff, PanelRightClose, Recycle, RotateCcw, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import { useStore } from "@/lib/store";
import { listContainer } from "@/lib/motion";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { PanelHeader } from "@/components/ui/panel-header";
import { GalleryTile } from "./gallery-tile";
import {
  countTrashedImages,
  emptyImageTrash,
  IMAGE_TRASH_PAGE_SIZE,
  loadTrashedImages,
  permanentlyDeleteImage,
  restoreTrashedImage,
  type GalleryImage,
} from "@/lib/db/gallery";

function groupByBatch(images: GalleryImage[]) {
  const batches = new Map<number, GalleryImage[]>();
  for (const img of images) {
    const batch = batches.get(img.batchId) ?? [];
    batch.push(img);
    batches.set(img.batchId, batch);
  }
  return [...batches.values()].map((batch) => {
    const representative = batch.reduce((first, image) => image.batchIndex < first.batchIndex ? image : first);
    const siblings = [...batch].sort((a, b) => a.batchIndex - b.batchIndex);
    return { ...representative, count: batch.length, siblings };
  });
}

export function GalleryPanel() {
  const images = useStore((state) => state.images);
  const status = useStore((state) => state.galleryStatus);
  const galleryError = useStore((state) => state.galleryError);
  const selectedBatchId = useStore((state) => state.selectedBatch?.[0]?.batchId ?? null);
  const selectBatch = useStore((state) => state.selectBatch);
  const clearGallery = useStore((state) => state.clearGallery);
  const loadGallery = useStore((state) => state.loadGallery);
  const restoreSettings = useStore((state) => state.restoreSettings);
  const patchSettings = useStore((state) => state.patchSettings);
  const setUI = useStore((state) => state.setUI);
  const [confirmClear, setConfirmClear] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [trash, setTrash] = useState<GalleryImage[]>([]);
  const [trashTotal, setTrashTotal] = useState(0);
  const [trashBusy, setTrashBusy] = useState(false);

  const groups = useMemo(() => groupByBatch(images), [images]);
  const openBatch = (batchId: number) => {
    selectBatch(batchId, true);
    if (window.matchMedia("(max-width: 1279px)").matches) setUI({ galleryOpen: false });
  };

  async function openTrash() {
    setTrashOpen(true);
    setTrashBusy(true);
    try {
      const [items, total] = await Promise.all([loadTrashedImages(), countTrashedImages()]);
      setTrash(items);
      setTrashTotal(total);
    }
    catch (error) { toast.error(`无法读取回收站：${error instanceof Error ? error.message : String(error)}`); }
    finally { setTrashBusy(false); }
  }

  async function restore(image: GalleryImage) {
    if (image.id === undefined) return;
    try {
      await restoreTrashedImage(image.id);
      setTrash((current) => current.filter((item) => item.id !== image.id));
      setTrashTotal((current) => Math.max(0, current - 1));
      await loadGallery();
      toast.success("图片已恢复到生图历史");
    } catch (error) {
      toast.error(`恢复失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function removePermanently(image: GalleryImage) {
    if (image.id === undefined || !window.confirm("永久删除这张图片？此操作无法撤销。")) return;
    try {
      await permanentlyDeleteImage(image.id);
      setTrash((current) => current.filter((item) => item.id !== image.id));
      setTrashTotal((current) => Math.max(0, current - 1));
      toast.success("图片已永久删除");
    } catch (error) {
      toast.error(`永久删除失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function emptyTrash() {
    if (!trashTotal || !window.confirm(`永久删除回收站中的 ${trashTotal} 张图片？此操作无法撤销。`)) return;
    setTrashBusy(true);
    try {
      await emptyImageTrash();
      setTrash([]);
      setTrashTotal(0);
      toast.success("内部回收站已清空");
    } catch (error) {
      toast.error(`清空失败：${error instanceof Error ? error.message : String(error)}`);
    } finally { setTrashBusy(false); }
  }

  async function loadMoreTrash() {
    setTrashBusy(true);
    try {
      setTrash(await loadTrashedImages(trash.length + IMAGE_TRASH_PAGE_SIZE));
    } catch (error) {
      toast.error("无法继续读取回收站：" + (error instanceof Error ? error.message : String(error)));
    } finally { setTrashBusy(false); }
  }
  return (
    <div className="flex h-full flex-col">
      <PanelHeader
        title="生图历史"
        subtitle={status === "ready"
          ? `${groups.length} 批 · ${images.length} 张`
          : "本地临时历史"}
        actions={<>
          <IconButton label="内部回收站" title="内部回收站" size="sm" onClick={() => void openTrash()}>
            <Recycle />
          </IconButton>
          {status === "ready" && images.length > 0 && (
            <IconButton label="永久删除全部生图历史" title="永久删除全部生图历史" size="sm" onClick={() => setConfirmClear(true)} className="hover:text-danger">
              <Trash2 />
            </IconButton>
          )}
          <IconButton label="收起生图历史" size="sm" title="收起生图历史 — ]" onClick={() => setUI({ galleryOpen: false })}>
            <PanelRightClose />
          </IconButton>
        </>}
      />

      {status === "loading" ? (
        <div className="min-h-0 flex-1 overflow-hidden p-2.5"><div className="grid grid-cols-2 gap-2">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="motion-keep aspect-square rounded-[10px]" style={{ background: "linear-gradient(90deg, var(--surface-2) 25%, var(--surface-3) 50%, var(--surface-2) 75%)", backgroundSize: "460px 100%", animation: "shimmer 1.4s linear infinite" }} />)}
        </div></div>
      ) : status === "error" ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
          <AlertTriangle className="size-6 text-danger" />
          <div><p className="text-[13px] font-semibold text-fg">无法打开本地生图历史存储</p><p className="mt-1 text-[12px] text-muted">{galleryError}</p></div>
          <Button size="sm" variant="secondary" onClick={() => void loadGallery()}><RotateCcw className="size-4" /> 重试</Button>
        </div>
      ) : groups.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center"><ImageOff className="size-6 text-muted" /><p className="text-[12.5px] text-muted">生成结果会显示在这里。</p></div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto p-2.5">
          <motion.div className="columns-2 gap-2" variants={listContainer} initial="hidden" animate="show">
            {groups.map((group) => <GalleryTile key={group.batchId} batch={group} selected={group.batchId === selectedBatchId} onOpen={() => openBatch(group.batchId)} onRestore={() => restoreSettings(group.settings)} onUseSeed={() => patchSettings({ seed: group.seed })} />)}
          </motion.div>
        </div>
      )}

      <Modal open={confirmClear} onClose={() => setConfirmClear(false)} title="永久删除全部生图历史？" description={`直接删除右侧历史中的 ${images.length} 张图片，不进入内部回收站；不会删除已下载到本地画廊的文件。`} className="max-w-sm">
        <div className="flex justify-end gap-2"><Button variant="ghost" onClick={() => setConfirmClear(false)}>取消</Button><Button variant="destructive" onClick={() => { void clearGallery(); setConfirmClear(false); }}><Trash2 className="size-4" />永久删除</Button></div>
      </Modal>

      <Modal open={trashOpen} onClose={() => { setTrashOpen(false); setTrash([]); }} title="内部回收站" description={`仅保留最近 ${IMAGE_TRASH_PAGE_SIZE} 张；更早的记录自动永久清除，不影响已下载的本地画廊文件。`} className="flex max-h-[85vh] max-w-3xl flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto">
          {trashBusy ? <p className="py-10 text-center text-sm text-muted">正在读取回收站……</p> : trash.length === 0 ? <p className="py-10 text-center text-sm text-muted">回收站是空的。</p> : <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
            {trash.map((image) => <article key={image.id} className="overflow-hidden rounded-xl border border-border-soft bg-surface-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={image.dataUrl} alt="" className="aspect-square w-full object-cover" />
              <div className="p-2"><p className="truncate text-[11px]" title={image.filename}>{image.filename}</p><p className="mt-0.5 text-[10px] text-muted">{image.deletedAt ? new Date(image.deletedAt).toLocaleString() : ""}</p><div className="mt-2 flex gap-1"><Button className="min-w-0 flex-1" size="sm" variant="outline" onClick={() => void restore(image)}><Undo2 className="size-3.5" />恢复</Button><IconButton size="sm" label="永久删除" className="hover:text-danger" onClick={() => void removePermanently(image)}><Trash2 /></IconButton></div></div>
            </article>)}
          </div>}
        </div>
        {trashTotal > 0 && <div className="mt-4 flex items-center justify-between gap-3 border-t border-border-soft pt-4"><span className="text-xs text-muted">已加载 {trash.length} / {trashTotal}</span><div className="flex gap-2">{trash.length < trashTotal && <Button variant="secondary" disabled={trashBusy} onClick={() => void loadMoreTrash()}>再加载 {IMAGE_TRASH_PAGE_SIZE} 张</Button>}<Button variant="destructive" disabled={trashBusy} onClick={() => void emptyTrash()}><Trash2 className="size-4" />永久清空</Button></div></div>}
      </Modal>
    </div>
  );
}
