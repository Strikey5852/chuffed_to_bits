import "./style.css";
import {
  SIZES, DEFAULT_SHARPEN_AMOUNT, DEFAULT_SHARPEN_THRESHOLD,
  autoSize, centerCropRect, sharpenBlend, autoBorder,
  composeWithBorder, upscalePreview,
  type Size, type Rgb,
} from "./converter.ts";

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
  <aside class="toolbox" aria-label="tools">
    <button class="tool" data-zoom="in" title="Zoom in (+)">+</button>
    <span class="zoom-label" id="zoom-label">4x</span>
    <button class="tool" data-zoom="out" title="Zoom out (−)">−</button>
  </aside>
  <main class="stage" id="stage">
    <div class="hint" id="hint"><b>Drop an image here</b> or use Open Image&ensp;·&ensp;samples in the dock →</div>
  </main>
  <aside class="dock">
    <section><h3>Image</h3>
      <div class="row"><button class="btn ghost" id="open-btn">Open Image <span class="key">O</span></button></div>
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
      <button class="btn" id="save-btn" disabled>Save painting PNG</button>
      <button class="btn ghost" id="save-big-btn" disabled>Export upscaled PNG</button>
    </section>
  </aside>
</div>
<footer class="statusbar" id="status"><span>no image</span></footer>
<input type="file" id="file" accept="image/*" hidden>
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

