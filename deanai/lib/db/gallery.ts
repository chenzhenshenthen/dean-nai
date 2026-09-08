import { DEFAULT_SETTINGS, type GenerationSettings } from "@/lib/nai/types";

// IndexedDB-backed local generation history. Records retain the full image and
// settings snapshot, so deleted-but-not-purged results can be restored locally.
export type GalleryImage = {
  id?: number;
  dataUrl: string;
  timestamp: string;
  filename: string;
  seed: number;
  settings: GenerationSettings;
  batchId: number;
  batchIndex: number;
  batchSize: number;
  processedWith?: string;
  /** Soft-delete marker used by the in-app recycle bin. */
  deletedAt?: string;
};

const DB_NAME = "nyanovel-images";
const DB_VERSION = 4;
const STORE = "images";
const DELETED_AT_INDEX = "deletedAt";
const TIMESTAMP_INDEX = "timestamp";
export const IMAGE_TRASH_LIMIT = 20;
export const IMAGE_TRASH_PAGE_SIZE = IMAGE_TRASH_LIMIT;
export const ACTIVE_GALLERY_LIMIT = 100;

function pruneTrash(store: IDBObjectStore) {
  const request = store.index(DELETED_AT_INDEX).openKeyCursor(null, "prev");
  let count = 0;
  request.onsuccess = () => {
    const cursor = request.result;
    if (!cursor) return;
    if (++count > IMAGE_TRASH_LIMIT) store.delete(cursor.primaryKey);
    cursor.continue();
  };
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB is not available in this environment"));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "id", autoIncrement: true });
        store.createIndex(DELETED_AT_INDEX, DELETED_AT_INDEX);
        store.createIndex(TIMESTAMP_INDEX, TIMESTAMP_INDEX);
      } else {
        const store = req.transaction?.objectStore(STORE);
        if (store && !store.indexNames.contains(DELETED_AT_INDEX)) {
          store.createIndex(DELETED_AT_INDEX, DELETED_AT_INDEX);
        }
        if (store && !store.indexNames.contains(TIMESTAMP_INDEX)) {
          store.createIndex(TIMESTAMP_INDEX, TIMESTAMP_INDEX);
        }
      }
      // Upgrade also removes old trash, without loading the full image blobs.
      pruneTrash(req.transaction!.objectStore(STORE));
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDB().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction(STORE, mode).objectStore(STORE));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

function hydrate(image: GalleryImage): GalleryImage {
  return { ...image, settings: { ...DEFAULT_SETTINGS, ...image.settings } };
}

/** Active images, newest first. */
export async function loadImages(): Promise<GalleryImage[]> {
  const images = await tx<GalleryImage[]>("readonly", (store) => store.getAll());
  return images
    .filter((image) => !image.deletedAt)
    .map(hydrate)
    .sort((a, b) => +new Date(b.timestamp) - +new Date(a.timestamp))
    .slice(0, ACTIVE_GALLERY_LIMIT);
}

/** Soft-deleted images, most recently deleted first, loaded in small pages. */
export function loadTrashedImages(limit = IMAGE_TRASH_PAGE_SIZE): Promise<GalleryImage[]> {
  limit = Math.min(IMAGE_TRASH_LIMIT, Math.max(1, limit));
  return openDB().then((db) => new Promise<GalleryImage[]>((resolve, reject) => {
    const images: GalleryImage[] = [];
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).index(DELETED_AT_INDEX).openCursor(null, "prev");
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || images.length >= limit) return;
      images.push(hydrate(cursor.value as GalleryImage));
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(images);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

export function countTrashedImages(): Promise<number> {
  return openDB().then((db) => new Promise<number>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readonly");
    const request = transaction.objectStore(STORE).index(DELETED_AT_INDEX).count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
export async function saveImage(image: GalleryImage): Promise<number> {
  const { id: _id, ...rest } = image;
  const clean = { ...rest, deletedAt: undefined, settings: structuredClone(image.settings) };
  const id = await tx<IDBValidKey>("readwrite", (store) => store.add(clean)).then((key) => key as number);
  await trimActiveImages();
  return id;
}

function patchImage(id: number, patch: Partial<GalleryImage>): Promise<void> {
  return openDB().then((db) => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result) {
        const update = store.put({ ...request.result, ...patch });
        if (patch.deletedAt) update.onsuccess = () => pruneTrash(store);
      }
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

export function moveImageToTrash(id: number): Promise<void> {
  return patchImage(id, { deletedAt: new Date().toISOString() });
}

export function restoreTrashedImage(id: number): Promise<void> {
  return patchImage(id, { deletedAt: undefined });
}

export function permanentlyDeleteImage(id: number): Promise<void> {
  return tx("readwrite", (store) => store.delete(id)).then(() => undefined);
}

/** Keep only the newest active generation results. Trashed records are untouched. */
export function trimActiveImages(limit = ACTIVE_GALLERY_LIMIT): Promise<void> {
  return openDB().then((db) => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const trashRequest = store.index(DELETED_AT_INDEX).getAllKeys();
    trashRequest.onsuccess = () => {
      const trashed = new Set(trashRequest.result);
      const cursorRequest = store.index(TIMESTAMP_INDEX).openKeyCursor(null, "prev");
      let activeCount = 0;
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (!trashed.has(cursor.primaryKey)) {
          activeCount += 1;
          if (activeCount > limit) store.delete(cursor.primaryKey);
        }
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    };
    trashRequest.onerror = () => reject(trashRequest.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

/** Permanently delete active history while preserving individually trashed images. */
export function clearActiveImages(): Promise<void> {
  return openDB().then((db) => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const trashRequest = store.index(DELETED_AT_INDEX).getAllKeys();
    trashRequest.onsuccess = () => {
      const trashed = new Set(trashRequest.result);
      const cursorRequest = store.openKeyCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (!trashed.has(cursor.primaryKey)) store.delete(cursor.primaryKey);
        cursor.continue();
      };
      cursorRequest.onerror = () => reject(cursorRequest.error);
    };
    trashRequest.onerror = () => reject(trashRequest.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}
export function moveAllImagesToTrash(): Promise<void> {
  return openDB().then((db) => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.getAll();
    request.onsuccess = () => {
      const deletedAt = new Date().toISOString();
      for (const image of request.result as GalleryImage[]) {
        if (!image.deletedAt) store.put({ ...image, deletedAt });
      }
      pruneTrash(store);
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}

export function emptyImageTrash(): Promise<void> {
  return openDB().then((db) => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    const store = transaction.objectStore(STORE);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      if ((cursor.value as GalleryImage).deletedAt) cursor.delete();
      cursor.continue();
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  }));
}
