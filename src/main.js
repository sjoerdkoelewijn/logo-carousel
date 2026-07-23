// main.js — carrousel-composer. Meerdere logo's → elk via de pipeline naar mono vector,
// globale kleur/gladheid/mode, per-logo schaal, gedeeld export-frame, batch-ZIP.

import {
  estimateBackground,
  hasAlpha,
  autoThreshold,
  foregroundField,
  fieldToBilevelCanvas,
} from "./pipeline.js";
import { vectorize } from "./vectorize.js";
import { makeZip } from "./zip.js";

const MAX_SIDE = 2400;
const UPSCALE_TARGET = 2400;
const MAX_UPSCALE = 5;
const TRACE_TARGET = 2400;
const SMOOTH_BLUR_MAX = 5;
const MAX_DIST = Math.sqrt(3 * 255 * 255);
const STORE_KEY = "logo-tool.settings";

// ---- DOM ----
const $ = (id) => document.getElementById(id);
const dropZone = $("drop-zone");
const fileInput = $("file-input");
const workspace = $("workspace");
const notice = $("notice");
const statusEl = $("status");
const svgPreview = $("svg-preview");
const viewport = $("preview-viewport");
const zoomLabel = $("zoom-label");
const detailName = $("detail-name");
const carouselEl = $("carousel");

const colorInput = $("color-input");
const colorHex = $("color-hex");
const smoothing = $("smoothing");
const canvasModeEl = $("canvas-mode");
const sizeRow = $("size-row");
const canvasW = $("canvas-w");
const canvasH = $("canvas-h");
const bgColor = $("bg-color");

// ---- state ----
let logos = []; // { id, name, src:ImageData, hasAlpha, svg, natW, natH, scale, el }
let selectedId = null;
let idSeq = 0;
let canvasMode = "landscape"; // landscape | square | custom
let carouselBg = "dark"; // light | dark | custom
const LANDSCAPE = { W: 800, H: 400 };
const SQUARE = { W: 500, H: 500 };

// ---- settings ----
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (s.color) { colorInput.value = s.color; colorHex.value = s.color; }
    if (s.smoothing != null) smoothing.value = s.smoothing;
    if (s.canvasW) canvasW.value = s.canvasW;
    if (s.canvasH) canvasH.value = s.canvasH;
    if (s.canvasMode) canvasMode = s.canvasMode;
    if (s.bgColor) bgColor.value = s.bgColor;
    if (s.bg) carouselBg = s.bg;
  } catch {}
  setCanvasMode(canvasMode);
  setCarouselBg(carouselBg);
  syncLabels();
}
function saveSettings() {
  localStorage.setItem(STORE_KEY, JSON.stringify({
    color: colorHex.value, smoothing: smoothing.value,
    canvasMode, canvasW: canvasW.value, canvasH: canvasH.value,
    bg: carouselBg, bgColor: bgColor.value,
  }));
}

// Achtergrond van de carrousel-strip (om logo's tegen de bedoelde site-bg te checken).
function setCarouselBg(bg) {
  carouselBg = bg;
  carouselEl.className = "carousel" + (bg === "custom" ? "" : " bg-" + bg);
  carouselEl.style.background = bg === "custom" ? bgColor.value : "";
  viewport.style.background = bgCss();
  bgColor.hidden = bg !== "custom";
  for (const b of $("bg-toggle").querySelectorAll("button"))
    b.classList.toggle("active", b.dataset.bg === bg);
}
$("bg-toggle").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  setCarouselBg(btn.dataset.bg);
  saveSettings();
});
bgColor.addEventListener("input", () => {
  if (carouselBg === "custom") {
    carouselEl.style.background = bgColor.value;
    viewport.style.background = bgColor.value;
  }
  saveSettings();
});

function syncLabels() {
  $("smoothing-val").textContent = Number(smoothing.value).toFixed(2);
}

function setStatus(msg) { statusEl.textContent = msg || ""; }
function showNotice(msg) { notice.textContent = msg || ""; notice.hidden = !msg; }

function setCanvasMode(mode) {
  canvasMode = mode;
  sizeRow.hidden = mode !== "custom";
  for (const b of canvasModeEl.querySelectorAll("button"))
    b.classList.toggle("active", b.dataset.mode === mode);
  updateAllFrameBoxes();
  renderDetail();
}
function getCanvasSize() {
  if (canvasMode === "landscape") return { ...LANDSCAPE };
  if (canvasMode === "square") return { ...SQUARE };
  const clampN = (v, d) => {
    const n = Math.round(Number(v));
    return Number.isFinite(n) ? Math.min(4000, Math.max(16, n)) : d;
  };
  return { W: clampN(canvasW.value, 800), H: clampN(canvasH.value, 400) };
}

