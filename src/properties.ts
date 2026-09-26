import { openEditor } from "./editor/registry";

/**
 * qixHighDScatter — initial properties + property-panel definition.
 *
 * Panel layout mirrors the native Qlik scatter: Data → Sorting → Add-ons (Zones,
 * Reference lines, data handling) → Appearance (Presentation). Stock components
 * only (no styling-panel, no custom components) — both silently break uploaded
 * extensions' panels.
 */

export const MAX_ZONES = 15;

const num = (ref: string, label: string, defaultValue?: number, show?: (d: any) => boolean) => ({
  ref,
  label,
  type: "number",
  expression: "optional",
  ...(defaultValue !== undefined ? { defaultValue } : {}),
  ...(show ? { show } : {}),
});

const pointList = (ref: string, label: string, add: string, show: (d: any) => boolean) => ({
  type: "array",
  ref,
  label,
  itemTitleRef: (item: any, index: number) => `Point ${index + 1}`,
  allowAdd: true,
  allowRemove: true,
  allowMove: true,
  addTranslation: add,
  show,
  items: {
    x: num("x", "X"),
    y: num("y", "Y"),
  },
});

/** A 3rd measure is the Size, as in the native scatter (unless an old object uses it for colour). */
const hasSizeMeasure = (d: any) => {
  const n = d?.qHyperCubeDef?.qMeasures?.length ?? 0;
  return n >= 4 || (n === 3 && d?.props?.colorBy !== "value");
};

const isKind = (k: string) => (d: any) => (d.kind || "band") === k;
const isNotKind = (k: string) => (d: any) => (d.kind || "band") !== k;
const isBandOrRect = (d: any) => ["band", "rect"].includes(d.kind || "band");

const onOff = (ref: string, label: string, defaultValue = true) => ({
  ref,
  label,
  type: "boolean",
  defaultValue,
  component: "switch",
  options: [
    { value: true, label: "On" },
    { value: false, label: "Off" },
  ],
});

/** "X-axis: <measure label>" — the native section naming. */
const axisTitle = (d: any, ix: number, fallback: string) => {
  const m = d?.qHyperCubeDef?.qMeasures?.[ix];
  const t = m?.qDef?.qLabel || m?.qDef?.qDef || "";
  return t ? `${fallback}: ${t}` : fallback;
};

const axisSection = (key: "xAxis" | "yAxis", ix: number, fallback: string) => ({
  type: "items",
  label: (d: any) => axisTitle(d, ix, fallback),
  grouped: true,
  items: {
    show: {
      ref: `props.${key}.show`,
      label: "Labels and title",
      type: "string",
      component: "dropdown",
      defaultValue: "all",
      options: [
        { value: "all", label: "Labels and title" },
        { value: "labels", label: "Labels only" },
        { value: "title", label: "Title only" },
        { value: "none", label: "None" },
      ],
    },
    spacing: {
      ref: `props.${key}.spacing`,
      label: "Scale (grid line spacing)",
      type: "string",
      component: "dropdown",
      defaultValue: "medium",
      options: [
        { value: "narrow", label: "Narrow" },
        { value: "medium", label: "Medium" },
        { value: "wide", label: "Wide" },
      ],
    },
    autoRange: {
      ref: `props.${key}.autoRange`,
      label: "Range",
      type: "boolean",
      component: "switch",
      defaultValue: true,
      options: [
        { value: true, label: "Auto" },
        { value: false, label: "Custom" },
      ],
    },
    min: {
      ref: `props.${key}.min`,
      label: "Min",
      type: "string",
      expression: "optional",
      defaultValue: "",
      show: (d: any) => d.props?.[key]?.autoRange === false,
    },
    max: {
      ref: `props.${key}.max`,
      label: "Max",
      type: "string",
      expression: "optional",
      defaultValue: "",
      show: (d: any) => d.props?.[key]?.autoRange === false,
    },
  },
});

