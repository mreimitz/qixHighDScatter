# Changelog

Each `## <version>` section becomes the notes of the GitHub release of that version (see `.github/workflows/release.yml`). Install: upload `release/qixHighDScatter-v<version>.zip` under *Management Console › Extensions* (replace the existing one to keep every chart).

## 0.7.0 — 2026-10-04

Everything since 0.5.5 (0.6.0 was built the same day and never released on its own).

### Performance

- **Packed transport** (default; *Data handling › Transport*). The chart asks the engine for a session cube whose one measure bundles the points as compact text (`id⇥x⇥y…`, ~25 bytes per point, hash-bucketed) instead of reading its own table at ~62 bytes per *cell*. Measured on Qlik Cloud: **1M points in 6–8 s instead of 20 s** (two charts at once: 12 s instead of 20–24 s); 200k points in ~2 s instead of 4. Field dimensions only; calculated dimensions and any engine error fall back to plain paging automatically.
- **Selections on a cached load.** With one data row per point, the first full load is kept and a later selection only asks the engine for the list of possible ids, then cuts the cached points locally: **0.4 s for 213k points** instead of a reload. An app reload invalidates the cache.
- **Interaction level of detail** (brand-ui `feat/density-scatter-shape-by`): while wheel-zooming or panning without a GPU the chart draws every n-th point under a 16 ms budget and refines when you stop — 1M points, no GPU: zoom frames p50 73 → 15 ms.
- Streaming loads no longer re-feed the chart per page (400 ms throttle, encoded categories): 1M points in the harness 62 s → 10 s.
- Retry with backoff when the engine aborts a page request ("Request aborted. (Exclusive request aborted family requests)", code 15) — a selection or property change during loading no longer surfaces as an error.
- Load and frame telemetry in the console (`[qixHighDScatter] loaded …`) and `window.__qhdsPerf`.

### New

- **Shapes by the 2nd dimension** — star, triangle up/down, square, diamond, plus, minus, cross, hexagon, circle — with a third **Shapes** tab in the zone editor (Properties · Data model · Shapes), live preview, reset to automatic.
- **Loading**: progress bar on top of the chart and/or the “n / total” text (both / bar / text / none); *Draw as they arrive* or *Loading animation* — the robot paints a scatter in step with the progress, and nothing else is visible while it does; **Fun mode** off gives a plain loading screen.
- **No-GPU warning**: a small orange sign near the legend when hardware acceleration is off, with a popover that says where to turn it on (Chrome, Edge, Firefox; Windows and macOS).
- **Explain settings** switch in every property-panel section — a plain-language note under each setting.

### Fixed

- Small objects: legend and stats box hide first, the plot never disappears; a side legend taller than the object moves to the bottom.
- Legends are single-line and scrollable (vertical at the side, horizontal at the bottom) — never multi-line.
- Stats box moved to the plot's bottom-left, clear of axis labels, zoom buttons and σ tags.
- Colour by dimension / size by measure: encoded categories and the LOD path remove the slowdown on selection and zoom.

### Build

Until the brand-ui branch `feat/density-scatter-shape-by` is on npm, build from source: `BRAND_UI_SRC=<elabs-components>/packages node scripts/build.mjs` (README › Develop).

## 0.5.5 — 2026-09-26

First packaged build (draft release "Initial").
