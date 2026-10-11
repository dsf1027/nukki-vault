// Verifies the PWA works offline after one online visit (service worker + cached model).
//   BASE_URL=http://localhost:8080/index.html NODE_PATH=$(npm root -g) node tests/offline.cjs
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

async function cutOut(page) {
  await page.setInputFiles("#fileGallery2", CAT);
  await page.waitForFunction(() => !document.getElementById("photoBox").hidden);
  const bb = await page.locator("#photoBox").boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.mouse.down();
  await page.waitForFunction(() => window.__nukki.sticker !== null, null, { timeout: 90000, polling: 100 });
  await page.mouse.up();
}

(async () => {
  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ["camera"] });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(URL);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
  ok(true, "service worker installed and controlling the page");

  await cutOut(page); // online: this downloads wasm + model through the service worker
  ok((await page.evaluate(() => window.__nukki.seg.failed)) === false, "online: AI model loaded");

  await ctx.setOffline(true);
  const net = await page.evaluate(() => fetch("https://example.com/", { mode: "no-cors" }).then(() => "online", () => "offline"));
  ok(net === "offline", "network really is off");

  await page.reload();
  await page.waitForFunction(() => !!window.__nukki, null, { timeout: 15000 });
  ok(true, "offline: app shell loads after reload");
  await cutOut(page);
  const st = await page.evaluate(() => ({ failed: window.__nukki.seg.failed, ready: !!window.__nukki.seg.seg }));
  ok(st.ready && !st.failed, "offline: AI model loads from the cache and cuts out an object");

  ok(errors.length === 0, "no page errors " + JSON.stringify(errors));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all offline checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