export const initialProperties = {
  qInfo: { qType: "qixHighDScatter" },
  version: 1,
  showTitles: true,
  title: "",
  subtitle: "",
  footnote: "",
  components: [],
  qHyperCubeDef: {
    qDimensions: [],
    qMeasures: [],
    qMode: "S",
    qSuppressMissing: true,
    qSuppressZero: false,
    qInterColumnSortOrder: [],
    // Rows are fetched by the extension in 10k-cell pages; keep the layout light.
    qInitialDataFetch: [{ qWidth: 0, qHeight: 0 }],
  },
  props: {
    zones: [],
    statLines: [],
    zoneSource: "props",
    zoneFields: { id: "ZoneID", label: "ZoneLabel", color: "ZoneColor", edge: "ZoneEdge", seq: "ZoneSeq", x: "ZoneX", y: "ZoneY" },
    outsideLabel: "Outside",
    outsideColor: { color: "#8a8a8a", index: -1 },
    pointOpacity: 1,
    densityFloor: 0.55,
    sizeRangeSlider: [1.2, 7],
    outsideInteractive: true,
    showOutlines: true,
    showZoneTags: true,
    showStats: false,
    colorBy: "zone",
    pointRadius: 1.35,
    cellSize: 5,
    underlay: 4,
    maxPoints: 1000000,
    zoom: true,
    toolbar: true,
    legend: true,
    legendShow: true,
    legendPosition: "auto",
    legendTitleShow: true,
    legendTitle: "",
    xAxis: { show: "all", spacing: "medium", autoRange: true, min: "", max: "" },
    yAxis: { show: "all", spacing: "medium", autoRange: true, min: "", max: "" },
  },
};

export const QUADRANT_NAMES = ["Top left", "Top right", "Bottom left", "Bottom right"];
/** Per quadrant: name + colour (q0 = top left, q1 = top right, q2 = bottom left, q3 = bottom right). */
function quadrantItems() {
  const out: Record<string, unknown> = {};
  QUADRANT_NAMES.forEach((name, i) => {
    out[`q${i}Label`] = {
      ref: `q${i}Label`,
      label: `${name}: name`,
      type: "string",
      expression: "optional",
      defaultValue: name,
      show: isKind("quadrant"),
    };
    out[`q${i}Color`] = {
      ref: `q${i}Color`,
      label: `${name}: colour`,
      type: "object",
      component: "color-picker",
      dualOutput: true,
      defaultValue: { index: -1, color: null },
      show: isKind("quadrant"),
    };
  });
  return out;
}

const zoneItems = {
  label: { ref: "label", label: "Label", type: "string", expression: "optional", defaultValue: "Zone" },
  show: {
    ref: "show",
    label: "Show",
    type: "boolean",
    component: "switch",
    options: [
      { value: true, label: "On" },
      { value: false, label: "Off" },
    ],
    defaultValue: true,
  },
  kind: {
    ref: "kind",
    label: "Zone type",
    type: "string",
    component: "dropdown",
    defaultValue: "band",
    options: [
      { value: "band", label: "Horizontal band (Y min/max)" },
      { value: "rect", label: "Rectangle (X and Y min/max)" },
      { value: "envelope", label: "Envelope along X (upper/lower points)" },
      { value: "line", label: "Line (everything above or below)" },
      { value: "polygon", label: "Polygon (points)" },
      { value: "circle", label: "Circle / ellipse (centre and radii)" },
      { value: "quadrant", label: "Quadrants (4 named areas split by an X and a Y line)" },
    ],
  },
  cover: {
    ref: "cover",
    label: "Covers",
    type: "string",
    component: "buttongroup",
    defaultValue: "inside",
    options: [
      { value: "inside", label: "Inside" },
      { value: "outside", label: "Outside" },
    ],
    show: (d: any) => d.kind !== "quadrant",
  },
  cx: num("cx", "Centre X", 0, isKind("circle")),
  cy: num("cy", "Centre Y", 0, isKind("circle")),
  rx: num("rx", "Radius along X", 1, isKind("circle")),
  ry: num("ry", "Radius along Y", 1, isKind("circle")),
  xSplit: num("xSplit", "Vertical line at X (empty = middle of the X axis)", undefined, isKind("quadrant")),
  ySplit: num("ySplit", "Horizontal line at Y (empty = middle of the Y axis)", undefined, isKind("quadrant")),
  ...quadrantItems(),
  yMin: num("yMin", "Y min", -1, isBandOrRect),
  yMax: num("yMax", "Y max", 1, isBandOrRect),
  xMin: num("xMin", "X min", 0, (d: any) => isKind("rect")(d) && d.extendStart !== true),
  xMax: num("xMax", "X max", 1, (d: any) => isKind("rect")(d) && d.extendEnd !== true),
  mirror: {
    ref: "mirror",
    label: "Lower edge mirrors upper (−y)",
    type: "boolean",
    component: "switch",
    options: [
      { value: true, label: "On" },
      { value: false, label: "Off" },
    ],
    defaultValue: true,
    show: isKind("envelope"),
  },
  upper: pointList("upper", "Upper edge", "Add point", isKind("envelope")),
  lower: pointList("lower", "Lower edge", "Add point", (d: any) => isKind("envelope")(d) && d.mirror === false),
  points: pointList("points", "Polygon points", "Add point", isKind("polygon")),
  line: pointList("line", "Line points", "Add point", isKind("line")),
  side: {
    ref: "side",
    label: "Covers the side",
    type: "string",
    component: "buttongroup",
    defaultValue: "above",
    options: [
      { value: "above", label: "Above" },
      { value: "below", label: "Below" },
    ],
    show: isKind("line"),
  },
  extendStart: {
    ref: "extendStart",
    label: "Left end",
    type: "boolean",
    component: "buttongroup",
    defaultValue: false,
    options: [
      { value: false, label: "Closed" },
      { value: true, label: "Endless" },
    ],
    show: (d: any) => ["rect", "envelope", "line"].includes(d.kind),
  },
  extendEnd: {
    ref: "extendEnd",
    label: "Right end",
    type: "boolean",
    component: "buttongroup",
    defaultValue: false,
    options: [
      { value: false, label: "Closed" },
      { value: true, label: "Endless" },
    ],
    show: (d: any) => ["rect", "envelope", "line"].includes(d.kind),
  },
  colorByExpr: {
    show: (d: any) => d.kind !== "quadrant",
    ref: "colorByExpr",
    label: "Color",
    type: "boolean",
    component: "buttongroup",
    defaultValue: false,
    options: [
      { value: false, label: "Fixed" },
      { value: true, label: "Expression" },
    ],
  },
  color: {
    ref: "color",
    label: "Color",
    type: "object",
    component: "color-picker",
    dualOutput: true,
    defaultValue: { index: -1, color: null },
    show: (d: any) => d.colorByExpr !== true && d.kind !== "quadrant",
  },
  colorExpr: {
    ref: "colorExpr",
    label: "Color expression (e.g. =If(Sum(Risk) > 10, RGB(200,40,40), '#4477aa'))",
    type: "string",
    expression: "optional",
    defaultValue: "",
    show: (d: any) => d.colorByExpr === true && d.kind !== "quadrant",
  },
};

