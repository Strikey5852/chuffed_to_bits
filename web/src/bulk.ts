import JSZip from "jszip";
import {
  convertImage,
  upscalePreview,
  type ConvertOptions,
  type Rgb,
  type Size,
} from "./converter.ts";

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Global (dock) defaults. Edits here flow to items without an override. */
export interface GlobalSettings {
  sizeAuto: boolean;
  size: Size;
  borderAuto: boolean;
  border: Rgb;
  sharpen: number;
  threshold: number;
  upscale: number;
}

export type BulkStatus = "loading" | "ready" | "error";

export interface BulkItem {
  id: string;
  file: File | null;
  name: string;
  img: HTMLImageElement | null;
  thumbUrl: string;
  /** Only keys the user tweaked for this image; empty = follow globals. */
  override: Partial<GlobalSettings>;
  /** Per-image crop position; never bulk-copied. */
  crop: CropRect | null;
  result: HTMLCanvasElement | null;
  resultSize: Size | null;
  resultBorder: Rgb | null;
  status: BulkStatus;
  error?: string;
}

let idCounter = 0;
const makeId = (): string =>
  `bulk-${Date.now().toString(36)}-${(idCounter += 1)}`;

export const bulkQueue: BulkItem[] = [];
export let selectedId: string | null = null;

export function setSelectedId(id: string | null): void {
  selectedId = id;
}

export function getSelected(): BulkItem | null {
  if (!selectedId) return null;
  return bulkQueue.find((i) => i.id === selectedId) ?? null;
}

/** Merge globals with per-item overrides. */
export function resolveOptions(
  globals: GlobalSettings,
  item: BulkItem,
): ConvertOptions & { upscale: number } {
  const o = item.override;
  return {
    sizeAuto: o.sizeAuto ?? globals.sizeAuto,
    size: o.size ?? globals.size,
    borderAuto: o.borderAuto ?? globals.borderAuto,
    border: o.border ?? globals.border,
    sharpen: o.sharpen ?? globals.sharpen,
    threshold: o.threshold ?? globals.threshold,
    upscale: o.upscale ?? globals.upscale,
    crop: item.crop,
  };
}

export function hasOverrides(item: BulkItem): boolean {
  return Object.keys(item.override).length > 0;
}

export function overrideKeys(item: BulkItem): string[] {
  return Object.keys(item.override);
}

/** Clear per-image tweaks (and custom crop) so the item follows globals. */
export function resetItemToDefaults(item: BulkItem): void {
  item.override = {};
  item.crop = null;
}

/** Clear tweaks/crops on every item in the queue. */
export function resetAllToDefaults(): void {
  for (const item of bulkQueue) {
    resetItemToDefaults(item);
  }
}

function baseName(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, "") || "chuffed-to-bits";
}

const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif"];

function looksLikeImage(name: string, mime: string): boolean {
  if (mime.startsWith("image/")) return true;
  const lower = name.toLowerCase();
  return IMAGE_EXTS.some((ext) => lower.endsWith(ext));
}

/** Unpack image entries from a ZIP; skips junk, caps at 100 entries. */
export async function unpackZipImages(zipFile: File): Promise<File[]> {
  const zip = await JSZip.loadAsync(zipFile);
  const out: File[] = [];
  const names = Object.keys(zip.files).sort();
  for (const name of names) {
    if (out.length >= 100) break;
    const entry = zip.files[name];
    if (!entry || entry.dir) continue;
    const short = name.split("/").pop() ?? name;
    if (!short || short.startsWith(".") || short === "__MACOSX") continue;
    if (name.toLowerCase().endsWith(".zip")) continue;
    const blob = await entry.async("blob");
    const mime = blob.type || "image/png";
    if (!looksLikeImage(short, mime)) continue;
    out.push(new File([blob], short, { type: mime.startsWith("image/") ? mime : "image/png" }));
  }
  return out;
}

export function loadImageFile(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`could not decode ${file.name}`));
    };
    img.src = url;
  });
}

