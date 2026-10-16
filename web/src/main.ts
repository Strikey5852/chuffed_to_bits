import "./style.css";
import {
  SIZES, DEFAULT_SHARPEN_AMOUNT, DEFAULT_SHARPEN_THRESHOLD,
  autoSize, centerCropRect, convertImage, upscalePreview,
  type Size, type Rgb,
} from "./converter.ts";
import {
  addFiles, bulkQueue, clearQueue, exportAllZip, getSelected,
  loadImageUrl, processItem, removeItem, resetAllToDefaults, resetItemToDefaults,
  resolveOptions, setSelectedId, unpackZipImages,
  type BulkItem, type GlobalSettings,
} from "./bulk.ts";
interface Sample { file: string; label: string; }
interface CropRect { x: number; y: number; w: number; h: number; }
const state = {
  img: null as HTMLImageElement | null,
  fileName: "",
  pickerArmed: false,
  sizeAuto: true,
  size: { w: 64, h: 64 } as Size,
  borderAuto: true,
  border: { r: 0, g: 0, b: 0 } as Rgb,
  sharpen: DEFAULT_SHARPEN_AMOUNT,
  threshold: DEFAULT_SHARPEN_THRESHOLD,
  previewScale: 8,
  zoom: 4,
  grid: false,
  crop: null as CropRect | null, // aspect-locked to the inner size
  cropMode: false,
  result: null as HTMLCanvasElement | null,
  cropLoss: 0,
};
/** Batch defaults, edited via the dock. Separate from `state` (the live editor). */
const defaults: GlobalSettings = {
  sizeAuto: true,
  size: { w: 64, h: 64 },
  borderAuto: true,
  border: { r: 0, g: 0, b: 0 },
  sharpen: DEFAULT_SHARPEN_AMOUNT,
  threshold: DEFAULT_SHARPEN_THRESHOLD,
  upscale: 8,
};
function globals(): GlobalSettings {
  return {
    sizeAuto: defaults.sizeAuto,
    size: { ...defaults.size },
    borderAuto: defaults.borderAuto,
    border: { ...defaults.border },
    sharpen: defaults.sharpen,
    threshold: defaults.threshold,
    upscale: defaults.upscale,
  };
}
let bulkExporting = false;
let bulkCancel = false;
// compare pane rects in canvas pixels (hit-testing, crop overlay)
let layout: { ox: number; oy: number; ow: number; oh: number; rx: number; rw: number; rh: number } | null = null;
let cropDrag: { dx: number; dy: number } | null = null;
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing ${sel}`);
  return el;
};
const rgbToHex = (c: Rgb): string =>
  "#" + [c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, "0")).join("");
const hexToRgb = (hex: string): Rgb => ({
  r: parseInt(hex.slice(1, 3), 16), g: parseInt(hex.slice(3, 5), 16), b: parseInt(hex.slice(5, 7), 16),
});
const clampInt = (v: number, lo: number, hi: number): number =>
  Math.max(lo, Math.min(hi, Math.round(v)));
$("#app").innerHTML = `
<header class="menubar">
  <span class="logo">Chuffed To Bits</span>
  <span style="flex:1"></span>
  <span class="disclaimer" title="Chuffed To Bits is an unofficial fan project, not affiliated with or endorsed by Mumbo Jumbo.">unofficial fan project · not affiliated with Mumbo Jumbo</span>
