// End-to-end check in headless Chromium. Needs `playwright` (global or local) and
// a static server on :8080 serving this folder (e.g. `python3 -m http.server 8080`).
//   NODE_PATH=$(npm root -g) node tests/e2e.cjs [screenshot-dir]
const { chromium } = require("playwright");
const path = require("path");
const fs = require("fs");

const URL = process.env.BASE_URL || "http://localhost:8080/index.html";
const CAT = path.join(__dirname, "fixtures", "cat.jpg");
const SHOTS = process.argv[2];

// Test photo (a cat on a couch) from MediaPipe's public sample assets. It is not
// committed to this repo because its licence is unverified; download it on demand.
if (!fs.existsSync(CAT)) {
  fs.mkdirSync(path.dirname(CAT), { recursive: true });
  require("child_process").execFileSync("curl", ["-fsSL", "-o", CAT, "https://storage.googleapis.com/mediapipe-assets/cat.jpg"]);
}
let failed = 0;
const ok = (c, msg) => { console.log(c ? "ok  " : "FAIL", msg); if (!c) failed++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(page, fn, arg, timeout = 60000) {
  await page.waitForFunction(fn, arg, { timeout, polling: 100 });
}

(async () => {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const shot = (p, name) => (SHOTS ? p.screenshot({ path: path.join(SHOTS, name + ".png") }) : null);

  const browser = await chromium.launch({
    executablePath: "/opt/pw-browsers/chromium",
    args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, permissions: ["camera"], serviceWorkers: "block" });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));

  await page.goto(URL);

  /* 1. live camera + shutter */
  await waitFor(page, () => document.getElementById("video").videoWidth > 0);
  ok(true, "camera stream started");
  await page.click("#shutter");
  ok(await page.locator("#photoBox").isVisible(), "shutter shows the captured photo");
  await page.click("#retake");
  await waitFor(page, () => document.getElementById("video").videoWidth > 0);
  ok(await page.locator("#photoBox").isHidden(), "retake returns to the live camera");

  /* 2. load a real photo */
  await page.setInputFiles("#fileGallery2", CAT);
  await waitFor(page, () => !document.getElementById("photoBox").hidden);
  const pb = await page.locator("#photoBox").boundingBox();
  const catAt = { x: pb.x + pb.width * 0.5, y: pb.y + pb.height * 0.5 };
  await shot(page, "1-photo");

  /* 3. short press does nothing, 1s press cuts the object out */
  await page.mouse.move(catAt.x, catAt.y);
  await page.mouse.down();
  await sleep(300);
  ok(await page.locator("#ring").isVisible(), "press ring shows while holding");
  await page.mouse.up();
  await sleep(1300);
  ok((await page.evaluate(() => window.__nukki.sticker)) === null, "a short press does not cut anything out");

  await page.mouse.move(catAt.x, catAt.y);
  await page.mouse.down();
  await waitFor(page, () => window.__nukki.sticker !== null);
  ok(true, "holding ~1s cut the object out");
  const st = await page.evaluate(() => { const s = window.__nukki.sticker; return { w: s.w, h: s.h, x: s.x, y: s.y }; });
  ok(st.w < pb.width && st.h < pb.height && st.w > 100, `sticker is cropped to the object (${Math.round(st.w)}x${Math.round(st.h)})`);
  await shot(page, "2-lifted");

  /* 4. still holding: drag to the vault tab, view switches, release there → falls */
  const tab = await page.locator("#tabVault").boundingBox();
  const tx = tab.x + tab.width / 2, ty = tab.y + tab.height / 2;
  await page.mouse.move(catAt.x + 5, catAt.y + 40, { steps: 5 });
  await page.mouse.move(tx, ty, { steps: 15 });
  ok(await page.locator("#tabVault.hot").count() === 1, "vault tab highlights while hovering with the item");
  await sleep(600);
  ok((await page.evaluate(() => window.__nukki.view)) === "vault", "view switched to the vault while still holding");
  await shot(page, "3-in-vault-holding");
  await page.mouse.move(tx - 90, 300, { steps: 10 });
  await page.mouse.up();
  const floor = await page.evaluate(() => document.getElementById("tabs").getBoundingClientRect().top - 8);
  await sleep(120);
  const mid = await page.evaluate(() => window.__nukki.items[0].y);
  await shot(page, "4-falling");
  await waitFor(page, () => window.__nukki.items.length === 1 && window.__nukki.items[0].vy === 0 && window.__nukki.items[0].y > 0, null, 10000);
  await sleep(1500);
  const rest = await page.evaluate(() => { const i = window.__nukki.items[0]; return { y: i.y, h: i.h, off: i.floorOff, stored: i.stored }; });
  ok(mid < rest.y, `item was still in the air shortly after release (y ${Math.round(mid)} -> ${Math.round(rest.y)})`);
  ok(Math.abs(rest.y + rest.h + rest.off - floor) < 1.5, "item came to rest on the floor");
  ok((await page.locator("#badge").textContent()) === "1", "badge shows 1 stored item");
  await shot(page, "5-stored");

  /* 5. persistence */
  await page.reload();
  await waitFor(page, () => window.__nukki.items.length === 1);
  await page.click("#tabVault");
  await sleep(300);
  const again = await page.evaluate(() => { const i = window.__nukki.items[0]; return { y: i.y, h: i.h, off: i.floorOff }; });
  ok(Math.abs(again.y + again.h + again.off - floor) < 1.5, "after reload the item is restored on the floor");

  /* 6. second item, overlapping the first */
  await page.click("#tabCam");
  await waitFor(page, () => document.getElementById("video").videoWidth > 0);
  await page.setInputFiles("#fileGallery2", CAT);
  await waitFor(page, () => !document.getElementById("photoBox").hidden);
  await page.mouse.move(catAt.x, catAt.y);
  await page.mouse.down();
  await waitFor(page, () => window.__nukki.sticker !== null);
  const first = await page.evaluate(() => { const i = window.__nukki.items[0]; return { x: i.x, w: i.w }; });
  await page.mouse.move(tx, ty, { steps: 15 });
  await sleep(600);
  await page.mouse.move(first.x + first.w * 0.7, 380, { steps: 10 }); // overlaps the first cat
  await page.mouse.up();
  await sleep(2500);
  const two = await page.evaluate(() => window.__nukki.items.map((i) => ({ id: i.id, x: i.x, w: i.w, z: i.z, y: i.y, h: i.h })));
  ok(two.length === 2, "two items stored");
  ok(two[1].x < two[0].x + two[0].w && two[0].x < two[1].x + two[1].w, "items overlap horizontally");
  ok(two[1].z > two[0].z, "newer item is in front");
  await shot(page, "6-two-items");

  /* 7. tap the older item where only it is visible → comes to the front */
  const pt = await page.evaluate(() => {
    const [a, b] = window.__nukki.items;
    const alpha = (it, x, y) => {
      const u = Math.min(it.alpha.w - 1, Math.max(0, Math.floor(((x - it.x) / it.w) * it.alpha.w)));
      const v = Math.min(it.alpha.h - 1, Math.max(0, Math.floor(((y - it.y) / it.h) * it.alpha.h)));
      return it.alpha.a[v * it.alpha.w + u];
    };
    for (let y = a.y; y < a.y + a.h; y += 3)
      for (let x = a.x; x < a.x + a.w; x += 3) {
        const inB = x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
        if (alpha(a, x, y) > 200 && inB && alpha(b, x, y) < 5) return { x, y };
      }
    return null;
  });
  if (pt) {
    await page.mouse.click(pt.x, pt.y);
    await sleep(200);
    const z = await page.evaluate(() => window.__nukki.items.map((i) => i.z));
    ok(z[0] > z[1], "tapping the older item through a transparent gap brings it to the front");
  } else {
    console.log("skip  no pixel found where only the older item is visible");
  }
  await page.mouse.click(5, 5); // tap on empty space: nothing happens
  const zBefore = await page.evaluate(() => window.__nukki.items.map((i) => i.z).join());
  await sleep(150);
  ok((await page.evaluate(() => window.__nukki.items.map((i) => i.z).join())) === zBefore, "tapping empty space changes nothing");

  await page.reload();
  await waitFor(page, () => window.__nukki.items.length === 2);
  const z2 = await page.evaluate(() => window.__nukki.items.map((i) => i.z));
  ok(z2[0] !== z2[1], "stacking order survives a reload");

  /* 8. drag to trash deletes */
  await page.click("#tabVault");
  await sleep(200);
  const top = await page.evaluate(() => {
    const it = window.__nukki.items.slice().sort((a, b) => b.z - a.z)[0];
    return { x: it.x + it.w / 2, y: it.y + it.h / 2 };
  });
  await page.mouse.move(top.x, top.y);
  await page.mouse.down();
  await page.mouse.move(195, 40, { steps: 12 });
  await shot(page, "7-trash");
  await page.mouse.up();
  await sleep(300);
  ok((await page.evaluate(() => window.__nukki.items.length)) === 1, "dropping on the trash deletes the item");
  await page.reload();
  await waitFor(page, () => window.__nukki.items.length === 1);
  ok(true, "deletion is persisted");

  /* 9. released right on the tab: the item must fall in from above the screen */
  await page.click("#tabCam");
  await waitFor(page, () => document.getElementById("video").videoWidth > 0);
  await page.setInputFiles("#fileGallery2", CAT);
  await waitFor(page, () => !document.getElementById("photoBox").hidden);
  await page.mouse.move(catAt.x, catAt.y);
  await page.mouse.down();
  await waitFor(page, () => window.__nukki.sticker !== null);
  await page.mouse.move(tx, ty, { steps: 15 });
  await sleep(600);
  await page.mouse.up(); // let go on the tab bar, i.e. at the floor
  await sleep(60);
  const early = await page.evaluate(() => { const i = window.__nukki.items[window.__nukki.items.length - 1]; return { y: i.y, h: i.h }; });
  ok(early.y < 0, `released at the floor, it re-enters from above the screen (y=${Math.round(early.y)})`);
  await sleep(230);
  await shot(page, "8a-mid-air");
  await waitFor(page, () => { const i = window.__nukki.items[window.__nukki.items.length - 1]; return i.vy === 0 && i.y > 100; }, null, 10000);
  await sleep(300);
  const landed = await page.evaluate(() => { const i = window.__nukki.items[window.__nukki.items.length - 1]; return { y: i.y, h: i.h, off: i.floorOff }; });
  ok(Math.abs(landed.y + landed.h + landed.off - floor) < 1.5, "and lands on the floor");
  await shot(page, "8-dropped-in");

  ok(errors.length === 0, "no page errors " + JSON.stringify(errors));
  await browser.close();
  console.log(failed ? `${failed} FAILED` : "all e2e checks passed");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
