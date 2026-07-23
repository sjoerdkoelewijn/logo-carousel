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
const canvasH = $("canvas-h");
const bgColor = $("bg-color");

// ---- state ----
let logos = []; // { id, name, src:ImageData, hasAlpha, svg, natW, natH, scale, el }
let selectedId = null;
let idSeq = 0;
let carouselBg = "dark"; // light | dark | custom

// ---- settings ----
function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || "{}");
    if (s.color) { colorInput.value = s.color; colorHex.value = s.color; }
    if (s.smoothing != null) smoothing.value = s.smoothing;
    if (s.canvasH) canvasH.value = s.canvasH;
    if (s.bgColor) bgColor.value = s.bgColor;
    if (s.bg) carouselBg = s.bg;
  } catch {}
  setCarouselBg(carouselBg);
  syncLabels();
}
function saveSettings() {
  localStorage.setItem(STORE_KEY, JSON.stringify({
    color: colorHex.value, smoothing: smoothing.value, canvasH: canvasH.value,
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

// Globale, gedeelde hoogte voor alle logo's.
function getHeight() {
  const n = Math.round(Number(canvasH.value));
  return Number.isFinite(n) ? Math.min(4000, Math.max(40, n)) : 400;
}

// Frame per logo: hoogte is altijd globaal; de breedte volgt de werkelijke logobreedte
// (content-bbox) op de ingestelde schaal, met FRAME_PAD padding rondom. Zo neemt een
// vierkant logo automatisch weinig horizontale ruimte, een breed logo veel — allemaal
// op dezelfde hoogte.
const FRAME_PAD = 10; // padding (in export-px) rond de content
function frameDims(logo) {
  const H = getHeight();
  const bb = logo.bb || { x: 0, y: 0, w: logo.natW || 1, h: logo.natH || 1 };
  const targetH = (H - 2 * FRAME_PAD) * logo.scale; // content-hoogte in export-px
  const f = targetH / bb.h; // schaalfactor: content-units → export-px
  const W = Math.max(2 * FRAME_PAD + 1, Math.round(bb.w * f + 2 * FRAME_PAD));
  return { W, H, f, targetH, bb };
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

canvasH.addEventListener("input", () => { saveSettings(); updateAllFrameBoxes(); renderDetail(); });

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
        svg: "", natW: 0, natH: 0, bb: null, scale: 1, el: null,
      };
      logos.push(logo);
      addFrame(logo);
      setStatus(`Vectorizing ${k + 1}/${files.length}…`);
      await traceLogo(logo);
      refreshFrame(logo);
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
  logo.bb = computeContentBBox(svg) || { x: 0, y: 0, w: logo.natW, h: logo.natH };
}

// Tight bounding box van de gevectoriseerde inhoud (negeert witruimte in de bron),
// zodat de framebreedte de échte logobreedte volgt. Gebruikt getBBox off-screen.
function computeContentBBox(svgString) {
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:absolute;left:-99999px;top:0;width:0;height:0;overflow:hidden";
  wrap.innerHTML = svgString;
  document.body.appendChild(wrap);
  let bb = null;
  try {
    const path = wrap.querySelector("path");
    const r = path.getBBox();
    if (r.width > 0 && r.height > 0) bb = { x: r.x, y: r.y, w: r.width, h: r.height };
  } catch {}
  document.body.removeChild(wrap);
  return bb;
}

async function reprocessAll() {
  if (!logos.length) return;
  for (let i = 0; i < logos.length; i++) {
    setStatus(`Vectorizing ${i + 1}/${logos.length}…`);
    await traceLogo(logos[i]);
    refreshFrame(logos[i]);
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

// Frame-box maat: vaste hoogte; breedte volgt de vaste slot-aspect van dit logo
// (gebaseerd op z'n volle breedte, dus schaal-onafhankelijk → verspringt niet).
function frameBoxSize(logo) {
  const { SW, SH } = thumbGeom(logo);
  const boxH = 132;
  return { boxW: Math.round(boxH * (SW / SH)), boxH };
}

function addFrame(logo) {
  const el = document.createElement("div");
  el.className = "frame";
  el.dataset.id = logo.id;
  el.innerHTML = `
    <button class="frame-remove" title="Remove">×</button>
    <div class="frame-box">
      <div class="frame-svg"></div>
      <div class="frame-scale-wrap"><input class="frame-scale" type="range" min="0.3" max="1" step="0.01" value="${logo.scale}" /></div>
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
    scheduleThumbScale(logo); // slot vast; content schaalt binnenin (smooth, korte delay)
    if (logo.id === selectedId) scheduleDetail(); // grote preview: iets langere delay
  });
  el.addEventListener("click", () => selectLogo(logo.id));
  carouselEl.appendChild(el);
  logo.el = el;
  applyFrameBox(logo);
  updateCarouselNav();
}

// Frame opnieuw renderen (SVG + box), bv. na kleur-/trace-/hoogtewijziging.
function refreshFrame(logo) {
  renderFrame(logo);
  applyFrameBox(logo);
  updateCarouselNav();
}

function applyFrameBox(logo) {
  const { boxW, boxH } = frameBoxSize(logo);
  const box = logo.el.querySelector(".frame-box");
  box.style.width = boxW + "px";
  box.style.height = boxH + "px";
}

function updateAllFrameBoxes() {
  for (const logo of logos) if (logo.el) { renderFrame(logo); applyFrameBox(logo); }
  updateCarouselNav();
}

// Toon het logo op een VAST slot (inline SVG-podium): het slot heeft altijd dezelfde
// maat, alleen de content erbinnen schaalt mee — zo is het schalen ook voor brede
// logo's zichtbaar. Puur preview; de export blijft content-strak.
function renderFrame(logo) {
  if (!logo.el || !logo.svg) return;
  logo.el.querySelector(".frame-svg").innerHTML = thumbSvg(logo);
}

// Alleen de content-schaal binnen het (vaste) slot bijwerken → animeert vloeiend
// via de CSS-transitie op .pc. Korte delay zodat het snappy voelt maar niet schokt.
let thumbTimer;
function scheduleThumbScale(logo) {
  clearTimeout(thumbTimer);
  thumbTimer = setTimeout(() => {
    const g = logo.el?.querySelector(".frame-svg .pc");
    if (g) g.setAttribute("transform", thumbTransform(logo));
    else renderFrame(logo);
  }, 120);
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

// De detail-preview toont het geselecteerde logo IN zijn export-frame: de viewport
// krijgt de frame-aspect (breedte volgt de logobreedte) en de gekozen achtergrond.
// Zoombaar voor kwaliteit.
function bgCss() {
  return carouselBg === "dark" ? "#0e0e0e" : carouselBg === "custom" ? bgColor.value : "#f2f2f2";
}
// Vast "podium" met een vaste verhouding: de viewport-grootte hangt NIET van het logo
// af. Binnen dit podium staat de logo-content gecentreerd, met ruimte eromheen — die
// ruimte is puur preview en zit NIET in de export. De contenthoogte is proportioneel
// aan de schaal, dus bij het schuiven zie je het logo echt kleiner/groter worden.
const PREVIEW_ASPECT = 2.6, PREVIEW_MF = 1.5; // groot podium (vaste verhouding)

// GROOT PODIUM: vaste verhouding; content gecentreerd op schaal-proportionele grootte.
function stageGeom(logo, aspect, mf) {
  const H = getHeight();
  const bb = logo.bb || { x: 0, y: 0, w: logo.natW || 1, h: logo.natH || 1 };
  const SH = Math.round(H * mf);
  const SW = Math.round(SH * aspect);
  let f = ((H - 2 * FRAME_PAD) * logo.scale) / bb.h;
  const maxW = SW * 0.9, maxH = SH * 0.9;
  if (bb.w * f > maxW) f = maxW / bb.w;
  if (bb.h * f > maxH) f = maxH / bb.h;
  const cw = bb.w * f, ch = bb.h * f;
  return { SW, SH, tx: SW / 2 - cw / 2 - bb.x * f, ty: SH / 2 - ch / 2 - bb.y * f, f };
}
const previewTransform = (logo) => {
  const g = stageGeom(logo, PREVIEW_ASPECT, PREVIEW_MF);
  return `translate(${g.tx.toFixed(2)}, ${g.ty.toFixed(2)}) scale(${g.f.toFixed(5)})`;
};
const previewSvg = (logo) => {
  const { SW, SH } = stageGeom(logo, PREVIEW_ASPECT, PREVIEW_MF);
  const inner = logo.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}" viewBox="0 0 ${SW} ${SH}">` +
    `<g class="pc" transform="${previewTransform(logo)}">${inner}</g></svg>`;
};

// CARROUSEL-SLOT (WYSIWYG met de export): het slot ís het export-bestand op schaal 1
// (hoogte = export-hoogte H, breedte = volle content + padding). De content krimpt bij
// lagere schaal binnen dat vaste slot — dus wat je hier ziet is exact wat je exporteert.
// Het slot verspringt niet tijdens het schuiven; de extra breedte-marge bij lagere schaal
// zit niet in de export (die is content-strak, zelfde logo-grootte).
function thumbGeom(logo) {
  const H = getHeight();
  const bb = logo.bb || { x: 0, y: 0, w: logo.natW || 1, h: logo.natH || 1 };
  const bandH = H - 2 * FRAME_PAD;
  const contentW1 = (bb.w / bb.h) * bandH; // volle contentbreedte bij schaal 1
  const SW = Math.round(contentW1 + 2 * FRAME_PAD);
  const SH = H;
  const contentH = bandH * logo.scale; // zelfde als de export: (H − 2·pad) · schaal
  const f = contentH / bb.h;
  const cw = bb.w * f, ch = bb.h * f;
  return { SW, SH, tx: SW / 2 - cw / 2 - bb.x * f, ty: SH / 2 - ch / 2 - bb.y * f, f };
}
const thumbTransform = (logo) => {
  const g = thumbGeom(logo);
  return `translate(${g.tx.toFixed(2)}, ${g.ty.toFixed(2)}) scale(${g.f.toFixed(5)})`;
};
const thumbSvg = (logo) => {
  const { SW, SH } = thumbGeom(logo);
  const inner = logo.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SW}" height="${SH}" viewBox="0 0 ${SW} ${SH}" preserveAspectRatio="xMidYMid meet">` +
    `<g class="pc" transform="${thumbTransform(logo)}">${inner}</g></svg>`;
};

function sizeViewport() {
  const availW = viewport.parentElement?.clientWidth || 800;
  const maxH = Math.min(460, Math.round(window.innerHeight * 0.5));
  let w = availW, h = Math.round(w / PREVIEW_ASPECT);
  if (h > maxH) { h = maxH; w = Math.round(h * PREVIEW_ASPECT); }
  viewport.style.width = w + "px";
  viewport.style.height = h + "px";
}
function renderDetail() {
  const logo = logos.find((l) => l.id === selectedId);
  if (!logo || !logo.svg) { svgPreview.innerHTML = ""; detailName.textContent = "—"; return; }
  detailName.textContent = logo.name;
  viewport.style.background = bgCss();
  sizeViewport();
  svgPreview.innerHTML = previewSvg(logo);
  fitView();
}

// Alleen de content-schaal binnen het (vaste) podium bijwerken — de <g> heeft een CSS
// transitie, dus dit animeert vloeiend. Gedebounced zodat het niet op elke stap gebeurt.
let detailTimer;
function scheduleDetail() {
  clearTimeout(detailTimer);
  detailTimer = setTimeout(() => {
    const logo = logos.find((l) => l.id === selectedId);
    const g = svgPreview.querySelector(".pc");
    if (logo && g) g.setAttribute("transform", previewTransform(logo));
    else renderDetail();
  }, 350);
}

// ---- export ----
// Bouw de frame-SVG: hoogte = globaal (H); breedte = content-breedte × schaal + padding.
// De content wordt op zijn tight bbox geschaald en gecentreerd, met FRAME_PAD rondom.
function framedSvg(logo) {
  const { W, H, f, targetH, bb } = frameDims(logo);
  const tx = FRAME_PAD - bb.x * f;
  const ty = (H - targetH) / 2 - bb.y * f;
  const inner = logo.svg.replace(/^<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">` +
    `<g transform="translate(${tx.toFixed(2)}, ${ty.toFixed(2)}) scale(${f.toFixed(5)})">${inner}</g></svg>`;
}

function safeName(name, i) {
  const base = name.replace(/\.[^.]+$/, "").replace(/[^\w.-]+/g, "-").slice(0, 40) || "logo";
  return String(i + 1).padStart(2, "0") + "_" + base;
}

$("download-zip").addEventListener("click", async () => {
  if (!logos.length) return;
  const H = getHeight();
  setStatus("Creating ZIP…");
  try {
    const enc = new TextEncoder();
    const entries = logos.map((logo, i) => ({
      name: safeName(logo.name, i) + ".svg",
      data: enc.encode(framedSvg(logo)),
    }));
    downloadBlob(makeZip(entries), `logos-h${H}.zip`);
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
