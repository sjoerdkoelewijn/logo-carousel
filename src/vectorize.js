// vectorize.js — dunne wrapper rond de gevendorde potrace (kilobyte pure-JS port).
// Potrace is een singleton die van een <img> src leest; we voeren een bilevel
// data-URL in, wachten op het load-event en draaien de tracer synchroon.

/**
 * Vectoriseer een bilevel canvas (wit = achtergrond, zwart = voorgrond) naar SVG.
 * @param bilevel HTMLCanvasElement — crisp bilevel, evt. gesupersampled
 * @param opts {turdSize, alphamax, optTolerance, fill}
 * @returns Promise<string> SVG
 */
export function vectorize(bilevel, opts = {}) {
  const {
    turdSize = 2,
    alphamax = 1,
    optTolerance = 0.2,
    fill = "#000000",
  } = opts;

  const dataUrl = bilevel.toDataURL("image/png");

  return new Promise((resolve, reject) => {
    if (typeof Potrace === "undefined") {
      reject(new Error("Potrace niet geladen (vendor/potrace/potrace.js ontbreekt)."));
      return;
    }
    Potrace.setParameter({
      turdsize: turdSize,
      alphamax: alphamax,
      opttolerance: optTolerance,
      optcurve: true,
      turnpolicy: "minority",
    });

    // loadImageFromUrl → interne img.onload → isReady; process() polt tot ready.
    Potrace.loadImageFromUrl(dataUrl);
    try {
      Potrace.process(() => {
        let svg = Potrace.getSVG(1);
        svg = recolorSvg(svg, fill, bilevel.width, bilevel.height);
        resolve(svg);
      });
    } catch (e) {
      reject(e);
    }
  });
}

/** Vervang de hardcoded zwarte fill en voeg een viewBox toe. */
function recolorSvg(svg, fill, w, h) {
  return svg
    .replace('fill="black"', `fill="${fill}"`)
    .replace(
      '<svg id="svg" version="1.1"',
      `<svg id="svg" version="1.1" viewBox="0 0 ${w} ${h}"`
    );
}
