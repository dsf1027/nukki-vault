// Run with: node tests/run.js
import assert from "node:assert";
import * as P from "../physics.js";
import { fallbackSegment } from "../segment.js";

/* ---- falling ---- */
{
  // Drops from the top, bounces a little, and always comes to rest exactly on the floor.
  let s = { y: 0, vy: 0 };
  const rest = 600;
  let settled = false;
  let maxY = 0;
  for (let i = 0; i < 600 && !settled; i++) {
    const n = P.stepFall(s, 1 / 60, rest);
    assert.ok(n.y <= rest + 1e-9, "never sinks below the floor");
    maxY = Math.max(maxY, n.y);
    s = n;
    settled = n.settled;
  }
  assert.ok(settled, "settles within 10s");
  assert.strictEqual(s.y, rest);
  assert.strictEqual(s.vy, 0);

  // Already below the floor (e.g. after a resize): snaps up and settles at once.
  const snap = P.stepFall({ y: 900, vy: 0 }, 1 / 60, 600);
  assert.strictEqual(snap.y, 600);
  assert.ok(snap.settled);

  // A huge frame gap (tab was in the background) is clamped, no tunnelling.
  const big = P.stepFall({ y: 0, vy: 0 }, 5, 600);
  assert.ok(big.y < 600 && !big.settled);
}

/* ---- layout helpers ---- */
{
  assert.strictEqual(P.restTop(700, 100, 10), 590);
  assert.strictEqual(P.restTop(50, 400, 0), 0, "tall item is clamped to the top");
  const s = P.itemSize(200, 100, 0.5, 400);
  assert.deepStrictEqual(s, { w: 200, h: 100 });
  const f = P.vaultFit(900, 450, 400, 800);
  assert.ok(Math.max(f.w, f.h) <= 400 * 0.42 + 1e-9);
  assert.strictEqual(f.w / f.h, 2);
  const small = P.vaultFit(50, 40, 400, 800);
  assert.strictEqual(small.k, 1, "small items are never enlarged");
  // Drop-in: released near the floor -> re-enter from above the screen; high up -> stay.
  assert.strictEqual(P.dropStartY(700, 710, 120), -120, "near the floor: from above the screen");
  assert.strictEqual(P.dropStartY(300, 710, 120), 300, "high enough: falls from where it was let go");
  assert.strictEqual(P.dropStartY(560, 710, 120), -120, "150px of fall is too little to see");
  assert.strictEqual(P.dropStartY(0, 100, 80), -80, "tiny vault: always from the top");
  assert.strictEqual(P.clampCenterX(-1), 0.05);
  assert.strictEqual(P.clampCenterX(2), 0.95);
  assert.ok(P.inRect(P.inflate({ left: 10, top: 10, right: 20, bottom: 20 }, 5), 6, 24));
}

/* ---- picking: alpha-aware, topmost first ---- */
{
  const mk = (id, z, x) => ({ id, z, x, y: 0, w: 100, h: 100 });
  const bottom = mk("bottom", 1, 0);
  const top = mk("top", 2, 50); // overlaps bottom on x:50..100
  const alpha = (it, x) => (it.id === "top" && x < 80 ? 0 : 255); // top is see-through left of x=80
  assert.strictEqual(P.pickTop([bottom, top], 90, 50, alpha).id, "top", "visible pixel of the top item wins");
  assert.strictEqual(P.pickTop([bottom, top], 60, 50, alpha).id, "bottom", "transparent pixel falls through");
  assert.strictEqual(P.pickTop([bottom, top], 300, 50, alpha), null, "outside everything");
  assert.strictEqual(P.nextZ([bottom, top]), 3);
  assert.strictEqual(P.nextZ([]), 1);
}

/* ---- fallback segmentation on a synthetic photo ---- */
{
  const w = 120, h = 90;
  const data = new Uint8ClampedArray(w * h * 4);
  const inBlob = (x, y) => (x - 60) ** 2 + (y - 45) ** 2 < 25 ** 2;
  const inHole = (x, y) => (x - 60) ** 2 + (y - 45) ** 2 < 6 ** 2;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const obj = inBlob(x, y) && !inHole(x, y) ? [200, 40, 40] : inHole(x, y) ? [215, 205, 190] : [215, 205, 190]; // hole = background colour
      data[i] = obj[0]; data[i + 1] = obj[1]; data[i + 2] = obj[2]; data[i + 3] = 255;
    }
  const r = fallbackSegment({ data, width: w, height: h }, 60 / w, 25 / h); // press on the object ring, off the hole
  assert.ok(r, "finds the object");
  const at = (x, y) => r.mask[y * w + x];
  assert.strictEqual(at(60, 25 + 1), 1, "object pixel is foreground");
  assert.strictEqual(at(5, 5), 0, "background pixel is not");
  assert.strictEqual(at(60, 45), 1, "hole inside the object is filled");

  // Pressing near (not on) the object snaps to it; pressing far away finds nothing.
  assert.ok(fallbackSegment({ data, width: w, height: h }, 60 / w, 17 / h));
  assert.strictEqual(fallbackSegment({ data, width: w, height: h }, 2 / w, 2 / h), null);

  // A uniform image has no object at all.
  const flat = new Uint8ClampedArray(w * h * 4).fill(180);
  assert.strictEqual(fallbackSegment({ data: flat, width: w, height: h }, 0.5, 0.5), null);
}

console.log("all tests passed");
