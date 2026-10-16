/** Allowed painting edge sizes (each side incl. border). */
export const SIZES = [16, 32, 48, 64] as const;

export const DEFAULT_SHARPEN_AMOUNT = 0.3;
export const DEFAULT_SHARPEN_THRESHOLD = 8;
const LOSS_EPSILON = 1e-9;

export interface Size {
  w: number;
  h: number;
}

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

function cropLoss(srcW: number, srcH: number, innerW: number, innerH: number): number {
  const targetAspect = innerW / innerH;
  const srcAspect = srcW / srcH;
  const kept =
    srcAspect > targetAspect
      ? (srcH * targetAspect) / srcW
      : srcW / targetAspect / srcH;
  const clamped = Math.min(1, Math.max(0, kept));
  return 1 - clamped;
}

export function autoSize(srcW: number, srcH: number, sizes: readonly number[] = SIZES): Size {
  let best: Size = { w: sizes[0] ?? 16, h: sizes[0] ?? 16 };
  let bestLoss = Number.POSITIVE_INFINITY;
  let bestArea = 0;
  for (const w of sizes) {
    for (const h of sizes) {
      const loss = cropLoss(srcW, srcH, w - 2, h - 2);
      const area = w * h;
      const better =
        loss < bestLoss - LOSS_EPSILON ||
        (Math.abs(loss - bestLoss) <= LOSS_EPSILON && area > bestArea);
      if (better) {
        bestLoss = loss;
        bestArea = area;
        best = { w, h };
      }
    }
  }
  return best;
}

export function centerCropRect(srcW: number, srcH: number, innerW: number, innerH: number): Rect {
  const targetAspect = innerW / innerH;
  const srcAspect = srcW / srcH;
  let cw: number;
  let ch: number;
  if (srcAspect > targetAspect) {
    cw = Math.round(srcH * targetAspect);
    ch = srcH;
  } else {
    cw = srcW;
    ch = Math.round(srcW / targetAspect);
  }
  cw = Math.min(Math.max(cw, 1), srcW);
  ch = Math.min(Math.max(ch, 1), srcH);
  const x = Math.floor((srcW - cw) / 2);
  const y = Math.floor((srcH - ch) / 2);
  return { x, y, w: cw, h: ch };
}

export function sharpenBlend(
  original: ImageData,
  sharp: ImageData,
  amount: number = DEFAULT_SHARPEN_AMOUNT,
  threshold: number = DEFAULT_SHARPEN_THRESHOLD,
): ImageData {
  if (original.width !== sharp.width || original.height !== sharp.height) {
    throw new Error("sharpenBlend: ImageData sizes must match");
  }
  const out = new ImageData(original.width, original.height);
  const o = original.data;
  const s = sharp.data;
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    for (let c = 0; c < 3; c += 1) {
      const orig = o[i + c] ?? 0;
      const sh = s[i + c] ?? 0;
      if (Math.abs(sh - orig) < threshold || amount <= 0) {
        d[i + c] = orig;
      } else {
        const v = orig + (sh - orig) * amount;
        d[i + c] = Math.round(Math.min(255, Math.max(0, v)));
      }
    }
    d[i + 3] = o[i + 3] ?? 255;
  }
  return out;
}

function medianByte(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function borderCss(border: Rgb): string {
  return `rgb(${border.r}, ${border.g}, ${border.b})`;
}

export function autoBorder(image: ImageData): Rgb {
  const { width: w, height: h, data } = image;
  const rs: number[] = [];
  const gs: number[] = [];
  const bs: number[] = [];
  const strideX = Math.max(1, Math.floor(w / 256));
  const strideY = Math.max(1, Math.floor(h / 256));
  const push = (x: number, y: number): void => {
    const i = (y * w + x) * 4;
    rs.push(data[i] ?? 0);
    gs.push(data[i + 1] ?? 0);
    bs.push(data[i + 2] ?? 0);
  };
  for (let x = 0; x < w; x += strideX) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y += strideY) {
    push(0, y);
    push(w - 1, y);
  }
  return { r: medianByte(rs), g: medianByte(gs), b: medianByte(bs) };
}

export function composeWithBorder(inner: HTMLCanvasElement | ImageData, border: Rgb): HTMLCanvasElement {
  const iw = inner.width;
  const ih = inner.height;
  const canvas = document.createElement("canvas");
  canvas.width = iw + 2;
  canvas.height = ih + 2;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("composeWithBorder: 2d context unavailable");
  }
  ctx.fillStyle = borderCss(border);
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (inner instanceof HTMLCanvasElement) {
    ctx.drawImage(inner, 1, 1);
  } else {
    const tmp = document.createElement("canvas");
    tmp.width = iw;
    tmp.height = ih;
    const tctx = tmp.getContext("2d");
    if (tctx === null) {
      throw new Error("composeWithBorder: 2d context unavailable");
    }
    tctx.putImageData(inner, 0, 0);
    ctx.drawImage(tmp, 1, 1);
  }
  return canvas;
}

