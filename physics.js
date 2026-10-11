// Pure helpers for the vault: falling, hit-testing and layout. No DOM access.

export const FALL = { g: 2600, bounce: 0.32, minV: 140, maxDt: 1 / 30 };

// One integration step of a falling item. `y` is the item's top edge and
// `restY` is the top edge it comes to rest at (floor minus item height).
export function stepFall(s, dt, restY, o = FALL) {
  const d = Math.min(dt, o.maxDt);
  const vy = s.vy + o.g * d;
  const y = s.y + vy * d;
  if (y < restY) return { y, vy, settled: false };
  if (Math.abs(vy) < o.minV) return { y: restY, vy: 0, settled: true };
  return { y: restY, vy: -vy * o.bounce, settled: false };
}

export function restTop(floorY, h, floorOff) {
  return Math.max(0, floorY - floorOff - h);
}

// Where a newly stored item starts falling from. Released close to the floor there
// would be nothing to see, so it re-enters from just above the screen instead.
export function dropStartY(y, restY, h) {
  const minFall = Math.max(160, restY * 0.35);
  return restY - y >= minFall ? y : -h;
}

export function itemSize(nw, nh, wFrac, viewW) {
  const w = wFrac * viewW;
  return { w, h: (w * nh) / nw };
}

// Size a lifted cutout so that it fits comfortably in the vault.
export function vaultFit(w, h, viewW, viewH) {
  const maxSide = Math.min(viewW, viewH) * 0.42;
  const k = Math.min(1, maxSide / Math.max(w, h));
  return { w: w * k, h: h * k, k };
}

export function inflate(r, m) {
  return { left: r.left - m, top: r.top - m, right: r.right + m, bottom: r.bottom + m };
}

export function inRect(r, x, y) {
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

// Alpha-aware picking: the topmost item (highest z) whose pixel under (x, y)
// is visible. `alphaAt(item, x, y)` returns 0..255.
export function pickTop(items, x, y, alphaAt, threshold = 24) {
  const sorted = items.slice().sort((a, b) => b.z - a.z);
  for (const it of sorted) {
    if (x < it.x || y < it.y || x > it.x + it.w || y > it.y + it.h) continue;
    if (alphaAt(it, x, y) >= threshold) return it;
  }
  return null;
}

export function nextZ(items) {
  return items.reduce((m, it) => Math.max(m, it.z), 0) + 1;
}

export function clampCenterX(xc) {
  return Math.min(0.95, Math.max(0.05, xc));
}