// ---- input ----
$("browse-btn").addEventListener("click", () => fileInput.click());
$("add-more-btn").addEventListener("click", () => fileInput.click());
document.querySelector(".hero-drop").addEventListener("click", (e) => {
  if (e.target.closest("button")) return; // de "choose files"-knop heeft z'n eigen handler
  fileInput.click();
});
fileInput.addEventListener("change", (e) => {
  if (e.target.files.length) loadFiles([...e.target.files]);
  fileInput.value = "";
});
["dragenter", "dragover"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.add("dragover"); }));
["dragleave"].forEach((ev) =>
  dropZone.addEventListener(ev, (e) => { e.preventDefault(); dropZone.classList.remove("dragover"); }));
// Overal in het venster kunnen droppen (ook wanneer de hero verborgen is).
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dropZone.classList.remove("dragover");
  const files = [...(e.dataTransfer?.files || [])].filter((f) => f.type.startsWith("image/"));
  if (files.length) loadFiles(files);
});
window.addEventListener("paste", (e) => {
  const imgs = [...(e.clipboardData?.items || [])]
    .filter((i) => i.type.startsWith("image/")).map((i) => i.getAsFile());
  if (imgs.length) loadFiles(imgs);
});

$("reset-btn").addEventListener("click", () => {
  logos = [];
  selectedId = null;
  carouselEl.innerHTML = "";
  svgPreview.innerHTML = "";
  detailName.textContent = "—";
  workspace.hidden = true;
  dropZone.hidden = false;
  showNotice("");
  setStatus("");
});

// ---- controls (globaal) ----
colorInput.addEventListener("input", () => { colorHex.value = colorInput.value; recolorAll(); });
colorHex.addEventListener("change", () => {
  if (/^#?[0-9a-f]{6}$/i.test(colorHex.value)) {
    const v = colorHex.value.startsWith("#") ? colorHex.value : "#" + colorHex.value;
    colorHex.value = v; colorInput.value = v; recolorAll();
  }
});
smoothing.addEventListener("input", () => { syncLabels(); saveSettings(); scheduleReprocess(); });

canvasModeEl.addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  setCanvasMode(btn.dataset.mode);
  saveSettings();
});
[canvasW, canvasH].forEach((el) =>
  el.addEventListener("input", () => { saveSettings(); updateAllFrameBoxes(); renderDetail(); }));

let reprocessTimer;
function scheduleReprocess() {
  clearTimeout(reprocessTimer);
  reprocessTimer = setTimeout(reprocessAll, 150);
}

// ---- laden ----
async function loadFiles(files) {
  dropZone.hidden = true;
  workspace.hidden = false;
  showNotice("");
  let added = null;
  for (let k = 0; k < files.length; k++) {
    setStatus(`Loading ${k + 1}/${files.length}…`);
    try {
      const bitmap = await fileToImage(files[k]);
      const { imageData, alpha } = drawSource(bitmap);
      const logo = {
        id: ++idSeq,
        name: files[k].name || `logo-${idSeq}`,
        src: imageData,
        hasAlpha: alpha,
        svg: "", natW: 0, natH: 0, scale: 1, el: null,
      };
      logos.push(logo);
      addFrame(logo);
      setStatus(`Vectorizing ${k + 1}/${files.length}…`);
      await traceLogo(logo);
      renderFrame(logo);
      added = logo.id;
    } catch (err) {
      console.error(err);
      showNotice(`Couldn't load "${files[k]?.name}".`);
    }
  }
  if (added) selectLogo(added);
  setStatus("");
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("image load error")); };
    img.src = url;
  });
}

function smoothResize(src, sw, sh, dw, dh) {
  const mk = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w; c.height = h;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.imageSmoothingEnabled = true; x.imageSmoothingQuality = "high";
    return { c, x };
  };
  let cur = src, cw = sw, ch = sh;
  while (cw > dw * 2 || ch > dh * 2) {
    const nw = Math.max(dw, Math.floor(cw / 2)), nh = Math.max(dh, Math.floor(ch / 2));
    const { c, x } = mk(nw, nh); x.drawImage(cur, 0, 0, nw, nh); cur = c; cw = nw; ch = nh;
  }
  while (cw < dw / 2 || ch < dh / 2) {
    const nw = Math.min(dw, cw * 2), nh = Math.min(dh, ch * 2);
    const { c, x } = mk(nw, nh); x.drawImage(cur, 0, 0, nw, nh); cur = c; cw = nw; ch = nh;
  }
  const { c, x } = mk(dw, dh); x.drawImage(cur, 0, 0, dw, dh); return c;
}

