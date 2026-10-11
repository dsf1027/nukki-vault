// Regression test: the GPU delegate used to return an all-one-label mask (the whole photo
// "is the object") when a smaller photo followed a larger one. Needs a static server on
// :8080 (or BASE) and tests/fixtures/cat.jpg (downloaded by e2e.cjs/offline.cjs if missing).
//   BASE_URL=http://localhost:8080/index.html NODE_PATH=$(npm root -g) node tests/size-change.cjs
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = process.env.BASE_URL || "http://localhost:8080/index.html";
const CAT = path.join(__dirname, "fixtures", "cat.jpg");
if (!fs.existsSync(CAT)) {
  fs.mkdirSync(path.dirname(CAT), { recursive: true });
  require("child_process").execFileSync("curl", ["-fsSL", "-o", CAT, "https://storage.googleapis.com/mediapipe-assets/cat.jpg"]);
}
let failed = 0;
const ok = (c, msg) => { console.log(c ? "ok  " : "FAIL", msg); if (!c) failed++; };

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(URL);
  const rows = await page.evaluate(async () => {
    const { Segmenter } = await import(new URL("segment.js", location.href).href);
    const img = new Image();
    img.src = new URL("tests/fixtures/cat.jpg", location.href).href;
    await img.decode();
    const at = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; c.getContext("2d").drawImage(img, 0, 0, w, h); return c; };
    const s = new Segmenter();
    await s.init();
    const out = [];
    // big first, then smaller, then a different aspect ratio, then big again
    for (const [w, h] of [[1200, 800], [600, 400], [300, 200], [400, 600], [1200, 800]]) {
      const r = await s.segmentAt(at(w, h), 0.5, 0.5);
      let fg = 0;
      for (const v of r.mask) fg += v;
      out.push({ size: `${w}x${h}`, engine: r.engine, fgPct: +(100 * fg / r.mask.length).toFixed(1), delegate: s.delegate });
    }
    return out;
  });
  for (const r of rows) {
    console.log(JSON.stringify(r));
    ok(r.engine === "mediapipe", `${r.size}: model result (not the fallback)`);
    ok(r.fgPct > 3 && r.fgPct < 70, `${r.size}: object is a part of the photo, not all of it (${r.fgPct}%)`);
  }
  ok(errors.length === 0, "no page errors " + JSON.stringify(errors));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all size-change checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
