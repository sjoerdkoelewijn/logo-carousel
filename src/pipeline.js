// pipeline.js — pure client-side image processing.
// Geen DOM-afhankelijkheid behalve ImageData (die is ook in workers beschikbaar).
// Alle functies zijn puur waar mogelijk: input ImageData in, resultaat terug of in-place.

/** Euclidische kleurafstand in RGB. */
function colorDist(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/**
 * Schat de achtergrondkleur uit de vier hoeken.
 * Retourneert de mediaan-hoekkleur + een maat voor hoe sterk de hoeken verschillen.
 */
export function estimateBackground(img) {
  const { data, width: w, height: h } = img;
  const corners = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
  ].map(([x, y]) => {
    const i = (y * w + x) * 4;
    return [data[i], data[i + 1], data[i + 2]];
  });

  // Mediaan per kanaal (robuuster dan gemiddelde tegen één afwijkende hoek).
  const median = (arr) => {
    const s = [...arr].sort((a, b) => a - b);
    return (s[1] + s[2]) / 2;
  };
  const color = [0, 1, 2].map((c) => median(corners.map((k) => k[c])));

  // Grootste onderlinge hoek-afstand als "uniformiteit"-signaal.
  let maxSpread = 0;
  for (let a = 0; a < corners.length; a++) {
    for (let b = a + 1; b < corners.length; b++) {
      maxSpread = Math.max(
        maxSpread,
        colorDist(...corners[a], ...corners[b])
      );
    }
  }
  return { color, spread: maxSpread, corners };
}

/**
 * Detecteer of het beeld al betekenisvolle transparantie heeft.
 * Zo ja, dan slaan we de auto-cutout over.
 */
export function hasAlpha(img) {
  const { data } = img;
  let transparentCount = 0;
  const sampleStep = 4 * Math.max(1, Math.floor(data.length / 4 / 40000)); // ~40k samples
  let sampled = 0;
  for (let i = 3; i < data.length; i += sampleStep) {
    sampled++;
    if (data[i] < 250) transparentCount++;
  }
  return transparentCount / sampled > 0.02;
}

/**
 * Bepaal automatisch de kleur-afstand-drempel (bg vs voorgrond) via Otsu op het
 * histogram van "afstand tot achtergrondkleur". Adaptief per beeld — geen slider
 * nodig. Retourneert de afstand-drempel (zelfde eenheid als colorDist).
 */
export function autoThreshold(img, bgColor) {
  const { data } = img;
  const [br, bg, bb] = bgColor;
  const BUCKETS = 256;
  const MAX_DIST = Math.sqrt(3 * 255 * 255); // ~441.67
  const hist = new Uint32Array(BUCKETS);
  const n = data.length / 4;
  for (let i = 0; i < data.length; i += 4) {
    const d = colorDist(data[i], data[i + 1], data[i + 2], br, bg, bb);
    const b = Math.min(BUCKETS - 1, ((d / MAX_DIST) * (BUCKETS - 1)) | 0);
    hist[b]++;
  }
  // Otsu: maximaliseer inter-class variantie.
  let sum = 0;
  for (let t = 0; t < BUCKETS; t++) sum += t * hist[t];
  let sumB = 0, wB = 0, maxVar = -1, thr = 0;
  for (let t = 0; t < BUCKETS; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > maxVar) {
      maxVar = v;
      thr = t;
    }
  }
  return (thr / (BUCKETS - 1)) * MAX_DIST;
}

/**
 * Edge flood-fill masker.
 * BFS vanaf álle rand-pixels; pixels die binnen `tolerance` van bgColor liggen
 * horen bij de achtergrond. Achtergrond-kleurige stukken BINNENIN het logo blijven
 * behouden omdat ze niet vanaf de rand bereikbaar zijn.
 *
 * @returns Uint8Array mask, 1 = voorgrond, 0 = achtergrond.
 */
