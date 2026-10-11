// Run with: node tests/run.js
import assert from "node:assert";
import * as P from "../physics.js";
import { fallbackSegment } from "../segment.js";
import { refineMask, keepMainObject, fillSmallHoles, erode, dilate, components } from "../refine.js";

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


/* ---- mask refinement ---- */
{
  const rect = (m, w, x0, y0, x1, y1, v = 1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) m[y * w + x] = v; };
  const sum = (m) => m.reduce((a, v) => a + v, 0);
  const W = 300, H = 200;

  // distant stray blob is dropped, a fragment right next to the object is kept
  {
    const m = new Uint8Array(W * H);
    rect(m, W, 100, 60, 200, 140); // main object
    rect(m, W, 203, 70, 223, 90); // 3px gap (reach here is ~1.2% of the long side = 4px): part of the object, e.g. a tail tip
    rect(m, W, 207, 100, 227, 120); // 7px gap: too far, treated as a separate thing
    rect(m, W, 10, 170, 60, 190); // far away strip
    const k = keepMainObject(m, W, H);
    assert.strictEqual(k[75 * W + 210], 1, "near fragment kept");
    assert.strictEqual(k[110 * W + 215], 0, "fragment beyond the reach removed");
    assert.strictEqual(k[180 * W + 30], 0, "far stray removed");
    assert.strictEqual(k[100 * W + 150], 1, "main kept");
    // specks are noise
    const s = new Uint8Array(W * H);
    rect(s, W, 100, 60, 200, 140);
    rect(s, W, 210, 70, 212, 72);
    assert.strictEqual(sum(keepMainObject(s, W, H)), 100 * 80, "tiny speck removed");
  }

  // small holes are filled, big openings stay open, and a hole open to the outside is not a hole
  {
    const m = new Uint8Array(W * H);
    rect(m, W, 50, 30, 250, 170);
    rect(m, W, 100, 80, 104, 84, 0); // 4x4 hole
    rect(m, W, 160, 60, 220, 140, 0); // big opening
    const f = fillSmallHoles(m, W, H);
    assert.strictEqual(f[82 * W + 102], 1, "small hole filled");
    assert.strictEqual(f[100 * W + 190], 0, "large opening stays");
    const c = new Uint8Array(W * H);
    rect(c, W, 50, 30, 250, 170);
    rect(c, W, 140, 30, 144, 60, 0); // notch connected to the background
    assert.strictEqual(fillSmallHoles(c, W, H)[40 * W + 142], 0, "notch is not a hole");
  }

  // erode/dilate basics, and the frame edge is not eaten
  {
    const m = new Uint8Array(W * H);
    rect(m, W, 0, 0, 100, 100);
    const e = erode(m, W, H, 2);
    assert.strictEqual(e[50 * W + 50], 1);
    assert.strictEqual(e[50 * W + 99], 0, "inner edge eroded");
    assert.strictEqual(e[50 * W + 0], 1, "image border not eroded");
    assert.strictEqual(sum(dilate(e, W, H, 2)) >= sum(e), true);
    assert.strictEqual(components(m, W, H, 1).sizes.length, 2);
  }

  // refineMask: soft edge, shrinks the rim, keeps the interior opaque, same size
  {
    const m = new Uint8Array(600 * 400);
    rect(m, 600, 200, 100, 400, 300);
    rect(m, 600, 20, 350, 80, 390); // stray
    const a = refineMask(m, 600, 400);
    assert.strictEqual(a.length, m.length);
    assert.strictEqual(a[200 * 600 + 300], 255, "interior fully opaque");
    assert.strictEqual(a[370 * 600 + 50], 0, "stray gone");
    assert.strictEqual(a[200 * 600 + 150], 0, "outside transparent");
    const edge = [];
    for (let x = 196; x < 206; x++) edge.push(a[200 * 600 + x]);
    assert.ok(edge.some((v) => v > 0 && v < 255), "edge is feathered: " + edge.join(","));
    assert.ok(a[200 * 600 + 200] < 128, "the original outermost pixel is mostly transparent now (" + a[200 * 600 + 200] + ")");
    assert.strictEqual(a[200 * 600 + 204], 255, "a few px inside is solid again");
  }

  // tiny images are not shaved at all
  {
    const m = new Uint8Array(200 * 120);
    rect(m, 200, 60, 30, 140, 90);
    const a = refineMask(m, 200, 120);
    let on = 0;
    for (let i = 0; i < a.length; i++) if (a[i] >= 128) on++;
    assert.ok(on >= 80 * 60 * 0.97, "small image keeps its object (" + on + " of 4800 px)");
  }

  // a thin object must survive the rim shaving
  {
    const m = new Uint8Array(600 * 400);
    rect(m, 600, 100, 200, 500, 203); // 3px line
    const a = refineMask(m, 600, 400);
    let on = 0;
    for (let i = 0; i < a.length; i++) if (a[i] >= 128) on++;
    assert.ok(on > 400 * 1, "thin object not erased (" + on + " px left)");
  }
}

console.log("all tests passed");
