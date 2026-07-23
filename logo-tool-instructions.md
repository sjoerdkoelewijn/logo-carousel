# Logo Tool — Claude Code instructie

Een client-side webtool: upload een logo → krijg (1) een monochrome versie met
weggeknipte achtergrond als transparante PNG, en (2) een strakke SVG-vectorisatie.
Volledig in de browser, geen server, geen API-keys, geen build step. Host op GitHub Pages.

Dit document is de volledige opdracht. Werk de fases in volgorde af. Sla geen approval
gate over. **Vraag bij twijfel, gok niet** — bij ontbrekende of dubbelzinnige info stop
je en stel je één concrete vraag.

---

## Stack & harde constraints

- Plain **HTML / CSS / JS**, **geen build step**, geen framework, geen bundler, geen Tailwind.
- **Vanilla CSS met `@layer`** (cascade layers) voor alle styling. Geen scoped CSS.
- Alle verwerking **client-side** in de browser. Geen backend, geen netwerk-calls at runtime.
- Externe libraries worden **gevendord** in `/vendor/` (echte bestanden in de repo),
  niet via CDN geladen. De tool moet volledig werken zonder runtime-afhankelijkheid van
  een externe dienst.
- Hosting: **GitHub Pages**, publieke repo.
- Doelbrowser: recente desktop Chrome/Firefox/Safari. Mobiel is nice-to-have, niet vereist.
- Durable & leesbaar: geen opaque state, geen database. Wat opgeslagen moet worden
  (bv. laatste slider-instellingen) mag in `localStorage`, meer niet.

---

## Fase 0 — Pre-flight (verplicht, vóór er ook maar iets gebouwd wordt)

Controleer de omgeving. Wat je zelf kan checken, check je automatisch; wat je niet kan
verifiëren vraag je expliciet. Rapporteer het resultaat als een korte checklist en ga
pas door na akkoord.

Automatisch te checken:
- [ ] `git` en `gh` (GitHub CLI) aanwezig en `gh` geauthenticeerd (`gh auth status`).
- [ ] Zitten we in een lege/nieuwe map of een bestaande repo? (Bepaal of we `git init`
      + repo aanmaken nodig hebben, of dat er al een remote is.)

Expliciet aan Sjoerd te vragen (één vraag per keer — zie Fase 1):
- Reponaam en of hij publiek mag zijn.
- GitHub Pages serve-bron: `main` root of `/docs`.

Geen Node/npm nodig — er is geen build step. Libraries worden als kant-en-klare
`.js`/`.wasm`-bestanden in `/vendor/` gezet (download je één keer, commit je mee).

---

## Fase 1 — Beslissingen (sequentieel, één vraag per keer)

Stel deze één voor één, wacht telkens op antwoord. Geef bij elke vraag jouw aanbeveling
mee zodat Sjoerd snel kan bevestigen. Voorgestelde defaults staan gemarkeerd.

1. **Achtergrond-verwijdering — methode.**
   - (a) **Edge flood-fill** — vult vanaf de rand aaneengesloten pixels die matchen met
     de achtergrondkleur. Behoudt achtergrond-kleurige stukken *binnenin* het logo.
     **← aanbevolen default.**
   - (b) Globale kleur-match (simpeler, maar vreet stukken uit het logo als de bg-kleur
     ook in het logo voorkomt).
   - (c) Beide aanbieden als toggle.

2. **Betekenis van "monochroom" in de output.**
   - (a) **Flatten naar één kleur** (default zwart) + behoud alpha. Alle voorgrond wordt
     exact die kleur; enkel het alpha-kanaal blijft over. **← aanbevolen default**, en
     dit lost meteen het fringe-probleem op (zie Fase 3).
   - (b) Echte grijswaarden (luminantie behouden).
   - (c) Flatten, maar de kleur is kiesbaar via een color picker.

3. **SVG-vectorisatie — library.**
   - (a) **Potrace (WASM-port)** — werkt op bilevel input, geeft propere Bézier-curves.
     Perfect want onze mono-output is al zo goed als bilevel. **← aanbevolen default.**
   - (b) ImageTracer.js — kan kleur, maar rommeliger paden. Alleen relevant als
     kleuren-vectorisatie later een doel wordt; nu overkill.
   - Kies (a) tenzij Sjoerd expliciet kleur-SVG wil.

4. **Slider-set (bewust minimaal houden).** Voorstel: **cutout-tolerantie**,
   **speckle-removal** (turdSize), **smoothing** (corner threshold). Akkoord, of één
   toevoegen/weghalen?

5. **Repo & Pages** (uit Fase 0): reponaam, publiek ja/nee, serve-bron `main` root of `/docs`.

---

## Fase 2 — Design tokens (approval gate)

Presenteer een kleine `DESIGN.md` met een token-tabel **vóór** er CSS geschreven wordt.
Wacht op expliciet akkoord. Houd het utilitair en rustig — dit is gereedschap, geen
marketingsite.

Minimaal te definiëren tokens:
- Kleuren: achtergrond-app, oppervlak/panel, tekst, accent (1), rand.
- **Checkerboard-patroon** voor de transparantie-preview (twee grijstinten + tegelgrootte).
- Radius, spacing-schaal (klein setje), font-stack (system-ui).
- Layout: één kolom, upload-zone bovenaan, preview + sliders eronder, download-knoppen onder.