export function upscalePreview(source: HTMLCanvasElement, scale: number): HTMLCanvasElement {
  if (!Number.isInteger(scale) || scale <= 1) {
    return source;
  }
  const canvas = document.createElement("canvas");
  canvas.width = source.width * scale;
  canvas.height = source.height * scale;
  const ctx = canvas.getContext("2d");
  if (ctx === null) {
    throw new Error("upscalePreview: 2d context unavailable");
  }
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

export function downscaleCanvas(
  source: HTMLCanvasElement,
  targetW: number,
  targetH: number,
): HTMLCanvasElement {
  const tw = Math.max(1, Math.round(targetW));
  const th = Math.max(1, Math.round(targetH));
  const makeStage = (w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] => {
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, w);
    canvas.height = Math.max(1, h);
    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      throw new Error("downscaleCanvas: 2d context unavailable");
    }
    ctx.imageSmoothingEnabled = true;
    (ctx as CanvasRenderingContext2D & { imageSmoothingQuality?: ImageSmoothingQuality }).imageSmoothingQuality = "high";
    return [canvas, ctx];
  };
  let current: HTMLCanvasElement = source;
  let cw = source.width;
  let ch = source.height;
  while (cw > tw * 2 || ch > th * 2) {
    const nw = cw > tw * 2 ? Math.max(tw, Math.floor(cw / 2)) : cw;
    const nh = ch > th * 2 ? Math.max(th, Math.floor(ch / 2)) : ch;
    if (nw === cw && nh === ch) {
      break;
    }
    const [canvas, ctx] = makeStage(nw, nh);
    ctx.drawImage(current, 0, 0, nw, nh);
    current = canvas;
    cw = nw;
    ch = nh;
  }
  const [finalCanvas, finalCtx] = makeStage(tw, th);
  finalCtx.drawImage(current, 0, 0, tw, th);
  return finalCanvas;
}

/** Options for the pure single-image conversion (shared by single + bulk paths). */
export interface ConvertOptions {
  sizeAuto: boolean;
  size: Size;
  borderAuto: boolean;
  border: Rgb;
  sharpen: number;
  threshold: number;
  crop: Rect | null;
}

export interface ConvertResult {
  canvas: HTMLCanvasElement;
  size: Size;
  border: Rgb;
  crop: Rect;
  cropLoss: number;
}

function clampIntLocal(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

/** Center-crop, downscale, sharpen, border. No DOM reads; safe for bulk. */
export function convertImage(img: HTMLImageElement, opts: ConvertOptions): ConvertResult {
  const sw = img.naturalWidth, sh = img.naturalHeight;
  if (!(sw > 0 && sh > 0)) {
    throw new Error("convertImage: source image has no dimensions yet");
  }
  const size = opts.sizeAuto ? autoSize(sw, sh) : opts.size;
  const iw = size.w - 2, ih = size.h - 2;
  const base = centerCropRect(sw, sh, iw, ih);
  let cx = base.x, cy = base.y;
  if (opts.crop && opts.crop.w === base.w && opts.crop.h === base.h) {
    cx = clampIntLocal(opts.crop.x, 0, sw - base.w);
    cy = clampIntLocal(opts.crop.y, 0, sh - base.h);
  }
  const crop: Rect = { x: cx, y: cy, w: base.w, h: base.h };
  const cropLoss = 1 - (base.w * base.h) / (sw * sh);

  const cropCanvas = document.createElement("canvas");
  cropCanvas.width = base.w; cropCanvas.height = base.h;
  const cctx = cropCanvas.getContext("2d");
  if (cctx === null) throw new Error("convertImage: 2d context unavailable");
  cctx.imageSmoothingEnabled = true;
  (cctx as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
  cctx.drawImage(img, cx, cy, base.w, base.h, 0, 0, base.w, base.h);

  const small = downscaleCanvas(cropCanvas, iw, ih);
  const sctx = small.getContext("2d");
  if (sctx === null) throw new Error("convertImage: 2d context unavailable");

  if (opts.sharpen > 0) {
    const orig = sctx.getImageData(0, 0, iw, ih);
    const b1 = document.createElement("canvas");
    b1.width = Math.max(1, iw >> 1); b1.height = Math.max(1, ih >> 1);
    const b1x = b1.getContext("2d");
    if (b1x === null) throw new Error("convertImage: 2d context unavailable");
    b1x.imageSmoothingEnabled = true;
    (b1x as CanvasRenderingContext2D & { imageSmoothingQuality?: string }).imageSmoothingQuality = "high";
    b1x.drawImage(small, 0, 0, b1.width, b1.height);
    const b2 = document.createElement("canvas"); b2.width = iw; b2.height = ih;
    const b2x = b2.getContext("2d");
    if (b2x === null) throw new Error("convertImage: 2d context unavailable");
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
    sctx.putImageData(sharpenBlend(orig, full, opts.sharpen, opts.threshold), 0, 0);
  }

  let border: Rgb;
  if (opts.borderAuto) {
    const c = document.createElement("canvas");
    const w = Math.min(sw, 512), h = Math.round((Math.min(sw, 512) / sw) * sh);
    c.width = w; c.height = h;
    const x = c.getContext("2d");
    if (x === null) throw new Error("convertImage: 2d context unavailable");
    x.drawImage(img, 0, 0, w, h);
    border = autoBorder(x.getImageData(0, 0, w, h));
  } else {
    border = opts.border;
  }

  return { canvas: composeWithBorder(small, border), size, border, crop, cropLoss };
}