</header>
<div class="workspace">
  <aside class="queue" aria-label="batch queue">
    <section class="zoomsec" aria-label="zoom">
      <div class="row zoomrow" style="justify-content:center; gap:4px;">
        <button class="batch-mini" data-zoom="out" title="Zoom out (−)">−</button>
        <span class="zoom-label" id="zoom-label">4x</span>
        <button class="batch-mini" data-zoom="in" title="Zoom in (+)">+</button>
      </div>
    </section>
    <section><h3>Batch</h3>
      <div class="row"><span class="dims" id="batch-count">empty</span></div>
      <div id="batch-list" class="batch-list"></div>
    </section>
    <section class="queue-foot">
      <div class="row"><button class="btn ghost" id="open-btn">Open Images <span class="key">O</span></button></div>
      <div class="row"><button class="btn ghost" id="batch-reset" disabled>Reset all to defaults</button></div>
      <div class="row"><button class="btn ghost" id="batch-reset-one" disabled>Reset selected image</button></div>
      <div class="row"><button class="btn ghost" id="batch-clear" disabled>Clear batch</button></div>
      <div class="row"><span class="dims" id="batch-status">…</span></div>
      <div class="batch-progress" id="batch-progress" hidden><div id="batch-progress-fill"></div></div>
    </section>
  </aside>
  <main class="stage" id="stage">
    <div class="hint" id="hint"><b>Drop images or a ZIP here</b> or use Open Images&ensp;·&ensp;←/→ steps through batch</div>
  </main>
  <aside class="dock">
    <section><h3>Samples</h3>
      <div class="samples" id="samples"></div>
    </section>
    <section><h3>Painting size</h3>
      <div class="sizegrid" id="sizegrid"></div>
      <div class="row"><span class="dims" id="dims">…</span></div>
    </section>
    <section><h3>Crop</h3>
      <div class="row"><button class="btn ghost" id="crop-adjust">Adjust Crop <span class="key">C</span></button></div>
      <div class="row"><button class="btn ghost" id="crop-reset">Reset crop</button></div>
      <div class="row"><span class="dims" id="crop-readout">…</span></div>
    </section>
    <section><h3>Border</h3>
      <div class="row"><label class="check"><input type="checkbox" id="border-auto" checked> Auto from image</label></div>
      <div class="row"><input type="color" id="border-color" value="#000000"><label>Override <output id="border-hex">#…</output></label></div>
      <div class="row"><button class="btn ghost" id="border-pick">Pick Color <span class="key">I</span></button></div>
    </section>
    <section><h3>Sharpen</h3>
      <div class="slider"><div class="slider-head"><label>Amount</label><output id="sharpen-v">${DEFAULT_SHARPEN_AMOUNT.toFixed(2)}</output></div><input type="range" id="sharpen" min="0" max="1" step="0.05" value="${DEFAULT_SHARPEN_AMOUNT}"></div>
      <div class="slider"><div class="slider-head"><label>Threshold</label><output id="threshold-v">${DEFAULT_SHARPEN_THRESHOLD}</output></div><input type="range" id="threshold" min="0" max="64" step="1" value="${DEFAULT_SHARPEN_THRESHOLD}"></div>
    </section>
    <section><h3>Preview</h3>
      <div class="slider"><div class="slider-head"><label>Upscale</label></div><select id="pscale">
        <option value="1">1x (true size)</option>
        <option value="4">4x</option>
        <option value="8" selected>8x</option>
        <option value="16">16x</option>
      </select></div>
      <div class="row"><label class="check"><input type="checkbox" id="grid"> Pixel grid</label></div>
    </section>
    <section><h3>Export</h3>
      <button class="btn" id="batch-export" disabled>Export ZIP</button>
      <div class="row" style="margin-top:4px;"><button class="btn ghost" id="batch-export-one" disabled>Export image</button></div>
      <div class="row" style="margin-top:4px;"><label class="check"><input type="checkbox" id="batch-upscaled"> Upscaled</label></div>
    </section>
  </aside>