/** One reference line (stored under props.statLines). `stat` doubles as the list title. */
const statLineItems = {
  stat: {
    ref: "stat",
    label: "Statistic",
    type: "string",
    component: "dropdown",
    defaultValue: "Average",
    options: [
      { value: "Average", label: "Average" },
      { value: "Median", label: "Median" },
      { value: "Std dev", label: "Standard deviation (average ± k·σ)" },
    ],
  },
  k: {
    ref: "k",
    label: "k (number of standard deviations)",
    type: "number",
    defaultValue: 1,
    min: 0.1,
    max: 10,
    show: (d: any) => d.stat === "Std dev",
  },
  axis: {
    ref: "axis",
    label: "Of",
    type: "string",
    component: "buttongroup",
    defaultValue: "y",
    options: [
      { value: "y", label: "Y (horizontal line)" },
      { value: "x", label: "X (vertical line)" },
    ],
  },
  by: {
    ref: "by",
    label: "For",
    type: "string",
    component: "buttongroup",
    defaultValue: "class",
    options: [
      { value: "class", label: "Per colour group" },
      { value: "all", label: "All points" },
    ],
  },
  span: {
    ref: "span",
    label: "Line length",
    type: "string",
    component: "buttongroup",
    defaultValue: "class",
    options: [
      { value: "class", label: "Across the group's points" },
      { value: "plot", label: "Full width" },
    ],
    show: (d: any) => d.by !== "all",
  },
  labelMode: {
    ref: "labelMode",
    label: "Label",
    type: "string",
    component: "dropdown",
    defaultValue: "computation",
    options: [
      { value: "computation", label: "Name and value" },
      { value: "value", label: "Value only" },
      { value: "custom", label: "Custom text" },
      { value: "none", label: "None" },
    ],
  },
  labelText: {
    ref: "labelText",
    label: "Label text",
    type: "string",
    expression: "optional",
    defaultValue: "",
    show: (d: any) => d.labelMode === "custom",
  },
  lineStyle: {
    ref: "lineStyle",
    label: "Line style",
    type: "string",
    component: "dropdown",
    defaultValue: "auto",
    options: [
      { value: "auto", label: "Auto (average dashed, median and σ dotted)" },
      { value: "solid", label: "Solid" },
      { value: "dashed", label: "Dashed" },
      { value: "dotted", label: "Dotted" },
    ],
  },
};

