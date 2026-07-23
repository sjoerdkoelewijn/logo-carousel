# DESIGN.md — Logo Tool

Utilitair, rustig gereedschap. Visuele basis: **xAI — stark monochrome, futuristische
minimalisme** (via getdesign.md). Zwart canvas, witte accenten, hairline randen.

## Kleuren

| Token             | Waarde    | Gebruik                          |
| ----------------- | --------- | -------------------------------- |
| `--bg`            | `#0A0A0A` | app-achtergrond (bijna-zwart)    |
| `--surface`       | `#141414` | panelen                          |
| `--surface-2`     | `#1C1C1C` | inputs / verhoogde vlakken       |
| `--text`          | `#F5F5F5` | primaire tekst                   |
| `--text-dim`      | `#8A8A8A` | secundaire tekst / labels        |
| `--accent`        | `#FFFFFF` | accent (stark wit — monochroom)  |
| `--border`        | `#2A2A2A` | hairline rand                    |
| `--border-strong` | `#3A3A3A` | sterkere rand / controls         |

## Checkerboard (transparantie-preview)

| Token          | Waarde    |
| -------------- | --------- |
| `--check-a`    | `#E8E8E8` |
| `--check-b`    | `#BFBFBF` |
| `--check-size` | `12px`    |

Licht patroon bewust — donkere mono-logo's zijn er goed op zichtbaar.

## Radius

`--r-sm 6px` · `--r-md 10px` · `--r-lg 14px`

## Spacing

`4 · 8 · 12 · 16 · 24 · 32` (`--s-1` … `--s-6`)

## Typografie

`system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`. Waarden in mono:
`ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace`.

## Layout

Eén kolom, gecentreerd (max 960px): header → upload-zone → notice → werkgebied
(PNG- en SVG-preview naast elkaar) → sliders → download-knoppen.

## CSS-structuur

```css
@layer reset, tokens, layout, components, utilities;
```

Vanilla CSS, cascade layers, geen framework, geen build step.