function drawSource(img) {
  const ow = img.naturalWidth || img.width || 1024;
  const oh = img.naturalHeight || img.height || 1024;
  const longest = Math.max(ow, oh);
  let scale = 1;
  if (longest > MAX_SIDE) scale = MAX_SIDE / longest;
  else if (longest < UPSCALE_TARGET) scale = Math.min(UPSCALE_TARGET / longest, MAX_UPSCALE);
  const w = Math.round(ow * scale), h = Math.round(oh * scale);
  const canvas = smoothResize(img, ow, oh, w, h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const imageData = ctx.getImageData(0, 0, w, h);
  return { imageData, alpha: hasAlpha(imageData) };
}

// ---- verwerking per logo ----
function cloneImageData(src) {
  return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
}

function computeField(logo, img) {
  if (logo.hasAlpha) {
    const { data } = img;
    const field = new Uint8ClampedArray(data.length / 4);
    for (let j = 0; j < field.length; j++) field[j] = data[j * 4 + 3];
    return { field, threshByte: 128 };
  }
  // Altijd "Overal, letters open": anti-aliased voorgrondveld → strakste randen.
  const { color: bg } = estimateBackground(img);
  const t = autoThreshold(img, bg);
  return { field: foregroundField(img, bg), threshByte: Math.round((t / MAX_DIST) * 255) };
}

async function traceLogo(logo) {
  const img = cloneImageData(logo.src);
  const { field, threshByte } = computeField(logo, img);
  const blurPx = Number(smoothing.value) * SMOOTH_BLUR_MAX;
  const bilevel = fieldToBilevelCanvas(field, img.width, img.height, TRACE_TARGET, threshByte, blurPx);
  const svg = await vectorize(bilevel, {
    turdSize: 0, alphamax: 1.0, optTolerance: 0.6, fill: colorHex.value,
  });
  logo.svg = svg;
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  logo.natW = m ? +m[1] : TRACE_TARGET;
  logo.natH = m ? +m[2] : TRACE_TARGET;
}

async function reprocessAll() {
  if (!logos.length) return;
  for (let i = 0; i < logos.length; i++) {
    setStatus(`Vectorizing ${i + 1}/${logos.length}…`);
    await traceLogo(logos[i]);
    renderFrame(logos[i]);
    if (logos[i].id === selectedId) renderDetail();
  }
  setStatus("");
}

function recolorAll() {
  saveSettings();
  const fill = colorHex.value;
  for (const logo of logos) {
    if (!logo.svg) continue;
    logo.svg = logo.svg.replace(/fill="[^"]*"/, `fill="${fill}"`);
    renderFrame(logo);
  }
  renderDetail();
}

// ---- carrousel rendering ----
function svgDataUrl(svg) {
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
}

// Frame-box maat op basis van de export-aspect (vaste hoogte, breedte volgt aspect).
function frameBoxSize() {
  const { W, H } = getCanvasSize();
  const boxH = 150;
  let boxW = Math.round((boxH * W) / H);
  boxW = Math.min(320, Math.max(60, boxW));
  return { boxW, boxH };
}

function addFrame(logo) {
  const el = document.createElement("div");
  el.className = "frame";
  el.dataset.id = logo.id;
  el.innerHTML = `
    <button class="frame-remove" title="Remove">×</button>
    <div class="frame-box">
      <img class="frame-img" alt=""/>
      <div class="frame-scale-wrap"><input class="frame-scale" type="range" min="0.2" max="2" step="0.01" value="${logo.scale}" /></div>
    </div>
    <div class="frame-name"></div>`;
  el.querySelector(".frame-name").textContent = logo.name;
  el.querySelector(".frame-remove").addEventListener("click", (e) => {
    e.stopPropagation(); removeLogo(logo.id);
  });
  const scaleInput = el.querySelector(".frame-scale");
  scaleInput.addEventListener("input", (e) => {
    e.stopPropagation();
    logo.scale = Number(scaleInput.value);
    updateFrameImg(logo);
    if (logo.id === selectedId) renderDetail();
  });
  el.addEventListener("click", () => selectLogo(logo.id));
  carouselEl.appendChild(el);
  logo.el = el;
  applyFrameBox(logo);
  updateCarouselNav();
}

function applyFrameBox(logo) {
  const { boxW, boxH } = frameBoxSize();
  const box = logo.el.querySelector(".frame-box");
  box.style.width = boxW + "px";
  box.style.height = boxH + "px";
}

function updateAllFrameBoxes() {
  for (const logo of logos) if (logo.el) applyFrameBox(logo);
  updateCarouselNav();
}

// Zet de <img> (svg) en schaal binnen het frame.
function updateFrameImg(logo) {
  if (!logo.el) return;
  const img = logo.el.querySelector(".frame-img");
  img.style.transform = `scale(${logo.scale})`;
}

function renderFrame(logo) {
  if (!logo.el || !logo.svg) return;
  const img = logo.el.querySelector(".frame-img");
  img.src = svgDataUrl(logo.svg);
  img.style.transform = `scale(${logo.scale})`;
}

function removeLogo(id) {
  const logo = logos.find((l) => l.id === id);
  if (logo?.el) logo.el.remove();
  logos = logos.filter((l) => l.id !== id);
  if (selectedId === id) {
    selectedId = null;
    if (logos.length) selectLogo(logos[0].id);
    else { svgPreview.innerHTML = ""; detailName.textContent = "—"; }
  }
  if (!logos.length) { workspace.hidden = true; dropZone.hidden = false; }
  updateCarouselNav();
}

function selectLogo(id) {
  selectedId = id;
  const logo = logos.find((l) => l.id === id);
  if (!logo) return;
  for (const l of logos) l.el?.classList.toggle("selected", l.id === id);
  renderDetail();
}

// De detail-preview toont het geselecteerde logo IN het export-frame: de viewport
// krijgt de canvas-aspect (landscape/vierkant/custom) en de gekozen achtergrond,
// met het logo op zijn export-plek (contain-fit × schaal). Zoombaar voor kwaliteit.
function bgCss() {
  return carouselBg === "dark" ? "#0e0e0e" : carouselBg === "custom" ? bgColor.value : "#f2f2f2";
}
function sizeViewport(W, H) {
  const availW = viewport.parentElement?.clientWidth || 800;
  const maxH = Math.round(window.innerHeight * 0.56);
  let w = availW, h = Math.round((w * H) / W);
  if (h > maxH) { h = maxH; w = Math.round((h * W) / H); }
  viewport.style.width = w + "px";
  viewport.style.height = h + "px";
}
function renderDetail() {
  const logo = logos.find((l) => l.id === selectedId);
  if (!logo || !logo.svg) { svgPreview.innerHTML = ""; detailName.textContent = "—"; return; }
  const { W, H } = getCanvasSize();
  detailName.textContent = logo.name;
  viewport.style.background = bgCss();
  sizeViewport(W, H);
  svgPreview.innerHTML = framedSvg(logo, W, H);
  fitView();
}

// ---- export ----
function placement(logo, W, H) {
  const fit = Math.min(W / logo.natW, H / logo.natH);
  const s = fit * logo.scale;
  const pw = logo.natW * s, ph = logo.natH * s;
  return { px: (W - pw) / 2, py: (H - ph) / 2, pw, ph };
}

function framedSvg(logo, W, H) {
  const { px, py, pw, ph } = placement(logo, W, H);
  const inner = logo.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<svg x="${px.toFixed(2)}" y="${py.toFixed(2)}" width="${pw.toFixed(2)}" height="${ph.toFixed(2)}" ` +
    `viewBox="0 0 ${logo.natW} ${logo.natH}" preserveAspectRatio="xMidYMid meet">${inner}</svg></svg>`;
}

function safeName(name, i) {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 40) || "logo";
  return String(i + 1).padStart(2, "0") + "_" + base;
}

$("download-zip").addEventListener("click", async () => {
  if (!logos.length) return;
  const { W, H } = getCanvasSize();
  setStatus("Creating ZIP…");
  try {
    const enc = new TextEncoder();
    const entries = logos.map((logo, i) => ({
      name: safeName(logo.name, i) + ".svg",
      data: enc.encode(framedSvg(logo, W, H)),
    }));
    downloadBlob(makeZip(entries), `logos-${W}x${H}.zip`);
    setStatus("");
  } catch (err) {
    console.error(err);
    setStatus("ZIP export failed.");
  }
});

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---- pan & zoom (detail-preview) ----
const view = { scale: 1, tx: 0, ty: 0, fit: 1 };
function currentSvgSize() {
  const svg = svgPreview.querySelector("svg");
  if (!svg) return null;
  return {
    w: svg.width?.baseVal?.value || svg.viewBox?.baseVal?.width || 2000,
    h: svg.height?.baseVal?.value || svg.viewBox?.baseVal?.height || 1000,
  };
}
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const minScale = () => view.fit;
const maxScale = () => Math.max(view.fit * 200, 40);
function clampPan() {
  const size = currentSvgSize();
  if (!size) return;
  const vp = viewport.getBoundingClientRect();
  const cw = size.w * view.scale, ch = size.h * view.scale;
  view.tx = cw <= vp.width ? (vp.width - cw) / 2 : clamp(view.tx, vp.width - cw, 0);
  view.ty = ch <= vp.height ? (vp.height - ch) / 2 : clamp(view.ty, vp.height - ch, 0);
}
function applyTransform() {
  clampPan();
  svgPreview.style.transform = `translate(${view.tx}px, ${view.ty}px) scale(${view.scale})`;
  zoomLabel.textContent = Math.round((view.scale / view.fit) * 100) + "%";
}
function fitView() {
  const size = currentSvgSize();
  if (!size) return;
  const vp = viewport.getBoundingClientRect();
  const fit = Math.min(vp.width / size.w, vp.height / size.h) * 0.95;
  view.fit = fit; view.scale = fit;
  view.tx = (vp.width - size.w * fit) / 2;
  view.ty = (vp.height - size.h * fit) / 2;
  applyTransform();
}
function zoomAt(px, py, factor) {
  const newScale = clamp(view.scale * factor, minScale(), maxScale());
  const k = newScale / view.scale;
  view.tx = px - k * (px - view.tx);
  view.ty = py - k * (py - view.ty);
  view.scale = newScale;
  applyTransform();
}
viewport.addEventListener("wheel", (e) => {
  if (!currentSvgSize()) return;
  e.preventDefault();
  const rect = viewport.getBoundingClientRect();
  zoomAt(e.clientX - rect.left, e.clientY - rect.top, Math.exp(-e.deltaY * 0.0015));
}, { passive: false });
let panning = false, panStart = null;
viewport.addEventListener("pointerdown", (e) => {
  if (!currentSvgSize() || e.target.closest(".zoom-toolbar")) return;
  panning = true;
  panStart = { x: e.clientX, y: e.clientY, tx: view.tx, ty: view.ty };
  svgPreview.classList.add("grabbing");
  viewport.setPointerCapture(e.pointerId);
});
viewport.addEventListener("pointermove", (e) => {
  if (!panning) return;
  view.tx = panStart.tx + (e.clientX - panStart.x);
  view.ty = panStart.ty + (e.clientY - panStart.y);
  applyTransform();
});
const endPan = () => { panning = false; svgPreview.classList.remove("grabbing"); };
viewport.addEventListener("pointerup", endPan);
viewport.addEventListener("pointercancel", endPan);
viewport.addEventListener("dblclick", fitView);
function zoomCenter(factor) {
  const vp = viewport.getBoundingClientRect();
  zoomAt(vp.width / 2, vp.height / 2, factor);
}
$("zoom-in").addEventListener("click", () => zoomCenter(1.25));
$("zoom-out").addEventListener("click", () => zoomCenter(1 / 1.25));
$("zoom-reset").addEventListener("click", fitView);
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { renderDetail(); updateCarouselNav(); }, 150);
});

// ---- carousel navigation (arrows) ----
const carPrev = $("carousel-prev");
const carNext = $("carousel-next");
function updateCarouselNav() {
  const overflow = carouselEl.scrollWidth > carouselEl.clientWidth + 2;
  carPrev.hidden = !overflow;
  carNext.hidden = !overflow;
  if (!overflow) return;
  carPrev.classList.toggle("disabled", carouselEl.scrollLeft <= 2);
  carNext.classList.toggle(
    "disabled",
    carouselEl.scrollLeft + carouselEl.clientWidth >= carouselEl.scrollWidth - 2
  );
}
function carScroll(dir) {
  carouselEl.scrollBy({ left: dir * Math.max(200, carouselEl.clientWidth * 0.7), behavior: "smooth" });
}
carPrev.addEventListener("click", () => carScroll(-1));
carNext.addEventListener("click", () => carScroll(1));
carouselEl.addEventListener("scroll", updateCarouselNav);

// ---- init ----
loadSettings();
