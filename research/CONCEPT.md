# qixHighDScatter — concept (pre-build review)

Date: 2026-09-25 · Status: concept, decisions taken (§6), nothing built · Target: Qlik Cloud + client-managed Qlik Sense

## 1. What we are porting

`DensityScatterChart` from `@elabs-ai/components-charts` (v5.5.0 on npm, source in
`elabs-components/packages/charts/src/charts/density-scatter/`, analysis + outcome in
`docs/review/2026-09-23-density-scatter-analysis.md`).

- 10⁵–10⁶ points, every point always a WebGL dot; colour = local density (lightness on the class hue),
  screen-space bins (`cellSize` 5 px), faint underlay (`underlay` 4), Canvas-2D fallback.
- Wheel zoom at cursor, drag pan, double-click reset (`view` / `defaultView` / `onViewChange`).
- **Zones**: ordered list, inner → outer, max 15; a point's class = first zone containing it, else
  `__outside`. Each zone `{ id, label, color, bounds }` where `bounds` is EITHER
  - a rectangle `{ x?: [min,max], y: [min,max] }` (x optional = full-width band), OR
  - an envelope `{ upper: [[x,y]…], lower: [[x,y]…] }` — two polylines varying along x (the funnel).
  Classification runs once per data/zones change into a `Uint8Array`.
- `colorBy`: `zone` (default) | `density` | `value` (numeric column, mean per dense cell) | `category` (≤12).
- Selection = intersection (AND) of x range, y range, lasso polygon, zone set — the chart's own state,
  emitted as `ChartSelectionIntent`s. Toolbar Pointer / Range / Lasso; axis-gutter drags; keyboard sliders.
- Legend: click = hide/show zone (`hiddenKeys`), Shift/Ctrl-click = select zone; in-plot zone tags.
- Data in: columnar `{ x, y, values?, categories? }` typed arrays.