</div>
<footer class="statusbar" id="status"><span>no image</span></footer>
<input type="file" id="file" accept="image/*,.zip" multiple hidden>
`;
const stage = $("#stage");
let view: HTMLCanvasElement | null = null;
let vctx: CanvasRenderingContext2D | null = null;
function ensureView(): { view: HTMLCanvasElement; vctx: CanvasRenderingContext2D } {
  if (!view || !vctx) {
    view = document.createElement("canvas");
    view.id = "view";
    const hint = $("#hint");
    hint.before(view);
    attachCanvasHandlers(view);
    vctx = view.getContext("2d")!;
    vctx.imageSmoothingEnabled = false;
  }
  return { view, vctx };
}
function selectedItem(): BulkItem | null {
  return getSelected();
}
function thumbFor(img: HTMLImageElement): string {
  const c = document.createElement("canvas");
  // Sized for the displayed row width × DPR so they aren't upscaled.
  const maxSide = Math.round(200 * (window.devicePixelRatio || 1));
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  c.width = Math.max(1, Math.round(img.naturalWidth * scale));
  c.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL("image/png");
}
function syncDockToState(): void {
  (document.querySelector("#border-auto") as HTMLInputElement).checked = state.borderAuto;
  // Manual border shows the override/default value; auto shows last detected.
  (document.querySelector("#border-color") as HTMLInputElement).value = rgbToHex(state.border);
  const sh = document.querySelector("#sharpen") as HTMLInputElement;
  sh.value = String(state.sharpen);
  document.querySelector("#sharpen-v")!.textContent = state.sharpen.toFixed(2);
  const th = document.querySelector("#threshold") as HTMLInputElement;
  th.value = String(state.threshold);
  document.querySelector("#threshold-v")!.textContent = String(state.threshold);
  (document.querySelector("#pscale") as HTMLSelectElement).value = String(state.previewScale);
  markSizeGrid();
}
/** Mirror the editor state into the batch defaults (sample preview mode). */
function syncDefaultsFromState(): void {
  defaults.sizeAuto = state.sizeAuto;
  defaults.size = { ...state.size };
  defaults.borderAuto = state.borderAuto;
  defaults.border = { ...state.border };
  defaults.sharpen = state.sharpen;
  defaults.threshold = state.threshold;
}
function convert(opts?: { preserveDock?: boolean }): void {
  const keepDock = opts?.preserveDock === true;
  if (!state.img) return;
  const out = convertImage(state.img, {
    sizeAuto: state.sizeAuto,
    size: state.size,
    borderAuto: state.borderAuto,
    border: state.border,
    sharpen: state.sharpen,
    threshold: state.threshold,
    crop: state.crop,
  });
  // Never write auto-detected size/border back into shared defaults or dock
  // inputs — that would leak one image's result into the next selection.
  const resolvedSize = { ...out.size };
  const resolvedBorder = { ...out.border };
  state.crop = { ...out.crop };
  state.cropLoss = out.cropLoss;
  state.result = out.canvas;
  const sel = selectedItem();
  if (sel && sel.img === state.img) {
    sel.crop = { ...out.crop };
    sel.result = out.canvas;
    sel.resultSize = { ...resolvedSize };
    sel.resultBorder = { ...resolvedBorder };
    if (sel.status === "error") sel.status = "ready";
    sel.error = undefined;
  }
  fitZoom();
  document.querySelector("#zoom-label")!.textContent = `${state.zoom}x`;
  render();
  if (keepDock) {
    updateStatusPreserveDock(state.img.naturalWidth, state.img.naturalHeight, resolvedBorder, resolvedSize);
  } else {
    updateStatus(state.img.naturalWidth, state.img.naturalHeight, resolvedBorder, resolvedSize);
  }
  renderBatchList();
}
function cropDisplayRect(): { x: number; y: number; w: number; h: number } | null {
  if (!state.crop || !state.img || !layout) return null;
  const sw = state.img.naturalWidth, sh = state.img.naturalHeight;
  return {
    x: layout.ox + (state.crop.x / sw) * layout.ow,
    y: layout.oy + (state.crop.y / sh) * layout.oh,
    w: (state.crop.w / sw) * layout.ow,
    h: (state.crop.h / sh) * layout.oh,
  };
}
function render(): void {
  if (!state.result || !state.img) return;
  const { view, vctx } = ensureView();
  const z = state.zoom;
  layout = null;
  {
    const r = state.result;
    const H = Math.max(64, Math.min(r.height * z, 1024));
    const rw = Math.max(1, Math.round((r.width / r.height) * H));
    const ow = Math.max(1, Math.round((state.img.naturalWidth / state.img.naturalHeight) * H));
    view.width = ow + 16 + rw; view.height = H;
    vctx.imageSmoothingEnabled = true;
    vctx.fillStyle = "#15181c"; vctx.fillRect(0, 0, view.width, view.height);
    vctx.drawImage(state.img, 0, 0, ow, H);
    vctx.imageSmoothingEnabled = false;
    vctx.drawImage(r, ow + 16, 0, rw, H);
    if (state.grid && z >= 3 && !state.pickerArmed) {
      const sx = rw / r.width, sy = H / r.height;
      vctx.strokeStyle = "rgba(140,211,215,0.22)"; vctx.lineWidth = 1;
      vctx.beginPath();
      for (let x = 1; x < r.width; x++) { vctx.moveTo(ow + 16 + x * sx + .5, 0); vctx.lineTo(ow + 16 + x * sx + .5, H); }
      for (let y = 1; y < r.height; y++) { vctx.moveTo(ow + 16, y * sy + .5); vctx.lineTo(ow + 16 + rw, y * sy + .5); }
      vctx.stroke();
    }
    layout = { ox: 0, oy: 0, ow, oh: H, rx: ow + 16, rw, rh: H };
    if (state.cropMode) {
      const b = cropDisplayRect();
      if (b) {
        vctx.fillStyle = "rgba(0,0,0,0.45)";
        vctx.fillRect(0, 0, ow, Math.max(0, b.y));
        vctx.fillRect(0, b.y + b.h, ow, Math.max(0, H - (b.y + b.h)));
        vctx.fillRect(0, b.y, Math.max(0, b.x), b.h);
        vctx.fillRect(b.x + b.w, b.y, Math.max(0, ow - (b.x + b.w)), b.h);
        vctx.strokeStyle = "#ee4c63"; vctx.lineWidth = 2;
        vctx.setLineDash([7, 4]);
        vctx.strokeRect(b.x, b.y, b.w, b.h);
        vctx.setLineDash([]);
      }
    }
  }
  $("#hint")!.style.display = "none";
}
function updateStatus(sw: number, sh: number, border: Rgb, size?: Size): void {
  updateStatusPreserveDock(sw, sh, border, size);
  if (state.borderAuto) ($("#border-color") as HTMLInputElement).value = rgbToHex(border);
  markSizeGrid();
}
/** Status text only; leaves dock inputs as selection set them. */
function updateStatusPreserveDock(sw: number, sh: number, border: Rgb, size?: Size): void {
  const s = size ?? state.size;
  $("#status").innerHTML =
    `<span>in ${sw}×${sh}</span><span class="ok">out ${s.w}×${s.h}</span>` +
    `<span>inner ${s.w - 2}×${s.h - 2}</span>` +
    `<span>crop lost ${(state.cropLoss * 100).toFixed(1)}%</span>` +
    `<span>border ${rgbToHex(border)}</span>` +
    `<span>${state.fileName}</span>`;
  $("#dims")!.textContent = `${s.w}×${s.h} (${s.w - 2}×${s.h - 2} + border)`;
  $("#border-hex")!.textContent = rgbToHex(border);
  if (state.crop) $("#crop-readout")!.textContent = `${state.crop.w}×${state.crop.h} @ ${state.crop.x},${state.crop.y}`;
}
function resetCrop(): void {
  state.crop = null;
}
function resetView(): void {
  resetCrop();
  userZoomed = false;
}
function selectItem(id: string): void {
  const item = bulkQueue.find((i) => i.id === id);
  if (!item || !item.img) return;
  setSelectedId(id);
  const g = globals();
  const opts = resolveOptions(g, item);
  state.img = item.img;
  state.fileName = item.name;
  state.sizeAuto = opts.sizeAuto;
  state.size = { ...opts.size };
  state.borderAuto = opts.borderAuto;
  state.border = { ...opts.border };
  state.sharpen = opts.sharpen;
  state.threshold = opts.threshold;
  state.crop = item.crop ? { ...item.crop } : null;
  setCropMode(false);
  setPickerArmed(false);
  resetViewKeepCrop();
  syncDockToState();
  document.querySelectorAll(".samples button").forEach((b) => b.classList.remove("active"));
  // Convert without letting auto-detected values flow back into the dock.
  convert({ preserveDock: true });
  scrollSelectedRowIntoView();
}
function scrollSelectedRowIntoView(): void {
  const sel = getSelected();
  if (!sel) return;
  const list = document.querySelector("#batch-list");
  if (!list) return;
  const row = list.querySelector(`.batch-row[data-id="${sel.id}"]`);
  if (row) row.scrollIntoView({ block: "nearest" });
}
function resetViewKeepCrop(): void {
  userZoomed = false;
}
function isCenterCrop(item: BulkItem): boolean {
  // True unless the crop was dragged away from the auto center.
  if (!item.img || !item.crop) return true;
  const g = globals();
  const opts = resolveOptions(g, item);
  const sw = item.img.naturalWidth, sh = item.img.naturalHeight;
  const size = opts.sizeAuto ? autoSize(sw, sh) : opts.size;
  const iw = size.w - 2, ih = size.h - 2;
  const base = centerCropRect(sw, sh, iw, ih);
  return item.crop.x === base.x && item.crop.y === base.y && item.crop.w === base.w && item.crop.h === base.h;
}
function isZipFile(f: File): boolean {
  return f.type === "application/zip" || f.type === "application/x-zip-compressed" || f.name.toLowerCase().endsWith(".zip");
}
async function importZipFiles(zips: File[], directImgs: File[]): Promise<void> {
  const status = document.querySelector("#batch-status");
  if (status) status.textContent = "unpacking zip…";
  const unpacked: File[] = [];
  for (const z of zips) {
    try {
      unpacked.push(...await unpackZipImages(z));
    } catch (err: unknown) {
      if (status) status.textContent = err instanceof Error ? err.message : String(err);
    }
  }
  const all = [...directImgs, ...unpacked];
  if (all.length === 0) {
    if (status) status.textContent = "no images found in zip";
    return;
  }
  queueImages(all);
}
function loadFiles(files: File[]): void {
  const zips = files.filter((f) => isZipFile(f));
  const imgs = files.filter((f) => f.type.startsWith("image/"));
  if (zips.length > 0) {
    void importZipFiles(zips, imgs);
    return;
  }
  if (imgs.length === 0) return;
  queueImages(imgs);
}
function queueImages(imgs: File[]): void {
  const prevSelected = getSelected()?.id ?? null;
  const created = addFiles(imgs, thumbFor, () => {
    const g = globals();
    for (const item of bulkQueue) {
      if (item.status === "ready" && !item.result) processItem(item, g);
    }
    renderBatchList();
    const sel = getSelected();
    if (sel && sel.img && sel.id !== prevSelected) {
      if (!state.img || state.img !== sel.img) selectItem(sel.id);
      else renderBatchList();
    }
  });
  document.querySelectorAll(".samples button").forEach((b) => b.classList.remove("active"));
  if (created.length > 0) {
    const first = created[0]!;
    if (first.img) {
      selectItem(first.id);
    } else {
      setSelectedId(first.id);
      renderBatchList();
    }
  }
  renderBatchList();
}
function loadSample(path: string, label: string): void {
  // Samples are ephemeral previews: never touch the batch queue.
  void loadImageUrl(path, label).then((img) => {
    setSelectedId(null);
    state.img = img;
    state.fileName = label;
    state.sizeAuto = true;
    state.borderAuto = true;
    state.sharpen = DEFAULT_SHARPEN_AMOUNT;
    state.threshold = DEFAULT_SHARPEN_THRESHOLD;
    state.crop = null;
    state.cropMode = false;
    state.pickerArmed = false;
    resetView();
    syncDockToState();
    renderBatchList();
    convert();
  }).catch(() => {
    state.img = null;
  });
}
function download(scale: number): void {
  if (!state.result) return;
  const out = scale > 1 ? upscalePreview(state.result, scale) : state.result;
  out.toBlob((b) => {
    if (!b) return;
    const a = document.createElement("a");
    a.href = URL.createObjectURL(b);
    a.download = `${state.fileName || "chuffed-to-bits"}_${state.result!.width}x${state.result!.height}${scale > 1 ? `_x${scale}` : ""}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  });
}
function markSizeGrid(): void {
  document.querySelectorAll("#sizegrid button").forEach((b) => {
    const el = b as HTMLElement;
    if (el.dataset.auto === "1") {
      el.classList.toggle("active", state.sizeAuto);
    } else {
      const w = Number(el.dataset.w), h = Number(el.dataset.h);
      el.classList.toggle("active", !state.sizeAuto && w === state.size.w && h === state.size.h);
    }
  });
}
{
  const grid = $("#sizegrid");
  const auto = document.createElement("button");
  auto.textContent = "Auto"; auto.dataset.auto = "1"; auto.classList.add("active");
  auto.title = "Auto (least crop)";
  auto.onclick = () => { setSizeOverride(true, null); };
  grid.appendChild(auto);
  for (const w of SIZES) for (const h of SIZES) {
    const b = document.createElement("button");
    b.textContent = `${w}×${h}`; b.dataset.w = String(w); b.dataset.h = String(h);
    b.onclick = () => { setSizeOverride(false, { w, h }); };
    grid.appendChild(b);
  }
}
/** Route dock edits: pin as per-item override when something is selected;
 *  otherwise edit the editor and mirror into defaults for future imports. */
