import { Segmenter, buildCutout } from "./segment.js";
import * as P from "./physics.js";
import * as store from "./store.js";

const $ = (id) => document.getElementById(id);
const LONG_PRESS_MS = 1000; // hold this long on an object to cut it out
const MOVE_CANCEL = 12; // px of finger travel that cancels a long-press
const HOVER_MS = 350; // hover time on the vault tab before the view switches
const PHOTO_MAX = 1280;

const seg = new Segmenter();
const el = {
  camView: $("camView"), vaultView: $("vaultView"), video: $("video"), photoBox: $("photoBox"), photo: $("photo"),
  camMsg: $("camMsg"), camMsgText: $("camMsgText"), hint: $("hint"), shutterRow: $("shutterRow"), shutter: $("shutter"),
  retake: $("retake"), flash: $("flash"), vaultItems: $("vaultItems"), floorLine: $("floorLine"), emptyMsg: $("emptyMsg"),
  dragLayer: $("dragLayer"), trash: $("trash"), ring: $("ring"), toast: $("toast"), tabs: $("tabs"),
  tabCam: $("tabCam"), tabVault: $("tabVault"), badge: $("badge"),
};

let view = "cam"; // "cam" | "vault"
let camMode = "live"; // "live" | "photo"
let stream = null;
let camToken = 0;
let photoRect = { x: 0, y: 0, w: 1, h: 1 };
let sticker = null; // freshly cut-out item, not yet in the vault
let busy = false; // a cut-out is being computed
const items = []; // vault items
const falling = new Set();
let drag = null;
let press = null;
const pointer = { id: null, down: false, x: 0, y: 0 };

/* ---------- helpers ---------- */
const W = () => window.innerWidth;
const H = () => window.innerHeight;
const floorY = () => el.tabs.getBoundingClientRect().top - 8;

let toastTimer = 0;
function toast(msg, ms = 2200) {
  el.toast.textContent = msg;
  el.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove("show"), ms);
}