export const definition = {
  type: "items",
  component: "accordion",
  items: {
    data: { uses: "data" },
    addons: {
      type: "items",
      component: "expandable-items",
      translation: "properties.addons",
      items: {
        zones: {
          type: "items",
          label: "Zones",
          items: {
            zoneSource: {
              ref: "props.zoneSource",
              label: "Zones from",
              type: "string",
              component: "buttongroup",
              defaultValue: "props",
              options: [
                { value: "props", label: "Properties" },
                { value: "data", label: "Data model" },
              ],
            },
            zoneFieldsHeader: {
              component: "text",
              label: "Zone table: one row per vertex. Edge = upper/lower (envelope, ordered by Seq; no lower rows = mirrored) or min/max (rectangle corners; empty X = horizontal band). Color = hex or palette index.",
              show: (d: any) => d.props?.zoneSource === "data",
            },
            ...Object.fromEntries(
              [
                ["id", "Zone ID field"],
                ["label", "Label field"],
                ["color", "Color field"],
                ["edge", "Edge field"],
                ["seq", "Seq field"],
                ["x", "X field"],
                ["y", "Y field"],
                ["cover", "Covers field (inside/outside, optional)"],
                ["ends", "Ends field (closed/endless/endless-left/endless-right, optional)"],
              ].map(([k, label]) => [
                `zf_${k}`,
                { ref: `props.zoneFields.${k}`, label: label, type: "string", show: (d: any) => d.props?.zoneSource === "data" },
              ]),
            ),
            editZones: {
              component: "button",
              label: "Edit zones…",
              action: (data: any) => {
                openEditor(data?.qInfo?.qId);
              },
              show: (d: any) => d.props?.zoneSource !== "data",
            },
            editZonesHint: {
              component: "text",
              label: "Opens the zone editor over the sheet: draw, drag points, reorder. The list below edits the same zones field by field.",
              show: (d: any) => d.props?.zoneSource !== "data",
            },
            zoneList: {
              type: "array",
              ref: "props.zones",
              label: "Zones (first match wins — inner to outer)",
              itemTitleRef: "label",
              allowAdd: true,
              allowRemove: true,
              allowMove: true,
              addTranslation: "Add zone",
              show: (d: any) => d.props?.zoneSource !== "data",
              items: zoneItems,
            },
            outsideLabel: { ref: "props.outsideLabel", label: "Outside label", type: "string", expression: "optional" },
            outsideColorByExpr: {
              ref: "props.outsideColorByExpr",
              label: "Outside color",
              type: "boolean",
              component: "buttongroup",
              defaultValue: false,
              options: [
                { value: false, label: "Fixed" },
                { value: true, label: "Expression" },
              ],
            },
            outsideColor: {
              ref: "props.outsideColor",
              label: "Outside color",
              type: "object",
              component: "color-picker",
              dualOutput: true,
              show: (d: any) => d.props?.outsideColorByExpr !== true,
            },
            outsideColorExpr: {
              ref: "props.outsideColorExpr",
              label: "Outside color expression",
              type: "string",
              expression: "optional",
              defaultValue: "",
              show: (d: any) => d.props?.outsideColorByExpr === true,
            },
            outsideInteractive: {
              ref: "props.outsideInteractive",
              label: "No-zone area in legend and selectable",
              type: "boolean",
              component: "switch",
              defaultValue: true,
              options: [
                { value: true, label: "On" },
                { value: false, label: "Off" },
              ],
            },
          },
        },
        referenceLines: {
          type: "items",
          label: "Reference lines",
          items: {
            statLinesHint: {
              component: "text",
              label: "Average, median or standard-deviation lines, computed from the loaded points. \"Per colour group\" draws one line per zone (or per dimension value when colouring by dimension), in that group's colour, across that group's points. Hidden legend entries get no line.",
            },
            statLines: {
              type: "array",
              ref: "props.statLines",
              label: "Lines",
              itemTitleRef: "stat",
              allowAdd: true,
              allowRemove: true,
              allowMove: true,
              addTranslation: "Add line",
              items: statLineItems,
            },
          },
        },
        dataHandling: {
          uses: "dataHandling",
          items: {
            calcCond: { uses: "calcCond" },
            maxPoints: {
              ref: "props.maxPoints",
              label: "Max points fetched",
              type: "number",
              defaultValue: 1000000,
              min: 1000,
              max: 2000000,
            },
          },
        },
      },
    },
    appearance: {
      uses: "settings",
      items: {
        presentation: {
          type: "items",
          label: "Presentation",
          grouped: true,
          items: {
            zoom: onOff("props.zoom", "Navigation (wheel zoom, drag pan)"),
            pointRadius: {
              ref: "props.pointRadius",
              label: "Point size",
              type: "number",
              component: "slider",
              min: 0.5,
              max: 4,
              step: 0.05,
              show: (d: any) => !hasSizeMeasure(d),
            },
            sizeRange: {
              type: "array",
              component: "slider",
              label: "Point size range (by the Size measure)",
              ref: "props.sizeRangeSlider",
              min: 0.5,
              max: 20,
              step: 0.5,
              defaultValue: [1.2, 7],
              show: (d: any) => hasSizeMeasure(d),
            },
            pointOpacity: {
              ref: "props.pointOpacity",
              label: "Point opacity",
              type: "number",
              component: "slider",
              min: 0.1,
              max: 1,
              step: 0.05,
              defaultValue: 1,
            },
            densityFloor: {
              ref: "props.densityFloor",
              label: "Sparse point strength (low = lone points fade, 1 = full colour)",
              type: "number",
              component: "slider",
              min: 0,
              max: 1,
              step: 0.05,
              defaultValue: 0.55,
            },
            cellSize: {
              ref: "props.cellSize",
              label: "Density resolution (cell size, px)",
              type: "number",
              component: "slider",
              min: 2,
              max: 12,
              step: 1,
            },
            underlay: {
              ref: "props.underlay",
              label: "Density underlay from (points per cell, 0 = off)",
              type: "number",
              defaultValue: 4,
            },
            showOutlines: onOff("props.showOutlines", "Zone outlines"),
            showZoneTags: onOff("props.showZoneTags", "Zone tags in plot"),
            showStats: onOff("props.showStats", "Show statistics (on surface / visible / selected)", false),
          },
        },
        colorsAndLegend: {
          type: "items",
          label: "Colors and legend",
          grouped: true,
          items: {
            colorBy: {
              ref: "props.colorBy",
              label: "Color by",
              type: "string",
              component: "dropdown",
              options: [
                { value: "zone", label: "Zone" },
                { value: "category", label: "Dimension (2nd dimension)" },
                { value: "value", label: "Measure (4th measure: Color)" },
                { value: "density", label: "Density only" },
              ],
            },
            legendShow: {
              ref: "props.legendShow",
              label: "Show legend",
              type: "boolean",
              component: "switch",
              defaultValue: true,
              options: [
                { value: true, label: "On" },
                { value: false, label: "Off" },
              ],
              show: (d: any) => ["zone", "category"].includes(d.props?.colorBy || "zone"),
            },
            legendTitleShow: {
              ref: "props.legendTitleShow",
              label: "Show legend title",
              type: "boolean",
              component: "switch",
              defaultValue: true,
              options: [
                { value: true, label: "On" },
                { value: false, label: "Off" },
              ],
              show: (d: any) =>
                d.props?.legendShow !== false && ["zone", "category"].includes(d.props?.colorBy || "zone"),
            },
            legendTitle: {
              ref: "props.legendTitle",
              label: "Legend title (empty = automatic)",
              type: "string",
              expression: "optional",
              defaultValue: "",
              show: (d: any) =>
                d.props?.legendShow !== false &&
                d.props?.legendTitleShow !== false &&
                ["zone", "category"].includes(d.props?.colorBy || "zone"),
            },
            legendPosition: {
              ref: "props.legendPosition",
              label: "Legend position",
              type: "string",
              component: "dropdown",
              defaultValue: "auto",
              options: [
                { value: "auto", label: "Auto" },
                { value: "right", label: "Right" },
                { value: "bottom", label: "Bottom" },
                { value: "left", label: "Left" },
                { value: "top", label: "Top" },
              ],
              show: (d: any) =>
                d.props?.legendShow !== false && ["zone", "category"].includes(d.props?.colorBy || "zone"),
            },
          },
        },
        xAxis: axisSection("xAxis", 0, "X-axis"),
        yAxis: axisSection("yAxis", 1, "Y-axis"),
      },
    },
  },
};

export const dataTargets = [
  {
    path: "/qHyperCubeDef",
    dimensions: {
      min: 1,
      max: 2,
      description: (_props: unknown, index: number) => (index === 0 ? "Point identity (one row per point)" : "Category (color by)"),
    },
    measures: {
      min: 2,
      max: 4,
      description: (_props: unknown, index: number) => ["X-axis", "Y-axis", "Size", "Color"][index] ?? "Measure",
    },
  },
];