Runtime deps the extension must bundle: React 18/19, react-dom, `@elabs-ai/components-{charts,ui,tokens}`
(+ d3-scale, @visx/*, motion, lucide-react …, tree-shaken). Styling = Tailwind utilities + CSS-var tokens
(`--chart-1…`), so a **scoped, preflight-free** compiled CSS is required (Qlik guidelines forbid global CSS).

## 2. Qlik platform facts that shape the design

| Topic | Fact | Consequence |
|---|---|---|
| Framework | nebula.js supernova is the recommended path; legacy AMD still supported | Supernova (`"supernova": true`), like qixVizlib/Combo/DT/HS |
| AMD on Cloud | Only `@nebula.js/stardust` and `qlik` resolve (your `qixComboChart2/research/amd-availability-findings.md`) | Bundle React + brand-ui into `dist/` |
| Page size | Hard 10,000 cells per `getHyperCubeData` / `qInitialDataFetch` | 500k × 3 cols = 150+ pages |
| Payload | Each NxCell carries qText/qNum/qElemNumber/qState | ~100–200 MB JSON for 500k×3 — **the main performance risk** |
| Native scatter | Never fetches all rows: > `maxVisibleBubbles` (≤50k) switches to `GetHyperCubeBinnedData` boxes | Native semantics differ from "every point a dot" |
| Box selection | `rangeSelectHyperCubeValues([{qMeasureIx, qRange{qMin,qMax,…}}], qOrMode=false)` = exact X∧Y box; `multiRange…` for several boxes | Axis ranges / Range box / rectangle zones map exactly |
| Lasso / envelope | No polygon selection in the engine; native lasso = approximated by rectangles | Need elemNumbers of an ID dimension, or rectangle approximation |
| Selection model | Confirmed selection filters the cube → unselected points vanish | Chart's local "dim unselected" only lives during selection mode unless we fetch excluded rows |
| Property panel | `type:'array'` (itemTitleRef, allowAdd/Remove/Move) works; `expression:'optional'` inside array items is evaluated in the layout (PipelineBleed + native refLines precedent); custom Angular/React panel components are **unsupported** in Cloud; `styling-panel` breaks uploaded ext panels | Zones must be built from stock controls — or edited on the canvas |
| Writing props | `model.applyPatches` / `setProperties` from user events in edit mode persists (guard `canSetProperties`) | An in-chart zone editor is feasible |
| Export | Qlik Cloud: no image/PDF/PPT export for 3rd-party extensions; data export only | Accept; `exportData: true` |
| WebGL | ~16 live contexts per page in Chrome | One context per object, release on unmount, handle `webglcontextlost` |

## 3. Data model inside the extension

`qHyperCubeDef` (straight mode):
- Dim 1 — **point identity** (e.g. `RowID`, `EventID`) — required so every row is one point and selections can target it.
- Measure 1 — X, Measure 2 — Y (e.g. `Only(Alt)` or `Sum(Speed)`).
- Measure 3 (optional) — colour value (`colorBy: value`).
- Dim 2 (optional) — category (`colorBy: category`), or attribute expression.
- `qInitialDataFetch: [{qWidth: n, qHeight: floor(10000/n)}]`, then parallel paging (4–6 in flight) into
  `Float32Array x/y`, `Int32Array elem`, streaming → progressive render (points appear page by page).
- Refetch keyed on `qcy × dims cIds × selection state`, debounced ~200 ms (layout bursts), cancel on change.
- Calc condition + a configurable max points cap (e.g. 1M) with an explicit "showing N of M" state.

Transport options to decide (see §6-D1): plain paging vs. a *packed* mode where a bucket dimension
(`Floor(RowNo()/2000)`) + `Concat(X&','&Y&','&ID, ';')` ships ~2,000 points per cell (~10–20× less JSON).

## 4. The zone configuration UI (the hard part)

Constraints: stock panel controls only; nested arrays inside array items are unproven; zones need
rectangles AND polylines; values should accept expressions/variables (`=vCoreLimit`).

### Layer A — property-panel zone list (source of truth, always present)
`Appearance › Zones` → `type:'array'`, `ref:'props.zones'`, `itemTitleRef:'label'`, add/remove/move (order = priority, inner → outer):
- `label` (string), `show` (switch, expression-capable), `color` (`color-picker`, `{index,color}`)
- `shape` dropdown: **Band (Y only)** | **Rectangle** | **Envelope (along X)**
- Band/Rectangle: `yMin`, `yMax`, `xMin`, `xMax` — numbers with `expression:'optional'` (evaluated in layout)
- Envelope: `upper`, `lower` — string fields `x,y; x,y; …` (expression-optional, so `=Concat(…)` or a variable
  can supply a governed polyline), plus a mirror switch ("lower = −upper") for symmetric funnels
- Validation feedback in the chart (edit mode): unparsable vertices / min>max shown as a warning chip, never a blank chart.
- Global: "Outside" label + colour, show outlines, show in-plot tags.

### Layer B — in-chart zone editor (edit mode only)
When the sheet is in edit mode (`useInteractionState().edit` / constraints), a toolbar toggle "Edit zones":
- Draw a rectangle (drag), a band (drag on Y gutter), or an envelope (click vertices along x, upper then lower / mirrored).
- Drag handles move vertices and edges; snapping to nice axis ticks; numeric readout while dragging.
- Selecting a zone in the chart highlights its entry; each commit writes `props.zones` via `applyPatches`
  (fields that hold an expression are shown locked — the editor never overwrites a `=…` value).
- This is where the component's value shows; Layer A stays the precise/numeric fallback.

### Layer C — zones from data (optional source mode)
`Zones from: Properties | Data model`. Data model = a second hypercube in the properties
(`props.zoneCube.qHyperCubeDef`: ZoneID, Label, Color, Edge upper/lower, Seq, X, Y) so zone definitions
(e.g. an ODD/limit table) are governed in the load script and change with selections if wanted.

## 5. Interaction ↔ Qlik selection mapping (proposed)

- Gestures open Qlik selection mode (`selections.begin(['/qHyperCubeDef'])`); the chart previews with its own
  intersection dimming; Qlik toolbar confirm/cancel; `canceled`/`deactivated` listeners clear the preview.
- x range / y range / Range box / rectangle-zone pick → `rangeSelectHyperCubeValues` on measure indices (exact, cheap).
- Lasso / envelope-zone pick / any mix → resolve the point set client-side → `selectHyperCubeValues` on the ID
  dimension with elemNumbers (chunked; needs a spike at 100k+ values) — or rectangle approximation.
- Legend click = hide/show (session only, not a selection); Shift/Ctrl-click = zone selection as above.
- Pan/zoom never select; view saved in snapshots via `onTakeSnapshot`.

## 6. Decisions (Manuel, 2026-09-25)

- **D1 Data transport → keep it simple**: plain parallel paging of the straight cube into typed arrays,
  progressive render, a configurable max-points cap. Packed/binned transport stays a later optimisation.
- **D2 After confirm → normal Qlik behaviour**: unselected points leave the cube; no greyed context layer.
  The chart's own dimming exists only as the preview during selection mode.
- **D3 Selections → like native Qlik**: axis ranges / Range box / rectangle zones → `rangeSelectHyperCubeValues`
  on the measures; lasso and envelope/polygon zones → converted to rectangles and sent as one
  `multiRangeSelectHyperCubeValues` (the native scatter's `calculateDataRects` approach). No elemNumber lists,
  so the ID dimension only guarantees one row per point.
- **D4 Zone UI → complete, mirroring the native scatter**: all three layers (panel list, on-chart editor in
  edit mode, zones from the data model), with the panel following the native scatter's Add-ons idiom
  (see §4a).
- **D5 Platforms → Qlik Cloud and client-managed**: hooks must degrade on older stardust
  (`useInteractionState` → fall back to `useConstraints`), no Cloud-only APIs without a fallback; tested on both.
- **D6 Look → the app theme**: no brand-ui theme; a mapping layer feeds `useTheme()` into the chart's tokens —
  `dataColors`/palettes → zone defaults and `--chart-N`, `object.axis` styles → axes/grid, font family/sizes,
  object background, `dataColors.selected/excluded` → selection preview. Dark themes via `background.isDark`.

## 4a. Zone panel modelled on the native scatter (Add-ons)

Native Qlik Cloud scatter (help.qlik.com, "Creating scatter plots"): Add-ons › Reference lines (X: value;
Y: `y = kx + m` with slope), Add-ons › Shapes (Points, Lines, Polygons — each with "Add point" lists whose
X/Y accept measure or dimension values), Add-ons › Partitions (Two zones, Quadrants, Four zones,
Horizontal zones with "Add limit"), each with colour + opacity, show lines, line style.

qixHighDScatter maps that to:
- **Add-ons › Zones** — the ordered list (priority inner → outer), each item: label, show condition,
  colour + opacity, outline on/off + line type, show tag, and **Zone type**:
  - *Horizontal band* — Y min/max (≙ Horizontal zones)
  - *Rectangle* — X min/max + Y min/max
  - *Envelope* — upper points + lower points along X, "Add point" lists, mirror switch (≙ funnel)
  - *Polygon* — "Add point" list (≙ native Polygons; needs a generic `polygon` bounds kind added to
    brand-ui `DensityZone` — point-in-polygon already exists in `selection.ts`)
  - every coordinate is a number with `expression:'optional'`.
- **Add-ons › Zones source** — Properties | Data model (Layer C: ZoneID, Label, Color, Kind, Edge, Seq, X, Y).
- **Add-ons › Reference lines** — X lines and Y lines (`y = kx + m`) as in native, drawn as outline-only
  overlays (not classifying).
- **Appearance › Presentation** — point size, cell size, underlay threshold, colour by (Zone / Density /
  Measure / Dimension), outside label + colour, max points, zoom on/off, toolbar on/off.
- Nested "Add point" arrays inside a zone item are what the native panel does but are **unproven for
  extensions** → spike #1. Fallback if they fail: the `x,y; x,y` text field plus the on-chart editor.

## 7. Spikes to run first (on a real tenant, before feature work)

1. Array item with `expression:'optional'` numbers + colour picker renders and evaluates in the layout;
   a nested "Add point" array inside an array item renders, saves and evaluates.
2. Bundle size + scoped CSS of React + DensityScatterChart inside a supernova; renders in Cloud; no CSP issues.
3. Fetch 500k × 3 via parallel paging vs. packed transport — wall time, memory.
4. `rangeSelectHyperCubeValues` (2-measure box) and `multiRangeSelectHyperCubeValues` (lasso as ~20–100
   rectangles) inside selection mode — correct result, toolbar behaviour, on Cloud and client-managed.
5. `applyPatches` from the canvas in edit mode persists; blocked/ignored in published apps.

## 8. Scaffold plan

Fork **qixVizlib** (single `src/index.js` source, esbuild libs → UMD, the only full-cube pager, theme helpers) but
switch the source to TSX with esbuild bundling React + brand-ui; graft HierarchySelect's selection robustness
(re-entrancy flag, clearSelections vs cancel, qLocked), MarkdownViewer's packaging script, the skill's
`prepare-release.sh` layout (`extension/`, `research/`, `release/`). Per-object state keyed on `qInfo.qId`,
`useRect` + DPR canvas sizing, full cleanup incl. GL context.
