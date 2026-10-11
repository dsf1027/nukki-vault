// Mask clean-up applied after segmentation. Pure functions (no DOM) so they can be unit-tested.
//
// What the raw model mask suffers from (seen on real photos):
//  - stray fragments cut off from the object (e.g. a strip of couch next to a cat's tail)
//  - a thin ring of background colour along the outline (pink fringe around a corgi)
//  - stair-stepped outlines (the mask is binary)

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// 4-connected components of `mask` pixels equal to `val`.
// Returns { lab: Int32Array (0 = other value), sizes: number[] (index = label), touchesBorder: boolean[] }.
export function components(mask, w, h, val = 1) {
  const n = w * h;
  const lab = new Int32Array(n);
  const sizes = [0];
  const border = [false];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (lab[s] || mask[s] !== val) continue;
    const id = sizes.length;
    let count = 0;
    let touches = false;
    let sp = 0;
    stack[sp++] = s;
    lab[s] = id;
    while (sp) {
      const q = stack[--sp];
      count++;
      const x = q % w;
      const y = (q - x) / w;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
      if (x > 0 && !lab[q - 1] && mask[q - 1] === val) { lab[q - 1] = id; stack[sp++] = q - 1; }
      if (x < w - 1 && !lab[q + 1] && mask[q + 1] === val) { lab[q + 1] = id; stack[sp++] = q + 1; }
      if (y > 0 && !lab[q - w] && mask[q - w] === val) { lab[q - w] = id; stack[sp++] = q - w; }
      if (y < h - 1 && !lab[q + w] && mask[q + w] === val) { lab[q + w] = id; stack[sp++] = q + w; }
    }
    sizes.push(count);
    border.push(touches);
  }
  return { lab, sizes, touchesBorder: border };
}

// Square-window max (dilate) / min (erode) filter of radius r, done as two 1-D passes.
// Pixels outside the image are ignored, so an object cut off by the frame is not eaten there.
function rank(src, w, h, r, takeMax) {
  const tmp = new Uint8Array(src.length);
  const out = new Uint8Array(src.length);
  const init = takeMax ? 0 : 1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let v = init;
      const a = Math.max(0, x - r), b = Math.min(w - 1, x + r);
      for (let k = a; k <= b; k++) {
        const s = src[row + k];
        if (takeMax ? s > v : s < v) { v = s; if (takeMax ? v === 1 : v === 0) break; }
      }
      tmp[row + x] = v;
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) {
      let v = init;
      const a = Math.max(0, y - r), b = Math.min(h - 1, y + r);
      for (let k = a; k <= b; k++) {
        const s = tmp[k * w + x];
        if (takeMax ? s > v : s < v) { v = s; if (takeMax ? v === 1 : v === 0) break; }
      }
      out[y * w + x] = v;
    }
  }
  return out;
}
export const dilate = (m, w, h, r) => rank(m, w, h, r, true);
export const erode = (m, w, h, r) => rank(m, w, h, r, false);

const count = (m) => { let c = 0; for (let i = 0; i < m.length; i++) c += m[i]; return c; };

// Keep the main object plus fragments that sit right next to it; drop distant stray blobs.
export function keepMainObject(mask, w, h) {
  const { lab, sizes } = components(mask, w, h, 1);
  if (sizes.length <= 2) return mask;
  let main = 1;
  for (let i = 2; i < sizes.length; i++) if (sizes[i] > sizes[main]) main = i;

  const mainMask = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) mainMask[i] = lab[i] === main ? 1 : 0;
  const reach = Math.max(2, Math.round(Math.max(w, h) * 0.012));
  const near = dilate(mainMask, w, h, reach);

  const keep = new Uint8Array(sizes.length);
  keep[main] = 1;
  const speck = Math.max(4, Math.round(w * h * 0.0004)); // too small to be a real part
  for (let p = 0; p < mask.length; p++) {
    const l = lab[p];
    if (l && !keep[l] && sizes[l] >= speck && near[p]) keep[l] = 1;
  }
  const out = new Uint8Array(mask.length);
  for (let p = 0; p < mask.length; p++) out[p] = lab[p] && keep[lab[p]] ? 1 : 0;
  return out;
}

// Fill holes that are tiny compared to the object (model misses); real openings stay.
export function fillSmallHoles(mask, w, h, maxFrac = 0.004) {
  const area = count(mask);
  const { lab, sizes, touchesBorder } = components(mask, w, h, 0);
  const limit = area * maxFrac;
  const out = mask.slice();
  for (let p = 0; p < mask.length; p++) {
    const l = lab[p];
    if (l && !touchesBorder[l] && sizes[l] <= limit) out[p] = 1;
  }
  return out;
}

// 3x3 box blur of a 0..255 alpha plane.
function softenAlpha(alpha, w, h) {
  const tmp = new Uint8Array(alpha.length);
  const out = new Uint8ClampedArray(alpha.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = x > 0 ? alpha[i - 1] : alpha[i];
      const c = x < w - 1 ? alpha[i + 1] : alpha[i];
      tmp[i] = (a + alpha[i] + c) / 3;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = y > 0 ? tmp[i - w] : tmp[i];
      const c = y < h - 1 ? tmp[i + w] : tmp[i];
      out[i] = (a + tmp[i] + c) / 3;
    }
  return out;
}

// mask: Uint8Array of 0/1 (w*h). Returns an alpha plane (Uint8ClampedArray, 0..255), same size.
export function refineMask(mask, w, h) {
  let m = keepMainObject(mask, w, h);
  m = fillSmallHoles(m, w, h);

  // Shave the background-coloured rim: ~1px per 600px of image (none below 300px), at most
  // 3px, and never so much that a thin object disappears.
  const before = count(m);
  let r = clamp(Math.round(Math.max(w, h) / 600), 0, 3); // tiny images (<300px) are left alone
  let eroded = r ? erode(m, w, h, r) : m;
  while (r > 0 && count(eroded) < before * 0.6) {
    r--;
    eroded = r ? erode(m, w, h, r) : m;
  }

  const alpha = new Uint8Array(mask.length);
  for (let i = 0; i < alpha.length; i++) alpha[i] = eroded[i] ? 255 : 0;
  return softenAlpha(alpha, w, h);
}
