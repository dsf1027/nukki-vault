// Object cut-out ("nukki"): MediaPipe interactive segmenter first, with a
// plain background-subtraction fallback for devices where the model cannot run.

const MP_BASE = new URL("./vendor/mediapipe/", import.meta.url).href;
// The model is not bundled (its licence terms were not verified); it is downloaded
// from Google's public MediaPipe model bucket on first use and then cached by sw.js.
export const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/interactive_segmenter/magic_touch/float32/1/magic_touch.tflite";

export class Segmenter {
  constructor() {
    this.seg = null;
    this.failed = false;
    this._init = null;
    this._mp = null;
  }

  // Lazy and idempotent. Resolves to true when the model is usable.
  init() {
    if (!this._init) {
      this._init = this._load().then(
        () => true,
        (err) => {
          console.warn("MediaPipe unavailable, using fallback:", err);
          this.failed = true;
          return false;
        }
      );
    }
    return this._init;
  }

  async _load(delegates = ["GPU", "CPU"]) {
    if (!this._mp) {
      const { FilesetResolver, InteractiveSegmenter } = await import(MP_BASE + "vision_bundle.mjs");
      this._mp = { InteractiveSegmenter, fileset: await FilesetResolver.forVisionTasks(MP_BASE + "wasm") };
    }
    let lastErr;
    for (const delegate of delegates) {
      try {
        this.seg = await this._mp.InteractiveSegmenter.createFromOptions(this._mp.fileset, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate },
          outputCategoryMask: true,
          outputConfidenceMasks: false,
        });
        this.delegate = delegate;
        return;
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr;
  }

  async _useCpu() {
    try { this.seg.close(); } catch (e) { /* already gone */ }
    this.seg = null;
    await this._load(["CPU"]);
  }

  // Returns { mask: Uint8Array(w*h) of 0/1, w, h, engine } or null.
  async segmentAt(canvas, nx, ny) {
    if (await this.init()) {
      try {
        let out = this._run(canvas, nx, ny);
        // Known GPU-delegate failure: after other photo sizes it can label every pixel the
        // same, i.e. "the whole photo is the object". The CPU delegate gives the right mask.
        if (out && out.uniform && this.delegate === "GPU") {
          console.warn("GPU segmentation returned a uniform mask; switching to the CPU delegate");
          await this._useCpu();
          out = this._run(canvas, nx, ny);
        }
        if (out) return out;
      } catch (e) {
        console.warn("segment failed, using fallback:", e);
      }
    }
    return fallbackFromCanvas(canvas, nx, ny);
  }

  _run(canvas, nx, ny) {
    let out = null;
    this.seg.segment(canvas, { keypoint: { x: nx, y: ny } }, (result) => {
      const m = result.categoryMask;
      if (!m) return;
      const src = m.getAsUint8Array();
      // Label values differ between model/runtime versions, so don't assume
      // which one means "object": the pixel the user pressed is the object.
      const px = Math.min(m.width - 1, Math.round(nx * (m.width - 1)));
      const py = Math.min(m.height - 1, Math.round(ny * (m.height - 1)));
      const label = src[py * m.width + px];
      const mask = new Uint8Array(src.length);
      let uniform = true;
      for (let i = 0; i < src.length; i++) {
        mask[i] = src[i] === label ? 1 : 0;
        if (!mask[i]) uniform = false;
      }
      out = { mask, w: m.width, h: m.height, engine: "mediapipe", uniform };
    });
    return out;
  }
}

/* ---------- fallback: background subtraction (pure, testable) ---------- */

// imageData: { data: Uint8ClampedArray RGBA, width, height }
// Returns { mask, w, h } or null when nothing sensible can be isolated.
export function fallbackSegment(imageData, nx, ny) {
  const { data, width: w, height: h } = imageData;
  const n = w * h;

  // 1. background colour = per-channel median of the border ring
  const ring = Math.max(1, Math.round(Math.min(w, h) * 0.04));
  const samples = [[], [], []];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x >= ring && x < w - ring && y >= ring && y < h - ring) continue;
      const i = (y * w + x) * 4;
      samples[0].push(data[i]);
      samples[1].push(data[i + 1]);
      samples[2].push(data[i + 2]);
    }
  }
  const bg = samples.map((s) => {
    s.sort((a, b) => a - b);
    return s[s.length >> 1];
  });

  // 2. distance to background, split with Otsu's threshold
  const dist = new Float32Array(n);
  const hist = new Uint32Array(256);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const d = Math.hypot(data[i] - bg[0], data[i + 1] - bg[1], data[i + 2] - bg[2]);
    dist[p] = d;
    hist[Math.min(255, Math.round(d / 1.7321))]++;
  }
  const T = Math.max(22, otsu(hist, n) * 1.7321 * 0.8);
  let fg = new Uint8Array(n);
  for (let p = 0; p < n; p++) fg[p] = dist[p] > T ? 1 : 0;

  // 3. close small gaps, then take the component under (or next to) the seed
  fg = erode(dilate(fg, w, h), w, h);
  const sx = Math.min(w - 1, Math.max(0, Math.round(nx * (w - 1))));
  const sy = Math.min(h - 1, Math.max(0, Math.round(ny * (h - 1))));
  const seed = nearestForeground(fg, w, h, sx, sy, Math.round(Math.min(w, h) * 0.12));
  if (seed < 0) return null;
  let mask = component(fg, w, h, seed);

  // 4. fill holes: whatever the border cannot reach belongs to the object
  mask = fillHoles(mask, w, h);

  let area = 0;
  for (let p = 0; p < n; p++) area += mask[p];
  if (area > n * 0.8 || area < n * 0.004) return null;
  return { mask, w, h, engine: "fallback" };
}