function convert(): void {
  if (!state.img) return;
  const sw = state.img.naturalWidth, sh = state.img.naturalHeight;
  const size = state.sizeAuto ? autoSize(sw, sh) : state.size;
  state.size = size;
  const iw = size.w - 2, ih = size.h - 2;
  // keep saved position only while the aspect is unchanged
  const base = centerCropRect(sw, sh, iw, ih);
  let cx = base.x, cy = base.y;
  if (state.crop && state.crop.w === base.w && state.crop.h === base.h) {
    cx = clampInt(state.crop.x, 0, sw - base.w);
    cy = clampInt(state.crop.y, 0, sh - base.h);
  }
  state.crop = { x: cx, y: cy, w: base.w, h: base.h };
  state.cropLoss = 1 - (base.w * base.h) / (sw * sh);

  const crop = document.createElement("canvas");
  crop.width = base.w; crop.height = base.h;
  const cctx = crop.getContext("2d")!;
  cctx.imageSmoothingEnabled = true;
  (cctx as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
  cctx.drawImage(state.img, cx, cy, base.w, base.h, 0, 0, base.w, base.h);

  const small = document.createElement("canvas");
  small.width = iw; small.height = ih;
  const sctx = small.getContext("2d")!;
  sctx.imageSmoothingEnabled = true;
  (sctx as CanvasRenderingContext2D & { imageSmoothingQuality?: ImageSmoothingQuality }).imageSmoothingQuality = "high";
  sctx.drawImage(crop, 0, 0, iw, ih);

  if (state.sharpen > 0) {
    const orig = sctx.getImageData(0, 0, iw, ih);
    const b1 = document.createElement("canvas");
    b1.width = Math.max(1, iw >> 1); b1.height = Math.max(1, ih >> 1);
    const b1x = b1.getContext("2d")!;
    b1x.imageSmoothingEnabled = true;
    (b1x as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
    b1x.drawImage(small, 0, 0, b1.width, b1.height);
    const b2 = document.createElement("canvas"); b2.width = iw; b2.height = ih;
    const b2x = b2.getContext("2d")!;
    b2x.imageSmoothingEnabled = true;
    b2x.drawImage(b1, 0, 0, iw, ih);
    const blur = b2x.getImageData(0, 0, iw, ih);
    const full = new ImageData(iw, ih);
    for (let i = 0; i < orig.data.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const o = orig.data[i + c]!, b = blur.data[i + c]!;
        full.data[i + c] = Math.max(0, Math.min(255, Math.round(o + (o - b))));
      }
      full.data[i + 3] = 255;
    }
    sctx.putImageData(sharpenBlend(orig, full, state.sharpen, state.threshold), 0, 0);
  }

  let border: Rgb;
  if (state.borderAuto) {
    const c = document.createElement("canvas");
    const w = Math.min(sw, 512), h = Math.round((Math.min(sw, 512) / sw) * sh);
    c.width = w; c.height = h;
    const x = c.getContext("2d")!;
    x.drawImage(state.img, 0, 0, w, h);
    border = autoBorder(x.getImageData(0, 0, w, h));
    state.border = border;
  } else {
    border = state.border;
  }

  state.result = composeWithBorder(small, border);
  fitZoom();
  $("#zoom-label")!.textContent = `${state.zoom}x`;
  render();
  updateStatus(sw, sh, border);
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
    if (state.grid && z >= 3) {
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
  for (const id of ["#save-btn", "#save-big-btn"]) { ($(id) as HTMLButtonElement).disabled = false; }
}

function updateStatus(sw: number, sh: number, border: Rgb): void {
  const s = state.size;
  $("#status").innerHTML =
    `<span>in ${sw}×${sh}</span><span class="ok">out ${s.w}×${s.h}</span>` +
    `<span>inner ${s.w - 2}×${s.h - 2}</span>` +
    `<span>crop lost ${(state.cropLoss * 100).toFixed(1)}%</span>` +
    `<span>border ${rgbToHex(border)}</span>` +
    `<span>${state.fileName}</span>`;
  $("#dims")!.textContent = `${s.w}×${s.h} (${s.w - 2}×${s.h - 2} + border)`;
  $("#border-hex")!.textContent = rgbToHex(border);
  if (state.borderAuto) ($("#border-color") as HTMLInputElement).value = rgbToHex(border);
  if (state.crop) $("#crop-readout")!.textContent = `${state.crop.w}×${state.crop.h} @ ${state.crop.x},${state.crop.y}`;
  markSizeGrid();
}

function resetCrop(): void {
  state.crop = null;
}
function resetView(): void {
  resetCrop();
  userZoomed = false;
}
function loadFile(f: File): void {
  const url = URL.createObjectURL(f);
  const img = new Image();
  img.onload = () => {
    state.img = img; state.fileName = f.name.replace(/\.[^.]+$/, "");
    resetView();
    URL.revokeObjectURL(url);
    document.querySelectorAll(".samples button").forEach((b) => b.classList.remove("active"));
    convert();
  };
  img.src = url;
}
function loadSample(path: string, label: string): void {
  const img = new Image();
  img.onload = () => {
    state.img = img; state.fileName = label;
    resetView();
    convert();
  };
  img.src = path;
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
  auto.onclick = () => { state.sizeAuto = true; resetView(); convert(); };
  grid.appendChild(auto);
  for (const w of SIZES) for (const h of SIZES) {
    const b = document.createElement("button");
    b.textContent = `${w}×${h}`; b.dataset.w = String(w); b.dataset.h = String(h);
    b.onclick = () => { state.sizeAuto = false; state.size = { w, h }; resetView(); convert(); };
    grid.appendChild(b);
  }
}
$("#border-auto").addEventListener("change", (e) => {
  state.borderAuto = (e.target as HTMLInputElement).checked;
  convert();
});
$("#border-color").addEventListener("input", (e) => {
  state.border = hexToRgb((e.target as HTMLInputElement).value);
  state.borderAuto = false;
  ($("#border-auto") as HTMLInputElement).checked = false;
  convert();
});
$("#sharpen").addEventListener("input", (e) => {
  state.sharpen = Number((e.target as HTMLInputElement).value);
  $("#sharpen-v")!.textContent = state.sharpen.toFixed(2);
  convert();
});
$("#threshold").addEventListener("input", (e) => {
  state.threshold = Number((e.target as HTMLInputElement).value);
  $("#threshold-v")!.textContent = String(state.threshold);
  convert();
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
$("#save-btn").addEventListener("click", () => download(1));
$("#save-big-btn").addEventListener("click", () => download(state.previewScale > 1 ? state.previewScale : 8));
$("#file").addEventListener("change", (e) => {
  const f = (e.target as HTMLInputElement).files?.[0];
  if (f) loadFile(f);
  (e.target as HTMLInputElement).value = "";
});
["dragenter", "dragover"].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.add("dragover"); }));
["dragleave", "drop"].forEach((ev) => stage.addEventListener(ev, (e) => { e.preventDefault(); stage.classList.remove("dragover"); }));
stage.addEventListener("drop", (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith("image/")) loadFile(f);
});
function canvasPoint(e: PointerEvent, cv: HTMLCanvasElement): { x: number; y: number } {
  const r = cv.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (cv.width / r.width),
    y: (e.clientY - r.top) * (cv.height / r.height),
  };
}
function setBorder(c: Rgb): void {
  state.border = c;
  state.borderAuto = false;
  ($("#border-auto") as HTMLInputElement).checked = false;
  ($("#border-color") as HTMLInputElement).value = rgbToHex(c);
  convert();
}
function sampleImage(img: HTMLImageElement, fx: number, fy: number): Rgb {
  const sx = clampInt(fx * img.naturalWidth, 0, img.naturalWidth - 1);
  const sy = clampInt(fy * img.naturalHeight, 0, img.naturalHeight - 1);
  const c = document.createElement("canvas"); c.width = c.height = 1;
  const x = c.getContext("2d")!;
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
        const r = state.result;
        setBorder(sampleCanvas(r, ((p.x - layout.rx) / layout.rw) * r.width, ((p.y - layout.oy) / layout.rh) * r.height));
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
  if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "SELECT") return;
  const k = e.key.toLowerCase();
  if (k === "i") setPickerArmed(!state.pickerArmed);
  else if (k === "c") setCropMode(!state.cropMode);
  else if (k === "escape") { if (state.cropMode) setCropMode(false); }
  else if (k === "o") $("#file").click();
  else if (k === "s") download(1);
  else if (k === "e") download(state.previewScale > 1 ? state.previewScale : 8);
  else if (k === "g") { state.grid = !state.grid; ($("#grid") as HTMLInputElement).checked = state.grid; render(); }
  else if (k === "+" || k === "=") setZoom(state.zoom + 1);
  else if (k === "-") setZoom(state.zoom - 1);
});

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