export function floodFillMask(img, bgColor, tolerance) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const mask = new Uint8Array(n).fill(1); // begin: alles voorgrond
  const visited = new Uint8Array(n);
  const [br, bg, bb] = bgColor;

  const isBg = (idx) => {
    const i = idx * 4;
    return colorDist(data[i], data[i + 1], data[i + 2], br, bg, bb) <= tolerance;
  };

  // Queue als platte Int32Array-stack (snel, geen array-allocaties per push).
  const queue = new Int32Array(n);
  let qs = 0;

  const seed = (idx) => {
    if (!visited[idx] && isBg(idx)) {
      visited[idx] = 1;
      mask[idx] = 0;
      queue[qs++] = idx;
    }
  };

  // Alle rand-pixels als startpunten.
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + (w - 1));
  }

  // BFS (feitelijk DFS via stack; volgorde maakt niet uit voor het masker).
  while (qs > 0) {
    const idx = queue[--qs];
    const x = idx % w;
    const y = (idx - x) / w;
    if (x > 0) seed(idx - 1);
    if (x < w - 1) seed(idx + 1);
    if (y > 0) seed(idx - w);
    if (y < h - 1) seed(idx + w);
  }
  return mask;
}

/**
 * Grijswaarden-"voorgrondveld": per pixel de afstand tot de achtergrondkleur,
 * geschaald naar 0..255 (0 = achtergrond, hoog = voorgrond). Dit behoudt de
 * anti-aliasing van het origineel (rand-pixels krijgen een tussenwaarde), zodat
 * de latere schaling+threshold een sub-pixel-nauwkeurige, gladde rand geeft.
 * Voor "Overal"-mode; verwijdert vanzelf de bg-kleurige counters binnen letters.
 */
export function foregroundField(img, bgColor) {
  const { data } = img;
  const [br, bg, bb] = bgColor;
  const MAX = Math.sqrt(3 * 255 * 255);
  const out = new Uint8ClampedArray(data.length / 4);
  for (let j = 0, i = 0; j < out.length; j++, i += 4) {
    out[j] = (colorDist(data[i], data[i + 1], data[i + 2], br, bg, bb) / MAX) * 255;
  }
  return out;
}

/**
 * Bouw een bilevel canvas voor potrace uit een grijswaarden-voorgrondveld.
 * Het veld (mét zachte randen) wordt met hoge-kwaliteit (bicubische) canvas-scaling
 * naar `targetLong` (langste zijde) geschaald en pas dán op `threshByte` gethresholded.
 * Door de zachte randen vóór het schalen te behouden, komt de rand sub-pixel-nauwkeurig
 * en glad uit → potrace fit strakke curves, op een begrensde resolutie (dus snel).
 * @param field Uint8Array/Uint8ClampedArray (0..255, hoog = voorgrond)
 * @param targetLong gewenste langste zijde van de bilevel (0 = geen herschaling)
 * @param threshByte drempel 0..255 waarboven een pixel voorgrond is
 * @param blurPx Gaussische blur (in bilevel-pixels) vóór de threshold; smoothed
 *   hoogfrequente rand-rimpel weg (rechte randen blijven recht, curves worden glad)
 */
export function fieldToBilevelCanvas(field, w, h, targetLong = 0, threshByte = 128, blurPx = 0) {
  // Veld → kleine grijswaarden-canvas.
  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const sctx = small.getContext("2d");
  const id = sctx.createImageData(w, h);
  for (let j = 0, i = 0; j < field.length; j++, i += 4) {
    id.data[i] = id.data[i + 1] = id.data[i + 2] = field[j];
    id.data[i + 3] = 255;
  }
  sctx.putImageData(id, 0, 0);

  let W = w, H = h;
  if (targetLong && Math.max(w, h) > 0) {
    const f = targetLong / Math.max(w, h);
    W = Math.max(1, Math.round(w * f));
    H = Math.max(1, Math.round(h * f));
  }

  const big = document.createElement("canvas");
  big.width = W;
  big.height = H;
  const bctx = big.getContext("2d", { willReadFrequently: true });
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = "high";
  if (blurPx > 0) bctx.filter = `blur(${blurPx}px)`;
  bctx.drawImage(small, 0, 0, W, H); // gladde ramp + optionele blur op de randen
  bctx.filter = "none";

  // Threshold → strak bilevel (voorgrond = zwart).
  const out = bctx.getImageData(0, 0, W, H);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i] >= threshByte ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  bctx.putImageData(out, 0, 0);
  return big;
}