function otsu(hist, total) {
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let wB = 0, sumB = 0, best = 0, thr = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

function dilate(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      o[p] = m[p] || (x > 0 && m[p - 1]) || (x < w - 1 && m[p + 1]) || (y > 0 && m[p - w]) || (y < h - 1 && m[p + w]) ? 1 : 0;
    }
  return o;
}

function erode(m, w, h) {
  const o = new Uint8Array(m.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      o[p] = m[p] && (x === 0 || m[p - 1]) && (x === w - 1 || m[p + 1]) && (y === 0 || m[p - w]) && (y === h - 1 || m[p + w]) ? 1 : 0;
    }
  return o;
}

function nearestForeground(fg, w, h, sx, sy, maxR) {
  if (fg[sy * w + sx]) return sy * w + sx;
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const x = sx + dx, y = sy + dy;
        if (x >= 0 && y >= 0 && x < w && y < h && fg[y * w + x]) return y * w + x;
      }
  }
  return -1;
}

function component(fg, w, h, seed) {
  const out = new Uint8Array(fg.length);
  const stack = [seed];
  out[seed] = 1;
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    const nb = [x > 0 ? p - 1 : -1, x < w - 1 ? p + 1 : -1, p >= w ? p - w : -1, p < w * (h - 1) ? p + w : -1];
    for (const q of nb) {
      if (q >= 0 && fg[q] && !out[q]) { out[q] = 1; stack.push(q); }
    }
  }
  return out;
}

function fillHoles(mask, w, h) {
  const outside = new Uint8Array(mask.length);
  const stack = [];
  const push = (p) => { if (!mask[p] && !outside[p]) { outside[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  const out = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) out[p] = outside[p] ? 0 : 1;
  return out;
}

/* ---------- canvas glue (browser only) ---------- */

function fallbackFromCanvas(canvas, nx, ny) {
  const k = Math.min(1, 256 / Math.max(canvas.width, canvas.height));
  const w = Math.max(8, Math.round(canvas.width * k));
  const h = Math.max(8, Math.round(canvas.height * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, w, h);
  return fallbackSegment(ctx.getImageData(0, 0, w, h), nx, ny);
}

// Cuts `mask` (w*h of 0/1, any resolution) out of `src` and crops to its
// bounding box. Returns { canvas, box } with box in src pixels, or null.
// `mask` is either 0/1 or a 0..255 alpha plane (see refine.js); any size w*h.
export function buildCutout(src, mask, mw, mh, maxSide = 640) {
  let max = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] > max) max = mask[i];
  const gain = max <= 1 ? 255 : 1;
  const solid = max <= 1 ? 1 : 128; // what counts as "inside" for the bounding box

  let x0 = mw, y0 = mh, x1 = -1, y1 = -1, area = 0;
  for (let y = 0; y < mh; y++)
    for (let x = 0; x < mw; x++) {
      if (mask[y * mw + x] < solid) continue;
      area++;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  if (area < mw * mh * 0.004) return null;

  const pad = 2;
  x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
  x1 = Math.min(mw - 1, x1 + pad); y1 = Math.min(mh - 1, y1 + pad);
  const kx = src.width / mw, ky = src.height / mh;
  const box = { x: x0 * kx, y: y0 * ky, w: (x1 - x0 + 1) * kx, h: (y1 - y0 + 1) * ky };

  const k = Math.min(1, maxSide / Math.max(box.w, box.h));
  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(box.w * k));
  out.height = Math.max(1, Math.round(box.h * k));
  const ctx = out.getContext("2d");
  ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, out.width, out.height);

  // The mask goes through a canvas so that scaling feathers the edge.
  const mc = document.createElement("canvas");
  mc.width = mw;
  mc.height = mh;
  const mctx = mc.getContext("2d");
  const img = mctx.createImageData(mw, mh);
  for (let p = 0; p < mask.length; p++) {
    const i = p * 4;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
    img.data[i + 3] = Math.min(255, mask[p] * gain);
  }
  mctx.putImageData(img, 0, 0);
  ctx.globalCompositeOperation = "destination-in";
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(mc, x0, y0, x1 - x0 + 1, y1 - y0 + 1, 0, 0, out.width, out.height);
  ctx.globalCompositeOperation = "source-over";
  return { canvas: out, box };
}
