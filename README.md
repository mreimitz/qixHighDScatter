# High Density Scatter for Qlik Sense

**A Qlik Sense scatter plot that draws every point, up to a million of them, and classifies each point into zones you define on the axes.**

![One million points classified into three zones, in a Qlik Cloud app](docs/screenshots/overview-1m-points.png)

_1,000,000 points in a Qlik Cloud app. Every point is drawn; nothing is sampled away. Three zones classify the points (the first match wins), and σ reference lines show the spread._

The native Qlik scatter plot switches to a binned view once there are too many points. qixHighDScatter keeps every point visible and selectable. It is a nebula.js supernova built on the brand-ui `DensityScatterChart`.

## Highlights

- **Up to 1M points, all drawn.** Rendering uses WebGL. Without WebGL, a fast Canvas2D fallback takes over.
- **Zones on the axes.** The zone types are:
  - horizontal band
  - rectangle
  - envelope along X
  - line
  - polygon
  - circle or ellipse
  - quadrants

  Zones form an ordered list, and the first match wins. The legend shows each zone's share of the points.

- **A visual zone editor.** Draw the zones on top of your real data and drag their handles. Any coordinate can also be a Qlik expression.
- **Zones from the data model.** A zone table can drive the zones instead of the properties.
- **Native Qlik selections.** Range, lasso and legend-zone selections become real Qlik selections, with the usual ✓ / ✕ selection toolbar.
- **Deep zoom.** The mouse wheel zooms at the cursor, dragging pans, and a minimap shows where you are.
- **Reference lines.** Average, median and ±σ lines.

## Screenshots

### Zoom into the detail

The mouse wheel zooms toward the cursor until individual points separate. The minimap in the corner shows where you are.

![Wheel-zoomed into the Key Zone, with the zoom controls and the minimap](docs/screenshots/wheel-zoom-detail.png)

### Select a whole zone

Shift-click a zone in the legend. All of its points become a Qlik selection, and every other point is dimmed.

![The Key Zone selected from the legend, with the other zones dimmed](docs/screenshots/zone-selection.png)

### Zone editor

**Edit zones…** opens the editor over your data. You can reorder the zones, pick a type, and drag the shape on the canvas.

![Zone editor with a circle zone selected](docs/screenshots/zone-editor-circle.png)

For an envelope, drag the vertices on the canvas or type the points into the table. The lower edge can mirror the upper edge.

![Zone editor with an envelope zone and its upper-edge points](docs/screenshots/zone-editor-envelope.png)

### Properties panel

All zone settings are in **Add-ons › Zones**. That includes the source (Properties or Data model), the zone list, and the label and colour for points outside every zone.

![The chart in edit mode with the Zones section of the property panel](docs/screenshots/properties-panel.png)

## Install (no coding needed)

1. Download `release/qixHighDScatter-v<version>.zip`. Don't unzip it.
2. Upload the zip as an extension:
   - **Qlik Cloud:** Administration › Extensions › Add
   - **Client-managed:** QMC › Extensions › Import
3. In a sheet, click **Edit sheet**. Open **Custom objects** and drag **High Density Scatter** onto the sheet.
4. Add the data:

| Slot                   | What goes there                       | Example            |
| ---------------------- | ------------------------------------- | ------------------ |
| Dimension 1            | The point identity: one row per point | `PointID`          |
| Dimension 2 (optional) | A category to colour by               | `Airline`          |
| Measure 1              | X axis                                | `Only(AlongTrack)` |
| Measure 2              | Y axis                                | `Only(CrossTrack)` |
| Measure 3 (optional)   | Point size                            | `Sum(Weight)`      |
| Measure 4 (optional)   | A value to colour by                  | `Avg(Speed)`       |

By default the chart fetches up to 1,000,000 points. You can raise this to 2,000,000 in **Data handling › Max points fetched**.

## Configure zones

Zones live under **Add-ons › Zones**.

- **From Properties.** Use **Edit zones…** or the list under it. Each zone has:
  - a label
  - a colour, either fixed or an expression
  - a show switch
  - one of the zone types

  Every coordinate accepts an expression, for example `=vCoreLimit`.

  An envelope can mirror its upper edge (−y) to form the lower edge. It can also be endless, continuing past its last point.

- **From Data model.** Map a zone table that has one row per vertex:

  `ZoneID, ZoneLabel, ZoneColor, ZoneEdge (upper | lower | min | max), ZoneSeq, ZoneX, ZoneY`

Points that match no zone fall into **Outside**. You can rename it, recolour it, and choose whether it appears in the legend and can be selected.

## Interaction

| Action                                   | Result                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------- |
| Mouse wheel                              | Zoom at the cursor                                                      |
| Drag                                     | Pan                                                                     |
| `+` / `−` / reset buttons                | Zoom in, zoom out, reset the view                                       |
| Range tool                               | Box-select X and Y together. Drag in an axis gutter to select one axis. |
| Lasso tool                               | Select the points inside a freehand shape                               |
| Click a legend entry                     | Hide or show that zone                                                  |
| Shift-click or Ctrl-click a legend entry | Select every point in that zone                                         |

Selections are real Qlik selections:

- Ranges and boxes use `rangeSelectHyperCubeValues` on the two measures.
- Lassos and envelope zones become up to 64 vertical strips, sent with `multiRangeSelectHyperCubeValues`. The native scatter plot selects the same way.

## Performance

- Loading 1M points from Qlik Cloud takes around 20 seconds. The data comes in pages, and points are drawn as they arrive.
- Pan and zoom stay smooth with WebGL.
- If the chart feels sluggish, check that the browser's hardware acceleration is on. Without it, the chart falls back to the slower Canvas2D renderer.

## Develop

```bash
npm install
npm run build        # → extension/qixHighDScatter/ (AMD bundle, qext, stubs)
npm run package      # → release/qixHighDScatter-v<version>.zip
node test/run-harness.mjs "?n=300000"   # real nebula.js runtime + EnigmaMocker in Chromium
node test/selection-test.mjs            # drives range / lasso / legend, records engine calls
node test/editor-test.mjs               # zone editor
node test/wheel-longtask.mjs            # wheel-zoom frame times
```

Setting `BRAND_UI_SRC=<elabs-components>/packages` builds against the brand-ui source instead of the published packages.

### Build notes

- `@nebula.js/stardust` is the only external. React, brand-ui and their dependencies are bundled.
- The brand-ui Tailwind CSS is compiled and then scoped to `.qhds`: cascade layers are unwrapped and `@font-face` rules are dropped. It is injected once.
- Colours, fonts, grid and surfaces come from the Qlik app theme (`src/theme.ts`).

Design and decisions are in [`research/CONCEPT.md`](research/CONCEPT.md). A load script for the test data is in [`research/test-data.qvs`](research/test-data.qvs).