function canvasToBlob(canvas) {
  return new Promise((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob failed"))), "image/png"));
}

function applyPos(it) {
  it.el.style.transform = `translate3d(${it.x}px, ${it.y}px, 0)`;
}
function applySize(it) {
  it.el.style.width = it.w + "px";
  it.el.style.height = it.h + "px";
}

// Low-res alpha map so touches on transparent pixels fall through to the item below.
async function buildAlpha(img) {
  const k = Math.min(1, 96 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const a = new Uint8Array(w * h);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return { a, w, h };
}
function alphaAt(it, x, y) {
  const u = Math.min(it.alpha.w - 1, Math.max(0, Math.floor(((x - it.x) / it.w) * it.alpha.w)));
  const v = Math.min(it.alpha.h - 1, Math.max(0, Math.floor(((y - it.y) / it.h) * it.alpha.h)));
  return it.alpha.a[v * it.alpha.w + u];
}

async function makeItem(blob, nw, nh) {
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.className = "item";
  img.draggable = false;
  img.alt = "";
  img.src = url;
  await img.decode();
  const alpha = await buildAlpha(img);
  return { id: crypto.randomUUID(), el: img, url, blob, nw, nh, x: 0, y: 0, w: nw, h: nh, z: 1, vy: 0, xc: 0.5, floorOff: 0, wFrac: 0.3, alpha };
}

/* ---------- views ---------- */
function setView(v) {
  view = v;
  el.camView.hidden = v !== "cam";
  el.vaultView.hidden = v !== "vault";
  el.tabCam.classList.toggle("active", v === "cam");
  el.tabVault.classList.toggle("active", v === "vault");
  if (sticker && !(drag && drag.it === sticker)) sticker.el.hidden = v !== "cam";
  if (v === "vault") {
    stopStream();
    layoutVault();
  } else if (camMode === "live") {
    startCamera();
  } else {
    layoutPhoto();
  }
  updateHint();
}

function updateHint() {
  if (view !== "cam") { el.hint.textContent = ""; return; }
  if (camMode === "live") el.hint.textContent = "물건을 비추고 셔터를 누르세요";
  else if (sticker) el.hint.textContent = "스티커를 아래 '보관함' 탭으로 끌어다 놓으세요";
  else el.hint.textContent = "물건을 1초 꾹 누르면 누끼를 따요";
}

function updateBadge() {
  el.badge.hidden = items.length === 0;
  el.badge.textContent = items.length;
  el.emptyMsg.hidden = items.length > 0 || !!(drag && drag.it.stored === false);
}

function layoutVault() {
  const fy = floorY();
  el.floorLine.style.top = fy + "px";
  for (const it of items) {
    if (drag && drag.it === it) continue;
    const s = P.itemSize(it.nw, it.nh, it.wFrac, W());
    it.w = s.w;
    it.h = s.h;
    it.x = it.xc * W() - it.w / 2;
    if (!falling.has(it)) it.y = P.restTop(fy, it.h, it.floorOff);
    applySize(it);
    applyPos(it);
  }
}

/* ---------- camera / photo ---------- */
async function startCamera() {
  if (stream || camMode !== "live") return;
  const token = ++camToken;
  el.photoBox.hidden = true;
  el.video.hidden = false;
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    if (token !== camToken || view !== "cam" || camMode !== "live") { s.getTracks().forEach((t) => t.stop()); return; }
    stream = s;
    el.video.srcObject = s;
    await el.video.play().catch(() => {});
    el.camMsg.hidden = true;
    el.shutterRow.hidden = false;
  } catch (e) {
    console.warn("camera unavailable:", e);
    el.camMsgText.textContent = window.isSecureContext
      ? "카메라를 사용할 수 없어요. 권한을 허용했는지 확인하거나, 아래 방법으로 사진을 가져오세요."
      : "카메라는 HTTPS(또는 localhost)에서만 쓸 수 있어요. 아래 방법으로 사진을 가져오세요.";
    el.camMsg.hidden = false;
    el.shutterRow.hidden = true;
  }
}

function stopStream() {
  camToken++;
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  el.video.srcObject = null;
}

function layoutPhoto() {
  if (camMode !== "photo") return;
  const availW = W();
  const availH = el.tabs.getBoundingClientRect().top;
  const k = Math.min(availW / el.photo.width, availH / el.photo.height);
  const w = el.photo.width * k;
  const h = el.photo.height * k;
  photoRect = { x: (availW - w) / 2, y: (availH - h) / 2, w, h };
  Object.assign(el.photoBox.style, { left: photoRect.x + "px", top: photoRect.y + "px", width: w + "px", height: h + "px" });
}

function showPhoto() {
  camMode = "photo";
  stopStream();
  el.video.hidden = true;
  el.camMsg.hidden = true;
  el.photoBox.hidden = false;
  el.shutterRow.hidden = true;
  el.retake.hidden = false;
  clearSticker();
  layoutPhoto();
  updateHint();
  seg.init(); // start loading the model while the user looks at the photo
}

function drawToPhoto(source, sw, sh) {
  const k = Math.min(1, PHOTO_MAX / Math.max(sw, sh));
  el.photo.width = Math.round(sw * k);
  el.photo.height = Math.round(sh * k);
  el.photo.getContext("2d").drawImage(source, 0, 0, el.photo.width, el.photo.height);
}

function capture() {
  const v = el.video;
  if (!v.videoWidth) return;
  drawToPhoto(v, v.videoWidth, v.videoHeight);
  el.flash.classList.remove("on");
  void el.flash.offsetWidth;
  el.flash.classList.add("on");
  showPhoto();
}

async function loadFile(file) {
  if (!file) return;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    drawToPhoto(bmp, bmp.width, bmp.height);
    showPhoto();
    if (view !== "cam") setView("cam");
  } catch (e) {
    toast("사진을 불러오지 못했어요");
  }
}

function retake() {
  camMode = "live";
  clearSticker();
  el.retake.hidden = true;
  el.photoBox.hidden = true;
  startCamera();
  updateHint();
}

function clearSticker() {
  if (!sticker) return;
  sticker.el.remove();
  URL.revokeObjectURL(sticker.url);
  sticker = null;
}

/* ---------- long press → cut-out ---------- */
function showRing(x, y, mode) {
  el.ring.style.left = x + "px";
  el.ring.style.top = y + "px";
  el.ring.className = mode;
  el.ring.hidden = false;
}
function hideRing() { el.ring.hidden = true; el.ring.className = ""; }

function startPress(x, y, pid) {
  press = { x, y, pid, t: setTimeout(fireLongPress, LONG_PRESS_MS) };
  showRing(x, y, "press");
}
function cancelPress() {
  if (!press) return;
  clearTimeout(press.t);
  press = null;
  hideRing();
}

async function fireLongPress() {
  if (!press) return;
  const { x, y, pid } = press;
  press = null;
  busy = true;
  showRing(x, y, "scan");
  if (navigator.vibrate) navigator.vibrate(25);
  try {
    if (!seg.seg && !seg.failed) toast("AI 준비 중… 처음엔 조금 걸려요", 4000);
    const nx = (x - photoRect.x) / photoRect.w;
    const ny = (y - photoRect.y) / photoRect.h;
    const r = await seg.segmentAt(el.photo, nx, ny);
    const cut = r && buildCutout(el.photo, r.mask, r.w, r.h);
    if (!cut) { toast("물건을 찾지 못했어요. 다른 곳을 눌러 보세요"); return; }
    if (r.engine === "fallback") toast("간이 모드로 분리했어요 (단순한 배경에서 가장 잘 돼요)", 3200);

    clearSticker();
    const blob = await canvasToBlob(cut.canvas);
    const it = await makeItem(blob, cut.canvas.width, cut.canvas.height);
    const s = photoRect.w / el.photo.width;
    it.w = cut.box.w * s;
    it.h = cut.box.h * s;
    it.x = photoRect.x + cut.box.x * s;
    it.y = photoRect.y + cut.box.y * s;
    it.stored = false;
    applySize(it);
    applyPos(it);
    it.el.style.zIndex = 5;
    it.el.classList.add("pop");
    el.dragLayer.appendChild(it.el);
    sticker = it;
    updateHint();
    // Finger still down: keep dragging straight away, like lifting an app icon.
    if (pointer.down && pointer.id === pid) startDrag(it, "cam", pointer.x, pointer.y, pid);
  } catch (e) {
    console.error(e);
    toast("누끼를 따지 못했어요");
  } finally {
    busy = false;
    hideRing();
  }
}

/* ---------- dragging ---------- */
function startDrag(it, from, x, y, pid) {
  falling.delete(it);
  it.vy = 0;
  drag = { it, from, pid, offX: x - it.x, offY: y - it.y, hoverT: 0, hot: false, trashHot: false, moved: false, sx: x, sy: y };
  it.el.classList.add("lifted");
  it.el.classList.remove("pop");
  if (from === "vault") bringToFront(it);
  if (from === "vault") el.trash.hidden = false;
  if (navigator.vibrate) navigator.vibrate(10);
}

function bringToFront(it) {
  it.z = P.nextZ(items);
  it.el.style.zIndex = it.z;
}

function moveDrag(x, y) {
  const it = drag.it;
  if (!drag.moved && Math.hypot(x - drag.sx, y - drag.sy) > 6) drag.moved = true;
  it.x = Math.min(W() - it.w * 0.3, Math.max(-it.w * 0.7, x - drag.offX));
  it.y = Math.min(H() - it.h * 0.3, Math.max(-it.h * 0.7, y - drag.offY));
  applyPos(it);

  if (drag.from === "cam" && view === "cam") {
    const over = P.inRect(P.inflate(el.tabVault.getBoundingClientRect(), 14), x, y);
    if (over && !drag.hot) {
      drag.hot = true;
      el.tabVault.classList.add("hot");
      drag.hoverT = setTimeout(() => enterVaultWithDrag(), HOVER_MS);
    } else if (!over && drag.hot) {
      drag.hot = false;
      el.tabVault.classList.remove("hot");
      clearTimeout(drag.hoverT);
    }
  }
  if (drag.from === "vault") {
    const over = P.inRect(P.inflate(el.trash.getBoundingClientRect(), 10), x, y);
    drag.trashHot = over;
    el.trash.classList.toggle("hot", over);
  }
}

// Switch to the vault while the finger stays down, shrinking the item to vault size.
function enterVaultWithDrag() {
  if (!drag || view === "vault") return;
  clearTimeout(drag.hoverT);
  drag.hot = false;
  el.tabVault.classList.remove("hot");
  const it = drag.it;
  const f = P.vaultFit(it.w, it.h, W(), H());
  it.el.classList.add("resizing");
  it.w = f.w;
  it.h = f.h;
  drag.offX *= f.k;
  drag.offY *= f.k;
  it.x = pointer.x - drag.offX;
  it.y = pointer.y - drag.offY;
  applySize(it);
  applyPos(it);
  setView("vault");
  setTimeout(() => it.el.classList.remove("resizing"), 300);
  toast("놓으면 보관함에 담겨요", 1600);
}

async function endDrag() {
  const d = drag;
  if (!d) return;
  drag = null;
  clearTimeout(d.hoverT);
  el.tabVault.classList.remove("hot");
  el.trash.hidden = true;
  el.trash.classList.remove("hot");
  const it = d.it;
  it.el.classList.remove("lifted");

  if (d.from === "cam") {
    const releasedOnTab = d.hot;
    if (view === "cam" && releasedOnTab) {
      drag = d; // enterVaultWithDrag reads the drag state
      enterVaultWithDrag();
      drag = null;
    }
    if (view === "vault") await dropIntoVault(it);
    updateHint();
    return;
  }

  if (d.trashHot) {
    await removeItem(it);
    return;
  }
  const s = P.itemSize(it.nw, it.nh, it.wFrac, W());
  it.xc = P.clampCenterX((it.x + s.w / 2) / W());
  if (d.moved) startFall(it);
  await persist(it);
}

async function dropIntoVault(it) {
  sticker = null;
  it.stored = true;
  el.vaultItems.appendChild(it.el);
  it.wFrac = Math.min(0.7, it.w / W());
  it.xc = P.clampCenterX((it.x + it.w / 2) / W());
  it.floorOff = Math.round(Math.random() * 26);
  it.z = P.nextZ(items);
  it.el.style.zIndex = it.z;
  items.push(it);
  updateBadge();
  // Let it visibly fall in: from above the screen if it was let go near the floor.
  const y0 = P.dropStartY(it.y, P.restTop(floorY(), it.h, it.floorOff), it.h);
  if (y0 !== it.y) {
    it.y = y0;
    applyPos(it);
    it.el.classList.add("pop");
    setTimeout(() => it.el.classList.remove("pop"), 350);
  }
  startFall(it);
  try {
    await persist(it);
    toast("보관함에 담았어요 ✨", 1600);
  } catch (e) {
    console.error(e);
    toast("저장에 실패했어요 (브라우저 저장공간 확인)");
  }
}

function persist(it) {
  return store.put({ id: it.id, blob: it.blob, nw: it.nw, nh: it.nh, wFrac: it.wFrac, xc: it.xc, floorOff: it.floorOff, z: it.z });
}

async function removeItem(it) {
  falling.delete(it);
  const i = items.indexOf(it);
  if (i >= 0) items.splice(i, 1);
  it.el.remove();
  URL.revokeObjectURL(it.url);
  updateBadge();
  await store.remove(it.id);
  toast("삭제했어요");
}

/* ---------- gravity ---------- */
let raf = 0;
let lastT = 0;
function startFall(it) {
  it.vy = 0;
  falling.add(it);
  if (!raf) { lastT = performance.now(); raf = requestAnimationFrame(tick); }
}
function tick(t) {
  const dt = (t - lastT) / 1000;
  lastT = t;
  const fy = floorY();
  for (const it of falling) {
    const rest = P.restTop(fy, it.h, it.floorOff);
    const s = P.stepFall({ y: it.y, vy: it.vy }, dt, rest);
    it.y = s.y;
    it.vy = s.vy;
    applyPos(it);
    if (s.settled) falling.delete(it);
  }
  raf = falling.size ? requestAnimationFrame(tick) : 0;
}

/* ---------- pointer routing ---------- */
function onDown(e) {
  if (e.target.closest("button, label, nav")) return;
  if (pointer.down) return; // single-pointer only
  pointer.id = e.pointerId;
  pointer.down = true;
  pointer.x = e.clientX;
  pointer.y = e.clientY;

  if (view === "vault") {
    const hit = P.pickTop(items, e.clientX, e.clientY, alphaAt);
    if (hit) startDrag(hit, "vault", e.clientX, e.clientY, e.pointerId);
    return;
  }
  if (camMode !== "photo" || busy) return;
  if (sticker && P.pickTop([sticker], e.clientX, e.clientY, alphaAt)) {
    startDrag(sticker, "cam", e.clientX, e.clientY, e.pointerId);
    return;
  }
  if (P.inRect({ left: photoRect.x, top: photoRect.y, right: photoRect.x + photoRect.w, bottom: photoRect.y + photoRect.h }, e.clientX, e.clientY)) {
    startPress(e.clientX, e.clientY, e.pointerId);
  }
}

function onMove(e) {
  if (e.pointerId !== pointer.id) return;
  pointer.x = e.clientX;
  pointer.y = e.clientY;
  if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > MOVE_CANCEL) cancelPress();
  if (drag) moveDrag(e.clientX, e.clientY);
}

