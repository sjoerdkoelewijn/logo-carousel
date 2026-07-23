# Logo Tool — carrousel-composer

Client-side webtool: upload **meerdere logo's** → elk wordt een **monochrome, transparante
vector** (weggeknipte achtergrond). Stem de onderlinge grootte af in een carrousel-voorbeeld,
kies één export-canvasgrootte, en **download alles als ZIP** (een **SVG** per logo). Alles draait
in de browser — geen server, geen API-keys, geen build step, geen externe libraries.

## Gebruik

Open `index.html` via een lokale webserver (ES-modules laden niet via `file://`):

```bash
python -m http.server 8000   # of: node <static-server>
# open http://localhost:8000
```

Sleep één of meer logo's in de upload-zone (of kies bestanden / plak met Ctrl/⌘+V).
Accepteert PNG · JPG · WEBP · SVG.

- **Globale instellingen** (voor alle logo's): kleur, gladheid, export-canvas. De achtergrond
  wordt altijd volledig weggeknipt ("overal, letters open").
- **Detail-preview**: het geselecteerde logo in het **export-frame** (aspect volgt de canvas-
  keuze: landscape / vierkant / custom) op de gekozen achtergrond, groot en zoombaar.
- **Carrousel-strip**: alle logo's als doorlopende band op hun relatieve grootte, met een
  achtergrond-toggle **Licht / Donker / Custom** (kleurkiezer; start op licht) om ze tegen de
  bedoelde site-bg te checken. Klik een logo om het te selecteren — de **schaal-schuif** ligt
  dan ín het frame; het logo verschijnt ook groot in de detail-preview.
- **Hoogte** (globaal): één gedeelde hoogte voor álle logo's. De **breedte volgt per logo
  automatisch de werkelijke logobreedte** — de tight content-bounding-box van de vector +
  10px padding rondom. Zo neemt een vierkant logo weinig horizontale ruimte, een breed logo
  veel, en witruimte in het bronbestand telt niet mee. De **schaal-schuif** per logo regelt de
  grootte (en dus ook de breedte).
- **Download alles (ZIP)**: één **SVG** per logo — allemaal dezelfde hoogte, breedte per logo,
  vector gecentreerd met padding op transparante achtergrond.

## Pipeline

De **SVG is de source of truth**: de preview toont enkel de vector (groot), en de PNG-download
wordt daaruit afgeleid.

1. **Input** → canvas. Groot beeld wordt gecapt op 2400px; **klein beeld wordt vergroot**
   (hoge-kwaliteit interpolatie, tot ×5) richting 2400px zodat er meer detail is om mee te
   vectoriseren. Vooral kleine bitmaps en SVG-input winnen hierbij.
2. **Achtergrond-masker** — de drempel (bg vs voorgrond) wordt **automatisch** bepaald via
   Otsu op het histogram van "afstand tot achtergrondkleur" — adaptief per beeld, geen slider.
   Er wordt altijd overal weggeknipt (ook de dichte vlakken *binnenin* letters — de counters),
   zodat tekst-/vlak-logo's netjes open komen.
3. **Glad bilevel** — in "Overal"-mode wordt een grijswaarden-**voorgrondveld** (afstand tot
   bg, mét de anti-aliasing van het origineel) met bicubische canvas-scaling naar ~2400px
   geschaald en pas dán op de Otsu-drempel gethresholded. Door de zachte randen vóór het
   schalen te behouden komt de rand sub-pixel-nauwkeurig en glad uit → potrace fit strakke
   curves. ("Rand"-mode blijft binair zodat counters gevuld blijven.)
4. **Gladheid** — de slider stuurt een Gaussische **rand-blur** op het veld vóór de threshold
   (0…5px). Dat smoothed hoogfrequente rand-rimpel (bronruis) weg terwijl rechte randen recht
   blijven — de effectiefste knop voor strakke curves. Daarna **vectorize** met potrace
   (`turdSize` = 0, vaste nette `alphamax`/`optTolerance`, `fill` = kleur).
5. **Preview** — de SVG groot op checkerboard, met **pan & zoom** (scrollen = zoomen naar de
   cursor, slepen = pannen, −/Fit/+ knopjes, dubbelklik = passend). Zoom blijft behouden bij
   het aanpassen van Gladheid/kleur, zodat je op hetzelfde niveau kunt vergelijken.
6. **Preview & carrousel** — het geselecteerde logo op een **vast podium** (vaste verhouding,
   met ruimte eromheen zodat schalen zichtbaar is; die ruimte zit níét in de export) met
   **pan & zoom**. De schaal-schuif werkt gedebounced + met een vloeiende transitie. Daaronder
   de carrousel-strip (royale tussenruimte, alleen preview) met per-logo schaal-schuif.
7. **Export** — gedeelde **hoogte** (globaal); de **breedte per logo** volgt de tight content-
   bounding-box × schaal + 10px padding, verticaal gecentreerd. **Download alles (ZIP)** levert
   per logo een **SVG** (allemaal dezelfde hoogte, breedte per logo, transparante achtergrond).
   Kleur wisselen vervangt alleen de fill — geen re-trace.

Al-transparante PNG's slaan de cutout over; SVG's rasteriseren eerst.

## Structuur

```
index.html
styles.css            @layer reset, tokens, layout, components, utilities
src/
  main.js             UI, state, carrousel-orchestratie
  pipeline.js         pure beeldbewerking (cutout, veld, bilevel)
  vectorize.js        potrace-wrapper
  zip.js              minimale store-only ZIP-writer (geen dependency)
vendor/
  potrace/potrace.js  gevendord (kilobyte pure-JS port van Potrace, GPL)
```

## Licentie

De gevendorde `vendor/potrace/potrace.js` is een JS-port van Potrace (Peter Selinger),
gelicenseerd onder de **GPL**. Houd hier rekening mee bij de licentiekeuze van de repo.