Structureer de CSS met `@layer reset, tokens, layout, components, utilities;`.

Bouw géén UI-code vóór dit akkoord.

---

## Fase 3 — Bouwplan (na akkoord tokens)

Presenteer eerst het bouwplan ter goedkeuring (welke bestanden, welke pipeline-stappen),
bouw daarna. Bestandsstructuur ongeveer:

```
index.html
styles.css            (met @layer)
src/
  main.js             (UI, state, orchestratie)
  pipeline.js         (de beeldbewerking, zie hieronder)
  vectorize.js        (potrace-wrapper)
vendor/
  potrace-wasm/...    (gevendord, één keer gedownload en gecommit)
DESIGN.md
README.md
```

### De verwerkings-pipeline (de kern — implementeer in deze volgorde)

1. **Input.** Drag-&-drop + file-picker + paste-from-clipboard. Accepteer PNG/JPG/WEBP/SVG.
   Teken op een `<canvas>`. Cap de werkresolutie (bv. langste zijde max ~1600px) voor
   snelheid; bewaar wel genoeg detail voor de vectorisatie.

2. **Achtergrond-masker via edge flood-fill.**
   - Sample de vier hoeken; neem de mediaan als geschatte achtergrondkleur. Waarschuw
     (niet-blokkerend) als de hoeken sterk verschillen — dan is er waarschijnlijk geen
     egale achtergrond.
   - Flood-fill (BFS) vanaf álle rand-pixels; een pixel hoort bij de achtergrond als de
     kleurafstand tot de bg-kleur onder de **tolerantie-slider** valt. Markeer die als
     `alpha = 0`.
   - Resultaat is een binair masker (voorgrond / achtergrond).

3. **Edge feather (anti-fringe).**
   - Flood-fill geeft harde, gealiaste randen. Blur **enkel het alpha-kanaal** met ~1px
     zodat er nette anti-aliasing terugkomt op de rand. Raak RGB niet aan.

4. **Monochroom flatten.**
   - Voor élke niet-transparante pixel: zet `RGB = doelkleur` (default `#000`), behoud de
     (gefeatherde) alpha. Omdat we de originele RGB volledig weggooien, **bestaat het
     halo/fringe-probleem hier niet**: elke voorgrondpixel — inclusief de zachte randen —
     wordt exact de doelkleur, enkel met verschillende alpha. Dit is de reden dat de
     mono-stap ná de cutout komt.
   - (Grijswaarden-modus, indien gekozen in Fase 1: gebruik luminantie i.p.v. vlakke kleur.)

5. **Preview.** Toon het resultaat op de checkerboard-achtergrond zodat transparantie
   zichtbaar is. Preview moet live updaten bij het slepen van sliders (debounce het
   zware werk indien nodig).

6. **Vectorisatie (potrace).**
   - Zet het masker om naar bilevel (harde threshold op alpha/luminantie).
   - Draai potrace met parameters gekoppeld aan de sliders:
     - `turdSize` ← **speckle-removal** (verwijdert kleine losse vlekjes).
     - `alphamax` ← **smoothing** (hoekafronding).
     - `optTolerance` ← curve-optimalisatie (mag een vaste, nette default krijgen).
   - Zet de `fill` van de SVG op de doelkleur. Streef naar één net pad.

7. **Export.**
   - **Download PNG** — transparante, monochrome raster (op volledige resolutie).
   - **Download SVG** — de gevectoriseerde versie.
   - Toon PNG en SVG naast elkaar in de preview zodat het verschil zichtbaar is.

### Randgevallen om af te handelen (niet stilzwijgend negeren)
- Logo zonder egale achtergrond → toon een duidelijke, vriendelijke melding dat auto-cutout
  hier waarschijnlijk niet goed werkt; laat de tool wel gewoon draaien.
- Al-transparante PNG als input → sla de cutout-stap over, ga direct naar mono + vectorise.
- SVG als input → rasterize eerst netjes naar canvas voor de pipeline.
- Heel groot bestand → resize vóór verwerking, meld dit niet als fout.

---

## Guardrails (gelden de hele opdracht door)

- **Vraag, gok niet.** Bij dubbelzinnigheid: stop en stel één concrete vraag.
- **Approval gates respecteren:** geen CSS vóór akkoord op tokens; geen implementatie vóór
  akkoord op het bouwplan.
- **Eén beslissing per keer** in Fase 1.
- Geen CDN's, geen frameworks, geen build step insluipen — als je denkt dat iets ervan
  echt nodig is, leg het voor in plaats van het stilletjes toe te voegen.
- Commit `vendor/` mee; de tool moet werken uit een verse checkout zonder installatiestap.
- Houd `main.js` (UI/orchestratie) en `pipeline.js` (pure beeldbewerking) gescheiden zodat
  de verwerkingslogica los testbaar/herbruikbaar blijft.

---

## Realistische verwachting (voor de duidelijkheid, geen taak)

Auto-cutout + mono werkt out-of-the-box voor ~70–80% van propere logo's; de sliders
vangen de rest op. Potrace geeft strakke resultaten voor tekst- en vlak-logo's; bij zeer
fijne fotografische details wordt vectorisatie altijd een benadering. Dat is inherent, geen bug.