function dockEdit<K extends keyof GlobalSettings>(key: K, value: GlobalSettings[K]): void {
  const sel = selectedItem();
  if (sel && sel.img === state.img) {
    (sel.override as Record<string, unknown>)[key] = structuredClone(value);
    applyToState(key, value);
  } else {
    applyToState(key, value);
    syncDefaultsFromState();
  }
}
function applyToState<K extends keyof GlobalSettings>(key: K, value: GlobalSettings[K]): void {
  if (key === 'sizeAuto') state.sizeAuto = value as boolean;
  else if (key === 'size') state.size = { ...(value as Size) };
  else if (key === 'borderAuto') state.borderAuto = value as boolean;
  else if (key === 'border') state.border = { ...(value as Rgb) };
  else if (key === 'sharpen') state.sharpen = value as number;
  else if (key === 'threshold') state.threshold = value as number;
}
function refreshFollowers(changedKey: keyof GlobalSettings): void {
  const g = globals();
  for (const item of bulkQueue) {
    if (changedKey in item.override) continue;
    if (item.img === state.img) continue;
    processItem(item, g);
  }
  renderBatchList();
}
function setSizeOverride(auto: boolean, size: Size | null): void {
  dockEdit("sizeAuto", auto);
  if (size) dockEdit("size", { ...size });
  resetView();
  convert();
  refreshFollowers("sizeAuto");
}
$("#border-auto").addEventListener("change", (e) => {
  dockEdit("borderAuto", (e.target as HTMLInputElement).checked);
  convert();
  refreshFollowers("borderAuto");
});
$("#border-color").addEventListener("input", (e) => {
  dockEdit("border", hexToRgb((e.target as HTMLInputElement).value));
  dockEdit("borderAuto", false);
  ($("#border-auto") as HTMLInputElement).checked = false;
  convert();
  refreshFollowers("borderAuto");
});
$("#sharpen").addEventListener("input", (e) => {
  dockEdit("sharpen", Number((e.target as HTMLInputElement).value));
  $("#sharpen-v")!.textContent = state.sharpen.toFixed(2);
  convert();
  refreshFollowers("sharpen");
});
$("#threshold").addEventListener("input", (e) => {
  dockEdit("threshold", Number((e.target as HTMLInputElement).value));
  $("#threshold-v")!.textContent = String(state.threshold);
  convert();
  refreshFollowers("threshold");
});
$("#pscale").addEventListener("change", (e) => {
  state.previewScale = Number((e.target as HTMLSelectElement).value);
  render();
});
$("#grid").addEventListener("change", (e) => {
  state.grid = (e.target as HTMLInputElement).checked;
  render();
});
function setCropMode(on: boolean): void {
  state.cropMode = on;
  $("#crop-adjust")!.classList.toggle("active", on);
  render();
}
$("#crop-adjust").addEventListener("click", () => setCropMode(!state.cropMode));
$("#crop-reset").addEventListener("click", () => { resetCrop(); convert(); });
function setPickerArmed(on: boolean): void {
  state.pickerArmed = on;
  render();
  $("#border-pick")!.classList.toggle("active", on);
  $("#border-pick")!.innerHTML = on ? "Click Image To Pick <span class=\"key\">I</span>" : "Pick Color <span class=\"key\">I</span>";
}
$("#border-pick").addEventListener("click", () => {
  setPickerArmed(!state.pickerArmed);
});
document.querySelector('[data-zoom="in"]')?.addEventListener("click", () => setZoom(state.zoom + 1));
document.querySelector('[data-zoom="out"]')?.addEventListener("click", () => setZoom(state.zoom - 1));
function setZoom(z: number): void {
  userZoomed = true;
  state.zoom = Math.max(1, Math.min(16, z));
  $("#zoom-label")!.textContent = `${state.zoom}x`;
  render();
}
let userZoomed = false;
function fitZoom(): void {
  if (!state.img || !state.result || userZoomed) return;
  const availW = Math.max(320, stage.clientWidth - 48);
  const availH = Math.max(200, stage.clientHeight - 48);
  const r = state.result;
  const aspect = state.img.naturalWidth / state.img.naturalHeight;
  // compare width at zoom z ≈ H*(aspect + r.w/r.h) + 16, H = min(r.h*z, 1024)
  let best = 1;
  for (let z = 16; z >= 1; z--) {
    const H = Math.min(r.height * z, 1024);
    const w = H * aspect + H * (r.width / r.height) + 16;
    if (w <= availW && H <= availH) { best = z; break; }
  }
  state.zoom = best;
  $("#zoom-label")!.textContent = `${best}x`;
}
window.addEventListener("resize", () => { fitZoom(); render(); });
$("#open-btn").addEventListener("click", () => $("#file").click());
$("#batch-export").addEventListener("click", () => void exportBatch());
$("#batch-export-one").addEventListener("click", () => {
  const doUpscale = ($("#batch-upscaled") as HTMLInputElement).checked;
  const scale = doUpscale ? (state.previewScale > 1 ? state.previewScale : 8) : 1;
  const sel = getSelected();
  if (sel && sel.img && sel.status === "ready" && sel.result) {
    const g = globals();
    const opts = resolveOptions(g, sel);
    const out = scale > 1 ? upscalePreview(sel.result, scale) : sel.result;
    out.toBlob((b) => {
      if (!b) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(b);
      const size = sel.resultSize ?? opts.size;
      a.download = `${sel.name}_${size.w}x${size.h}${scale > 1 ? `_x${scale}` : ""}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    }, "image/png");
  } else if (!sel && state.result) {
    // sample preview (not in the batch): same path as the S shortcut
    download(scale);
  }
});
$("#batch-reset").addEventListener("click", () => {
  if (bulkExporting || bulkQueue.length === 0) return;
  resetAllToDefaults();
  const g = globals();
  for (const item of bulkQueue) processItem(item, g);
  const sel = getSelected();
  if (sel && sel.img) selectItem(sel.id);
  else renderBatchList();
  const status = document.querySelector("#batch-status");
  if (status) status.textContent = "all images reset to defaults";
});
$("#batch-reset-one").addEventListener("click", () => {
  if (bulkExporting) return;
  const sel = getSelected();
  if (!sel || !sel.img) return;
  resetItemToDefaults(sel);
  processItem(sel, globals());
  selectItem(sel.id);
});
$("#batch-clear").addEventListener("click", () => {
  if (bulkExporting) return;
  clearQueue();
  state.img = null; state.result = null; state.fileName = "";
  document.querySelector("#status")!.innerHTML = "<span>no image</span>";
  const v = document.querySelector("#view");
  if (v) v.remove();
  view = null; vctx = null;
  const hint = document.querySelector("#hint") as HTMLElement | null;
  if (hint) hint.style.display = "";
  renderBatchList();
});
$("#file").addEventListener("change", (e) => {
  const files = Array.from((e.target as HTMLInputElement).files ?? []);
  if (files.length > 0) loadFiles(files);
  (e.target as HTMLInputElement).value = "";
});
["dragenter", "dragover"].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove("dragover"); }));
stage.addEventListener("drop", (e) => {
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length > 0) loadFiles(files);
});
function canvasPoint(e: PointerEvent, cv: HTMLCanvasElement): { x: number; y: number } {
  const r = cv.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (cv.width / r.width),
    y: (e.clientY - r.top) * (cv.height / r.height),
  };
}
function setBorder(c: Rgb): void {
  dockEdit("border", { ...c });
  dockEdit("borderAuto", false);
  ($("#border-auto") as HTMLInputElement).checked = false;
  ($("#border-color") as HTMLInputElement).value = rgbToHex(c);
  convert();
  refreshFollowers("borderAuto");
}
function sampleImage(img: HTMLImageElement, fx: number, fy: number): Rgb {
  const sx = clampInt(fx * img.naturalWidth, 0, img.naturalWidth - 1);
  const sy = clampInt(fy * img.naturalHeight, 0, img.naturalHeight - 1);
  const c = document.createElement("canvas"); c.width = c.height = 1;
  const x = c.getContext("2d")!;
  x.imageSmoothingEnabled = false;
  x.drawImage(img, sx, sy, 1, 1, 0, 0, 1, 1);
  const [r, g, b] = x.getImageData(0, 0, 1, 1).data;
  return { r: r ?? 0, g: g ?? 0, b: b ?? 0 };
}
function sampleCanvas(cv: HTMLCanvasElement, px: number, py: number): Rgb {
  const x = clampInt(px, 0, cv.width - 1), y = clampInt(py, 0, cv.height - 1);
  const d = cv.getContext("2d")!.getImageData(x, y, 1, 1).data;
  return { r: d[0] ?? 0, g: d[1] ?? 0, b: d[2] ?? 0 };
}
function attachCanvasHandlers(view: HTMLCanvasElement): void {
view.addEventListener("pointerdown", (e) => {
  if (!state.img || !state.result) return;
  const p = canvasPoint(e, view);
  if (state.pickerArmed) {
    if (layout) {
      if (p.x < layout.ox + layout.ow) {
        setBorder(sampleImage(state.img, (p.x - layout.ox) / layout.ow, (p.y - layout.oy) / layout.oh));
      } else if (p.x >= layout.rx) {
        setBorder(sampleCanvas(view, Math.floor(p.x), Math.floor(p.y)));
      } else return;
    }
    state.pickerArmed = false;
    setPickerArmed(false);
    return;
  }
  if (state.cropMode && state.crop && state.img && layout) {
    const b = cropDisplayRect();
    if (b && p.x >= b.x && p.x <= b.x + b.w && p.y >= b.y && p.y <= b.y + b.h) {
      cropDrag = { dx: p.x - b.x, dy: p.y - b.y };
      view.setPointerCapture(e.pointerId);
    }
  }
});
view.addEventListener("pointermove", (e) => {
  if (!cropDrag || !state.img || !state.crop || !layout) return;
  const p = canvasPoint(e, view);
  const sw = state.img.naturalWidth, sh = state.img.naturalHeight;
  state.crop.x = clampInt(((p.x - cropDrag.dx - layout.ox) / layout.ow) * sw, 0, sw - state.crop.w);
  state.crop.y = clampInt(((p.y - cropDrag.dy - layout.oy) / layout.oh) * sh, 0, sh - state.crop.h);
  convert();
});
view.addEventListener("pointerup", () => { cropDrag = null; });
}
document.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
  if (e.key === "ArrowRight") { stepBatch(1); e.preventDefault(); return; }
  if (e.key === "ArrowLeft") { stepBatch(-1); e.preventDefault(); return; }
  const k = e.key.toLowerCase();
  if (k === "i") setPickerArmed(!state.pickerArmed);
  else if (k === "c") setCropMode(!state.cropMode);
  else if (k === "escape") { if (state.pickerArmed) setPickerArmed(false); if (state.cropMode) setCropMode(false); }
  else if (k === "o") $("#file").click();
  else if (k === "s") download(1);
  else if (k === "e") download(state.previewScale > 1 ? state.previewScale : 8);
  else if (k === "g") { state.grid = !state.grid; ($("#grid") as HTMLInputElement).checked = state.grid; render(); }
  else if (k === "+" || k === "=") setZoom(state.zoom + 1);
  else if (k === "-") setZoom(state.zoom - 1);
});
function stepBatch(dir: 1 | -1): void {
  if (bulkQueue.length < 2) return;
  const sel = getSelected();
  const idx = sel ? bulkQueue.findIndex((i) => i.id === sel.id) : -1;
  const order = bulkQueue.map((i) => i.id);
  let next = idx + dir;
  // Skip items still loading (no decoded image yet).
  for (let n = 0; n < order.length; n += 1) {
    const wrapped = (next + order.length * 10) % order.length;
    const cand = bulkQueue[wrapped];
    if (cand && cand.img) {
      if (cand.id !== sel?.id) selectItem(cand.id);
      return;
    }
    next += dir;
  }
}
function renderBatchList(): void {
  const list = document.querySelector("#batch-list");
  const count = document.querySelector("#batch-count");
  const status = document.querySelector("#batch-status");
  const exportBtn = document.querySelector("#batch-export") as HTMLButtonElement | null;
  const clearBtn = document.querySelector("#batch-clear") as HTMLButtonElement | null;
  const resetAllBtn = document.querySelector("#batch-reset") as HTMLButtonElement | null;
  const resetOneBtn = document.querySelector("#batch-reset-one") as HTMLButtonElement | null;
  const exportOneBtn = document.querySelector("#batch-export-one") as HTMLButtonElement | null;
  if (!list || !count || !status || !exportBtn || !exportOneBtn || !clearBtn || !resetAllBtn || !resetOneBtn) return;
  const ready = bulkQueue.filter((i) => i.status === "ready").length;
  const loading = bulkQueue.filter((i) => i.status === "loading").length;
  count.textContent = bulkQueue.length === 0 ? "empty" : `${bulkQueue.length} image${bulkQueue.length === 1 ? "" : "s"} (${ready} ready${loading > 0 ? `, ${loading} loading` : ""})`;
  const sel = getSelected();
  status.textContent = bulkExporting ? "exporting… (click again to cancel)" : sel ? `editing: ${sel.name}` : ready > 0 ? `${ready} ready` : "…";
  exportBtn.disabled = ready === 0; // stays enabled during export so a click cancels
  exportBtn.textContent = bulkExporting ? "Cancel export" : "Export ZIP";
  clearBtn.disabled = bulkQueue.length === 0 || bulkExporting;
  const anyDirty = bulkQueue.some((i) => Object.keys(i.override).length > 0 || (i.crop !== null && i.img !== null && !isCenterCrop(i)));
  const selDirty = sel !== null && sel.img !== null && (Object.keys(sel.override).length > 0 || (sel.crop !== null && !isCenterCrop(sel)));
  resetOneBtn.disabled = !selDirty || bulkExporting;
  exportOneBtn.disabled = bulkExporting || ((!sel || !sel.img || sel.status !== "ready") && !state.result);
  resetAllBtn.disabled = !anyDirty || bulkExporting;
  const prevScroll = list.scrollTop;
  list.innerHTML = "";
  const g = globals();
  for (const item of bulkQueue) {
    const row = document.createElement("div");
    row.className = "batch-row" + (sel?.id === item.id ? " active" : "");
    row.dataset.id = item.id;
    const thumb = document.createElement("button");
    thumb.className = "batch-thumb";
    thumb.title = item.name;
    if (item.thumbUrl) {
      const im = document.createElement("img");
      im.src = item.thumbUrl;
      im.alt = item.name;
      thumb.appendChild(im);
    } else { thumb.textContent = "…"; }
    thumb.onclick = () => selectItem(item.id);
    const resolved = resolveOptions(g, item);
    const sizeLabel = resolved.sizeAuto ? "Auto" : `${resolved.size.w}x${resolved.size.h}`;
    const keys = Object.keys(item.override);
    const hasCustomCrop = item.crop !== null && item.img !== null && !isCenterCrop(item);
    const parts = [sizeLabel, rgbToHex(resolved.border)];
    if (keys.length > 0) parts.push(`* ${keys.length} tweak${keys.length === 1 ? "" : "s"}`);
    if (hasCustomCrop) parts.push("custom crop");
    if (item.status === "loading") parts.push("loading…");
    if (item.status === "error") parts.push(item.error ?? "error");
    if (item.resultSize) {
      parts.push(`out ${item.resultSize.w}x${item.resultSize.h}`);
    }
    row.title = `${item.name} — ${parts.join(" · ")}`;
    if (item.resultBorder) {
      thumb.style.borderColor = rgbToHex(item.resultBorder);
    }
    const actions = document.createElement("div");
    actions.className = "batch-actions";
    if (keys.length > 0 || hasCustomCrop) {
      const flag = document.createElement("span");
      flag.className = "batch-dirty";
      flag.textContent = "tweaked";
      flag.title = `Overrides: ${[...keys, ...(hasCustomCrop ? ["crop"] : [])].join(", ")} — use Reset selected image below`;
      actions.appendChild(flag);
    }
    const xBtn = document.createElement("button");
    xBtn.className = "batch-mini danger batch-close";
    xBtn.textContent = "×";
    xBtn.title = "Remove from batch";
    xBtn.onclick = (e) => {
      e.stopPropagation();
      const wasSel = getSelected()?.id === item.id;
      removeItem(item.id);
      if (bulkQueue.length === 0) {
        state.img = null; state.result = null; state.fileName = "";
        document.querySelector("#status")!.innerHTML = "<span>no image</span>";
        const v = document.querySelector("#view");
        if (v) v.remove();
        view = null; vctx = null;
        const hint = document.querySelector("#hint") as HTMLElement | null;
        if (hint) hint.style.display = "";
      } else if (wasSel) {
        const next = getSelected();
        if (next) selectItem(next.id);
      }
      renderBatchList();
    };
    actions.appendChild(xBtn);
    row.appendChild(thumb);
    row.appendChild(actions);
    row.onclick = () => selectItem(item.id);
    list.appendChild(row);
  }
  list.scrollTop = prevScroll;
}
function setBatchProgress(done: number, total: number): void {
  const wrap = document.querySelector("#batch-progress") as HTMLElement | null;
  const fill = document.querySelector("#batch-progress-fill") as HTMLElement | null;
  if (!wrap || !fill) return;
  if (total <= 0) { wrap.hidden = true; return; }
  wrap.hidden = false;
  fill.style.width = `${Math.round((done / total) * 100)}%`;
  const status = document.querySelector("#batch-status");
  if (status) status.textContent = `exporting ${done}/${total}… (click Export to cancel)`;
}
async function exportBatch(): Promise<void> {
  if (bulkExporting) { bulkCancel = true; return; }
  if (bulkQueue.length === 0) return;
  bulkExporting = true;
  bulkCancel = false;
  renderBatchList();
  setBatchProgress(0, 1);
  let message = "";
  try {
    const g = globals();
    const forceUpscale = ($("#batch-upscaled") as HTMLInputElement).checked ? (state.previewScale > 1 ? state.previewScale : 8) : 1;
    const { blob, count, skipped } = await exportAllZip(g, { forceUpscale }, (d, t) => setBatchProgress(d, t), () => bulkCancel);
    if (bulkCancel) {
      message = "export cancelled";
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `chuffed-to-bits-batch_${count}${($("#batch-upscaled") as HTMLInputElement).checked ? `_x${forceUpscale}` : ""}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 8000);
    message = skipped.length > 0 ? `exported ${count}${($("#batch-upscaled") as HTMLInputElement).checked ? ` x${forceUpscale}` : ""}, skipped ${skipped.length}: ${skipped.join(", ")}` : `exported ${count} painting${count === 1 ? "" : "s"}${($("#batch-upscaled") as HTMLInputElement).checked ? ` x${forceUpscale}` : ""}`;
  } catch (err: unknown) {
    message = err instanceof Error ? err.message : String(err);
  } finally {
    bulkExporting = false;
    bulkCancel = false;
    const wrap = document.querySelector("#batch-progress") as HTMLElement | null;
    if (wrap) wrap.hidden = true;
    renderBatchList();
    const status = document.querySelector("#batch-status");
    if (status && message) status.textContent = message;
  }
}
async function loadSamples(): Promise<void> {
  const box = $("#samples");
  try {
    const res = await fetch("samples/manifest.json");
    if (!res.ok) return;
    const list = (await res.json()) as Sample[];
    for (const s of list) {
      const b = document.createElement("button");
      b.title = s.label;
      const im = document.createElement("img");
      im.src = `samples/${s.file}`;
      im.alt = s.label;
      im.loading = "lazy";
      b.appendChild(im);
      b.onclick = () => {
        document.querySelectorAll(".samples button").forEach((x) => x.classList.remove("active"));
        b.classList.add("active");
        loadSample(`samples/${s.file}`, s.file.replace(/\.[^.]+$/, ""));
      };
      box.appendChild(b);
    }
  } catch {
    /* no samples, user opens their own file */
  }
}
void loadSamples();