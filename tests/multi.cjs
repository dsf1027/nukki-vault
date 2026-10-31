// Several cut-outs from one photo + front/back camera switch.
//   BASE_URL=http://localhost:8080/index.html NODE_PATH=$(npm root -g) node tests/multi.cjs [photo.jpg]
// Without a photo argument it draws three coloured discs on a plain background.
const { chromium } = require("playwright");
const fs = require("fs");
const os = require("os");
const path = require("path");
const URL = process.env.BASE_URL || "http://localhost:8080/index.html";
let failed = 0;
const ok = (c, msg) => { console.log(c ? "ok  " : "FAIL", msg); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFor = (page, fn, arg, timeout = 90000) => page.waitForFunction(fn, arg, { timeout, polling: 100 });

(async () => {
  const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium", args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ["camera"], serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  /* camera switch */
  await page.goto(URL);
  await waitFor(page, () => document.getElementById("video").videoWidth > 0);
  ok(await page.locator("#flipBtn").isVisible(), "the front/back switch button is there");
  ok(!(await page.locator("#video").evaluate((v) => v.classList.contains("mirror"))), "the back camera is not mirrored");
  await page.click("#flipBtn");
  await waitFor(page, () => document.getElementById("video").classList.contains("mirror") && document.getElementById("video").videoWidth > 0);
  ok(true, "switched to the front camera: preview mirrored and running");
  const facing = await page.evaluate(() => navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" } }).then((s) => { const t = s.getTracks()[0]; const f = t.getSettings().facingMode || "?"; s.getTracks().forEach((x) => x.stop()); return f; }));
  console.log("      (fake camera reports facingMode:", facing + ")");
  await page.click("#shutter");
  ok(await page.locator("#photoBox").isVisible(), "a front-camera photo can be taken");
  await page.reload();
  await waitFor(page, () => document.getElementById("video").videoWidth > 0);
  ok(await page.locator("#video").evaluate((v) => v.classList.contains("mirror")), "the chosen camera is remembered after a reload");
  await page.click("#flipBtn");
  await waitFor(page, () => !document.getElementById("video").classList.contains("mirror") && document.getElementById("video").videoWidth > 0);
  ok(true, "and back to the rear camera");

  /* several cut-outs from one photo */
  let photo = process.argv[2];
  if (!photo) {
    photo = path.join(os.tmpdir(), "nukki-multi.png");
    const p = await browser.newPage({ viewport: { width: 900, height: 600 } });
    await p.setContent("<canvas id=c width=900 height=600></canvas>");
    const b64 = await p.evaluate(() => {
      const c = document.getElementById("c"), x = c.getContext("2d");
      x.fillStyle = "#f4f1ea"; x.fillRect(0, 0, 900, 600);
      [["#d94f3a", 170], ["#2f7fd1", 450], ["#3aa35f", 730]].forEach(([col, cx]) => { x.fillStyle = col; x.beginPath(); x.ellipse(cx, 330, 105, 170, 0, 0, 7); x.fill(); x.fillStyle = "#222"; x.beginPath(); x.arc(cx, 250, 26, 0, 7); x.fill(); });
      return c.toDataURL("image/png").split(",")[1];
    });
    fs.writeFileSync(photo, Buffer.from(b64, "base64"));
    await p.close();
  }
  await page.setInputFiles("#fileGallery2", photo);
  await waitFor(page, () => !document.getElementById("photoBox").hidden);
  const pb = await page.locator("#photoBox").boundingBox();
  const spots = process.argv[2] ? JSON.parse(process.env.SPOTS || "[[0.3,0.55],[0.75,0.55]]") : [[170 / 900, 0.55], [450 / 900, 0.55], [730 / 900, 0.55]];
  for (let i = 0; i < spots.length; i++) {
    const [fx, fy] = spots[i];
    await page.mouse.move(pb.x + pb.width * fx, pb.y + pb.height * fy);
    await page.mouse.down();
    await waitFor(page, (n) => window.__nukki.stickers.length >= n, i + 1);
    await page.mouse.up();
    await sleep(300);
  }
  const n = await page.evaluate(() => window.__nukki.stickers.length);
  ok(n === spots.length, `${n} cut-outs from one photo stay on screen at the same time (expected ${spots.length})`);
  const boxes = await page.evaluate(() => window.__nukki.stickers.map((s) => ({ x: s.x, w: s.w, h: s.h })));
  ok(boxes.every((b) => b.w > 40 && b.h > 40) && new Set(boxes.map((b) => Math.round(b.x / 20))).size === n, "they are separate pieces at different places: " + JSON.stringify(boxes.map((b) => [Math.round(b.x), Math.round(b.w)])));
  if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

  /* drag the first one into the vault; the others stay */
  const first = await page.evaluate(() => { const s = window.__nukki.stickers[0]; return { x: s.x + s.w / 2, y: s.y + s.h * 0.6 }; });
  const tab = await page.locator("#tabVault").boundingBox();
  await page.mouse.move(first.x, first.y);
  await page.mouse.down();
  await page.mouse.move(tab.x + tab.width / 2, tab.y + tab.height / 2, { steps: 12 });
  await waitFor(page, () => window.__nukki.view === "vault");
  await page.mouse.move(200, 400, { steps: 4 });
  await page.mouse.up();
  await waitFor(page, () => window.__nukki.items.length === 1);
  ok(await page.evaluate((k) => window.__nukki.stickers.length === k - 1, n), "one went into the vault, the others are still waiting on the photo");
  await page.click("#tabCam");
  await sleep(300);
  ok((await page.evaluate(() => window.__nukki.stickers.filter((s) => !s.el.hidden).length)) === n - 1, "back on the camera tab the remaining cut-outs are visible");
  await page.click("#retake");
  ok((await page.evaluate(() => window.__nukki.stickers.length)) === 0, "retake clears the waiting cut-outs");

  ok(errors.length === 0, "no page errors " + JSON.stringify(errors));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all multi checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