function onUp(e) {
  if (e.pointerId !== pointer.id) return;
  pointer.down = false;
  pointer.id = null;
  cancelPress();
  if (drag) endDrag();
}

/* ---------- boot ---------- */
async function loadVault() {
  let recs = [];
  try { recs = await store.getAll(); } catch (e) { console.warn("storage unavailable", e); toast("저장공간을 쓸 수 없어요"); }
  recs.sort((a, b) => a.z - b.z);
  for (const r of recs) {
    const it = await makeItem(r.blob, r.nw, r.nh);
    Object.assign(it, { id: r.id, wFrac: r.wFrac, xc: r.xc, floorOff: r.floorOff, z: r.z, stored: true });
    it.el.style.zIndex = it.z;
    el.vaultItems.appendChild(it.el);
    items.push(it);
  }
  updateBadge();
  layoutVault();
}

document.addEventListener("pointerdown", onDown);
window.addEventListener("pointermove", onMove);
window.addEventListener("pointerup", onUp);
window.addEventListener("pointercancel", onUp);
document.addEventListener("contextmenu", (e) => e.preventDefault());
window.addEventListener("resize", () => { layoutPhoto(); layoutVault(); });
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopStream();
  else if (view === "cam" && camMode === "live") startCamera();
});

el.shutter.addEventListener("click", capture);
el.retake.addEventListener("click", retake);
el.tabCam.addEventListener("click", () => { if (view !== "cam") setView("cam"); });
el.tabVault.addEventListener("click", () => { if (view !== "vault") setView("vault"); });
for (const id of ["fileCapture", "fileGallery", "fileGallery2"]) {
  $(id).addEventListener("change", (e) => { loadFile(e.target.files[0]); e.target.value = ""; });
}

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Hooks for automated tests.
window.__nukki = { items, get sticker() { return sticker; }, get view() { return view; }, seg };

await loadVault();
updateHint();
startCamera();