export function loadImageUrl(
  url: string,
  label: string,
): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${label}`));
    img.src = url;
  });
}

/** Add files to the queue; returns created items (loading async). */
export function addFiles(
  files: File[],
  thumbFor: (img: HTMLImageElement) => string,
  onChange: () => void,
): BulkItem[] {
  const created: BulkItem[] = [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    const item: BulkItem = {
      id: makeId(),
      file,
      name: baseName(file.name),
      img: null,
      thumbUrl: "",
      override: {},
      crop: null,
      result: null,
      resultSize: null,
      resultBorder: null,
      status: "loading",
    };
    bulkQueue.push(item);
    created.push(item);
    void loadImageFile(file)
      .then((img) => {
        item.img = img;
        item.thumbUrl = thumbFor(img);
        item.status = "ready";
        onChange();
      })
      .catch((err: unknown) => {
        item.status = "error";
        item.error = err instanceof Error ? err.message : String(err);
        onChange();
      });
  }
  if (created.length > 0 && selectedId === null) {
    selectedId = created[0]?.id ?? null;
  }
  onChange();
  return created;
}

/** Add an already-decoded image (samples). */
export function addImage(
  img: HTMLImageElement,
  name: string,
  thumbUrl: string,
): BulkItem {
  const item: BulkItem = {
    id: makeId(),
    file: null,
    name,
    img,
    thumbUrl,
    override: {},
    crop: null,
    result: null,
    resultSize: null,
    resultBorder: null,
    status: "ready",
  };
  bulkQueue.push(item);
  if (selectedId === null) selectedId = item.id;
  return item;
}

export function removeItem(id: string): void {
  const idx = bulkQueue.findIndex((i) => i.id === id);
  if (idx === -1) return;
  const [item] = bulkQueue.splice(idx, 1);
  if (item && item.thumbUrl.startsWith("blob:")) {
    URL.revokeObjectURL(item.thumbUrl);
  }
  if (selectedId === id) {
    selectedId = bulkQueue[0]?.id ?? null;
  }
}

export function clearQueue(): void {
  for (const item of bulkQueue) {
    if (item.thumbUrl.startsWith("blob:")) {
      try {
        URL.revokeObjectURL(item.thumbUrl);
      } catch {
        /* ignore */
      }
    }
  }
  bulkQueue.length = 0;
  selectedId = null;
}

/** Re-run conversion for one item with resolved options. */
export function processItem(
  item: BulkItem,
  globals: GlobalSettings,
): boolean {
  if (!item.img || item.status === "loading") return false;
  try {
    const opts = resolveOptions(globals, item);
    const out = convertImage(item.img, {
      sizeAuto: opts.sizeAuto,
      size: opts.size,
      borderAuto: opts.borderAuto,
      border: opts.border,
      sharpen: opts.sharpen,
      threshold: opts.threshold,
      crop: opts.crop,
    });
    // Keep saved crop position while aspect matches (mirrors single flow).
    item.crop = { ...out.crop };
    item.result = out.canvas;
    item.resultSize = out.size;
    item.resultBorder = out.border;
    if (item.status === "error") item.status = "ready";
    item.error = undefined;
    return true;
  } catch (err: unknown) {
    item.status = "error";
    item.error = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/** Re-run conversion for every ready item. Yields to keep UI alive. */
export async function processAll(
  globals: GlobalSettings,
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<void> {
  const ready = bulkQueue.filter((i) => i.img && i.status !== "loading");
  let done = 0;
  for (const item of ready) {
    if (shouldCancel?.()) break;
    processItem(item, globals);
    done += 1;
    onProgress?.(done, ready.length);
    await new Promise((r) => requestAnimationFrame(() => r(undefined)));
  }
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((b) => {
      if (b) resolve(b);
      else reject(new Error("toBlob returned null"));
    }, "image/png");
  });
}

const yieldToUi = (): Promise<void> =>
  new Promise((r) => requestAnimationFrame(() => r(undefined)));

/** Export every ready item into a single ZIP. Sequential to bound memory. */
export async function exportAllZip(
  globals: GlobalSettings,
  opts?: { forceUpscale?: number },
  onProgress?: (done: number, total: number) => void,
  shouldCancel?: () => boolean,
): Promise<{ blob: Blob; count: number; skipped: string[] }> {
  const zip = new JSZip();
  const usedNames = new Set<string>();
  const skipped: string[] = [];
  const ready = bulkQueue.filter((i) => i.status === "ready" && i.img);
  let done = 0;
  for (const item of ready) {
    if (shouldCancel?.()) break;
    const ok = processItem(item, globals);
    if (!ok || !item.result || !item.resultSize) {
      skipped.push(item.name);
      continue;
    }
    const resolved = resolveOptions(globals, item);
    const upscale = opts?.forceUpscale ?? resolved.upscale;
    const out =
      upscale > 1 ? upscalePreview(item.result, upscale) : item.result;
    try {
      const blob = await canvasToBlob(out);
      let fname = `${item.name}_${item.resultSize.w}x${item.resultSize.h}${
        upscale > 1 ? `_x${upscale}` : ""
      }.png`;
      let n = 2;
      while (usedNames.has(fname)) {
        fname = `${item.name}-${n}_${item.resultSize.w}x${item.resultSize.h}${
          upscale > 1 ? `_x${upscale}` : ""
        }.png`;
        n += 1;
      }
      usedNames.add(fname);
      zip.file(fname, blob);
    } catch {
      skipped.push(item.name);
    }
    done += 1;
    onProgress?.(done, ready.length);
    await yieldToUi();
  }
  if (usedNames.size === 0) {
    throw new Error("nothing to export — queue is empty or still loading");
  }
  const blob = await zip.generateAsync({ type: "blob" });
  return { blob, count: usedNames.size, skipped };
}
