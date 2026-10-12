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
