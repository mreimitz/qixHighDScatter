import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DensityScatterChart,
  type DensityColorBy,
  type DensityScatterSelection,
  type DensityZone,
  DENSITY_OUTSIDE_ID,
  classifyZones,
  resolveSelection,
  toggleZoneConstraint,
  type DensityStatLine,
  DensityShapeGlyph,
} from "@elabs-ai/components-charts";
import { shapeEntries, toShapeBy } from "./shapes";
import robotLoaderSvg from "./assets/robot-scatter-loader.svg";

/**
 * The loading animation (render mode "Loading animation"): a little robot
 * paints a scatter plot. With a known total the 20 s timeline is SCRUBBED by
 * the load progress (`--progress` 0–1), so the picture finishes exactly when
 * the points do; without one it free-runs.
 */
const ROBOT_FREE = robotLoaderSvg;
const ROBOT_CONTROLLED = robotLoaderSvg.replace("<svg ", '<svg class="qhds-rl-controlled" ');
import { fetchAllRows, type QhdsColumns } from "./data";
import { toDensityZones } from "./zones";
import { watchZoneTable } from "./data-zones";
import { ZoneEditor } from "./editor/ZoneEditor";
import { registerEditor } from "./editor/registry";
import { planSelection, toEngineSelect } from "./selection";
import type { QhdsTheme } from "./theme";
import { localeMarks, makeAxisFormatter, niceExtent, parseQlikColor } from "./format";

export interface AppProps {
  layout: any;
  model: any;
  app: any;
  selections: any;
  theme: QhdsTheme;
  width: number;
  height: number;
  /** Selecting allowed (analysis mode, not passive, not in edit). */
  canSelect: boolean;
  /** Passive (snapshot / print / tiny): no interaction at all. */
  passive: boolean;
  /** The sheet is in edit mode: the zone editor may open. */
  editMode: boolean;
  /** Lasso armed from Qlik's selection toolbar (the host's `lasso` action). */
  lassoActive: boolean;
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();
/** How often streamed points are handed to the chart while loading (ms). */
const PUBLISH_MS = 400;
/** The plot keeps at least this much room; everything else hides first. */
const MIN_PLOT_W = 200;
const MIN_PLOT_H = 130;
/** Height of the shape key strip (shape by dimension while colouring by zone). */
const SHAPE_KEY_H = 26;
/** Legend column of the chart's container legend (w-40) + its gap. */
const SIDE_LEGEND_W = 160 + 16;
/** "No selection" as a VALUE: `undefined` would flip the chart to uncontrolled,
 * and it would keep showing its last internal ranges after a clear/cancel. */
const NO_SELECTION: DensityScatterSelection = Object.freeze({});
const EMPTY: QhdsColumns = {
  x: new Float32Array(0),
  y: new Float32Array(0),
  elems: new Int32Array(0),
  labels: [],
  selected: new Uint8Array(0),
  n: 0,
  total: 0,
  done: false,
};

/** An object made before the Size role: colour by measure with exactly three measures. */
function legacyColor3(layout: any): boolean {
  return (layout?.qHyperCube?.qMeasureInfo?.length ?? 0) === 3 && layout?.props?.colorBy === "value";
}

function dataKey(layout: any): string {
  const hc = layout?.qHyperCube;
  if (!hc) return "";
  return JSON.stringify([
    hc.qSize,
    (hc.qDimensionInfo || []).map((d: any) => [d.cId, d.qFallbackTitle, d.qCardinal, d.qStateCounts]),
    (hc.qMeasureInfo || []).map((m: any) => [m.cId, m.qFallbackTitle, m.qMin, m.qMax]),
    layout?.props?.maxPoints,
    legacyColor3(layout),
  ]);
}

function fmt(n: number): string {
  return n.toLocaleString();
}

export function App({
  layout,
  model,
  app,
  selections,
  theme,
  width,
  height,
  canSelect,
  passive,
  editMode,
  lassoActive,
}: AppProps) {
  const hc = layout?.qHyperCube;
  const props = layout?.props ?? {};
  const inSelections = Boolean(layout?.qSelectionInfo?.qInSelections);

  // ---------- data ----------
  // `cols` is what the chart draws; `progress` is what the loading indicator
  // shows. They are published separately: pages land every few ms, but the
  // chart (re-binning, re-uploading, re-classifying every point) is only fed
  // every PUBLISH_MS — otherwise 300+ pages × O(n) work made loading quadratic.
  const [cols, setCols] = useState<QhdsColumns>(EMPTY);
  const [version, setVersion] = useState(0);
  // Nothing is "loading" until a fetch actually starts; the total is known from
  // the hypercube before the first page, so the bar is determinate from the start.
  const [progress, setProgress] = useState<{ n: number; total: number; done: boolean }>({ n: 0, total: 0, done: true });
  const [error, setError] = useState<string | null>(null);
  const key = dataKey(layout);
  const lastKey = useRef<string>("");
  // "live": points appear as they arrive. "animated": a loading animation with
  // the progress bar, then every point at once (also the cheapest way to load).
  const renderMode: "live" | "animated" = props.renderMode === "animated" ? "animated" : "live";
  useEffect(() => {
    if (!hc || hc.qError || hc.qCalcCondMsg) return;
    if (hc.qDimensionInfo.length < 1 || hc.qMeasureInfo.length < 2) return;
    // Engine data of an object in its own selection session is frozen; refetch once it ends.
    if (inSelections) return;
    if (key === lastKey.current) return;
    lastKey.current = key;
    setError(null);
    const maxPts = Math.max(1000, Number(props.maxPoints) || 1_000_000);
    const expected = Math.min(Number(hc.qSize?.qcy) || 0, maxPts);
    setProgress({ n: 0, total: expected, done: expected === 0 });
    let latest: QhdsColumns | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastPublish = 0;
    let published = false;
    const publish = () => {
      timer = null;
      if (!latest) return;
      lastPublish = performance.now();
      published = true;
      setCols(latest);
      setVersion((v) => v + 1);
    };
    const handle = fetchAllRows(
      model,
      hc,
      maxPts,
      legacyColor3(layout),
      (c) => {
        latest = c;
        setProgress((p) => (p.n === c.n && p.total === c.total && p.done === c.done ? p : { n: c.n, total: c.total, done: c.done }));
        if (c.done) {
          if (timer) clearTimeout(timer);
          publish();
          return;
        }
        if (renderMode === "animated") return;
        // First page right away (something to look at), then at most every PUBLISH_MS.
        if (!published) {
          publish();
          return;
        }
        if (!timer) timer = setTimeout(publish, Math.max(0, PUBLISH_MS - (performance.now() - lastPublish)));
      },
      (e) => setError(String((e as any)?.message ?? e)),
    );
    return () => {
      if (timer) clearTimeout(timer);
      handle.cancel();
      // allow the same key to be fetched again if this effect was torn down mid-way
      lastKey.current = "";
    };
  }, [key, inSelections, renderMode]); // eslint-disable-line react-hooks/exhaustive-deps

  // The chart treats `data` identity as "data changed": hand it a new wrapper per progress step.
  const data = useMemo(() => {
    const out: any = { x: cols.x.subarray(0, cols.n), y: cols.y.subarray(0, cols.n) };
    if (cols.values) {
      out.values = {};
      if (cols.values.value) out.values.value = cols.values.value.subarray(0, cols.n);
      if (cols.values.size) out.values.size = cols.values.size.subarray(0, cols.n);
    }
    if (cols.categories) {
      // Encoded (codes + labels), never one string per point: the chart reads
      // the codes as they are instead of re-encoding 10⁶ labels per update.
      const c = cols.categories.category!;
      out.categories = { category: { codes: c.codes.subarray(0, cols.n), labels: c.labels.slice() } };
    }
    return out;
  }, [version]); // eslint-disable-line react-hooks/exhaustive-deps

  const colsRef = useRef(cols);
  colsRef.current = cols;

  // The engine knows the extents before the first page lands: a stable domain
  // means no re-framing while points stream in.
  const domain = useMemo(() => {
    const mx = hc?.qMeasureInfo?.[0];
    const my = hc?.qMeasureInfo?.[1];
    if (!mx || !my) return undefined;
    const ok = (v: unknown) => typeof v === "number" && Number.isFinite(v);
    if (!ok(mx.qMin) || !ok(mx.qMax) || !ok(my.qMin) || !ok(my.qMax)) return undefined;
    // Auto range: widened to nice tick multiples (as Qlik does); a custom
    // min / max from the axis section wins per end.
    const range = (a: any, lo: number, hi: number): [number, number] => {
      let [n0, n1] = niceExtent(lo, hi);
      if (a?.autoRange === false) {
        const cMin = Number(a?.min);
        const cMax = Number(a?.max);
        if (a?.min !== "" && a?.min !== undefined && Number.isFinite(cMin)) n0 = cMin;
        if (a?.max !== "" && a?.max !== undefined && Number.isFinite(cMax)) n1 = cMax;
        if (!(n1 > n0)) [n0, n1] = niceExtent(lo, hi);
      }
      return [n0, n1];
    };
    const [x0, x1] = range(props.xAxis, mx.qMin, mx.qMax);
    const [y0, y1] = range(props.yAxis, my.qMin, my.qMax);
    return { x0, x1, y0, y1 };
  }, [
    hc?.qMeasureInfo?.[0]?.qMin,
    hc?.qMeasureInfo?.[0]?.qMax,
    hc?.qMeasureInfo?.[1]?.qMin,
    hc?.qMeasureInfo?.[1]?.qMax,
    JSON.stringify([props.xAxis, props.yAxis]),
  ]);

  // ---------- zones ----------
  const fromData = props.zoneSource === "data";
  const zoneFieldsKey = JSON.stringify(props.zoneFields ?? {});
  const [dataZones, setDataZones] = useState<{ raw: any[]; error?: string }>({ raw: [] });
  useEffect(() => {
    if (!fromData || !app) return;
    return watchZoneTable(app, props.zoneFields ?? {}, (raw, error) => setDataZones({ raw, error }));
  }, [fromData, app, zoneFieldsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const { zones, issues } = useMemo(() => {
    const r = toDensityZones(fromData ? dataZones.raw : props.zones, theme.resolveColor, domain);
    if (fromData && dataZones.error) r.issues.unshift({ zone: "Zone table", message: dataZones.error });
    return r;
  }, [layout, theme, fromData, dataZones, domain]);
  const outsideOn = props.outsideInteractive !== false;
  const outside = useMemo(
    () => ({
      label: String(props.outsideLabel ?? "Outside"),
      color:
        (props.outsideColorByExpr ? parseQlikColor(props.outsideColorExpr) : null) ??
        theme.resolveColor(props.outsideColor, 7),
      legend: outsideOn,
      selectable: outsideOn,
    }),
    [layout, theme, outsideOn],
  );

  const nMeas = hc?.qMeasureInfo?.length ?? 0;
  const nDims = hc?.qDimensionInfo?.length ?? 0;
  const colorBy: DensityColorBy = useMemo(() => {
    const want = props.colorBy || "zone";
    if (want === "value" && (nMeas >= 4 || legacyColor3(layout))) return { kind: "value", key: "value" };
    if (want === "category" && nDims >= 2) return { kind: "category", key: "category" };
    if (want === "density" || zones.length === 0) return { kind: "density" };
    return { kind: "zone" };
  }, [props.colorBy, nMeas, nDims, zones.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const hasSize = nMeas >= 3 && !legacyColor3(layout);
  // Shapes by the 2nd dimension (Add-ons › Shapes / the editor's Shapes tab).
  const shapesKey = JSON.stringify(props.shapes ?? null);
  const shapeBy = useMemo(() => toShapeBy(props.shapes, nDims >= 2), [shapesKey, nDims]); // eslint-disable-line react-hooks/exhaustive-deps
  const catLabels = cols.categories?.category.labels;
  const catTitle: string = hc?.qDimensionInfo?.[1]?.qFallbackTitle ?? "";
  const sizeRange = useMemo<[number, number]>(() => {
    const r = Array.isArray(props.sizeRangeSlider) ? props.sizeRangeSlider : [1.2, 7];
    const lo = Math.max(0.5, Number(r[0]) || 1.2);
    return [lo, Math.max(lo + 0.5, Number(r[1]) || 7)];
  }, [JSON.stringify(props.sizeRangeSlider)]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- selections (Qlik semantics) ----------
  const [selection, setSelection] = useState<DensityScatterSelection | undefined>(undefined);
  const zonesRef = useRef<DensityZone[]>(zones);
  zonesRef.current = zones;
  const domainRef = useRef<{ x0: number; x1: number; y0: number; y1: number } | undefined>(undefined);
  const busy = useRef(false);
  const pending = useRef<DensityScatterSelection | undefined | null>(null);

  useEffect(() => {
    if (!selections) return;
    const reset = () => setSelection(undefined);
    const on = selections.addListener?.bind(selections) ?? selections.on?.bind(selections);
    const off = selections.removeListener?.bind(selections) ?? selections.off?.bind(selections);
    if (!on) return;
    for (const ev of ["deactivated", "canceled", "cleared", "confirmed"]) on(ev, reset);
    return () => {
      if (off) for (const ev of ["deactivated", "canceled", "cleared", "confirmed"]) off(ev, reset);
    };
  }, [selections]);

  // Not in a selection session any more (confirmed / cancelled from outside,
  // a listener that never fired): drop the preview. Checked after every render,
  // so a stale preview can't survive into the next legend click or lasso.
  useEffect(() => {
    if (selection && !busy.current && selections && !selections.isActive?.()) setSelection(undefined);
  });
  /** The preview to build on: nothing once the session is gone. */
  const liveSelection = () =>
    selections?.isActive?.() || busy.current ? selectionRef.current : undefined;

  const pushToEngine = useCallback(
    async (sel: DensityScatterSelection | undefined) => {
      if (!selections) return;
      if (busy.current) {
        pending.current = sel ?? null;
        return;
      }
      busy.current = true;
      try {
        if (!selections.isActive()) await selections.begin(["/qHyperCubeDef"]);
        // Shapes (ranges, lasso, zones) go as measure ranges; picked dots as their
        // point-dimension values — toggled on when the shapes don't already cover them.
        const picked = sel?.points ?? [];
        const shapes: DensityScatterSelection | undefined = sel ? { ...sel, points: undefined } : undefined;
        const plan = planSelection(shapes, zonesRef.current, domainRef.current);
        const c = colsRef.current;
        const elemsOf = (idx: readonly number[]) =>
          [...new Set(idx.map((i) => c.elems[i] ?? -1).filter((e) => e >= 0))];
        if (plan.rects === null) {
          await selections.select(
            picked.length
              ? { method: "selectHyperCubeValues", params: ["/qHyperCubeDef", 0, elemsOf(picked), false] }
              : toEngineSelect(plan),
          );
        } else {
          await selections.select(toEngineSelect(plan));
          if (picked.length) {
            const pts = { x: c.x.subarray(0, c.n), y: c.y.subarray(0, c.n), n: c.n, values: {}, categories: {} };
            const covered = new Uint8Array(c.n);
            resolveSelection(pts, classifyZones(pts, zonesRef.current), zonesRef.current.map((z) => z.id), shapes, covered);
            const extra = elemsOf(picked.filter((i) => !covered[i]));
            if (extra.length) await selections.select({ method: "selectHyperCubeValues", params: ["/qHyperCubeDef", 0, extra, true] });
          }
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn("[qixHighDScatter] selection failed", e);
      } finally {
        busy.current = false;
        if (pending.current !== null) {
          const next = pending.current;
          pending.current = null;
          void pushToEngine(next ?? undefined);
        }
      }
    },
    [selections],
  );

  const onSelectionChange = useCallback(
    (next: DensityScatterSelection) => {
      if (!canSelect) return;
      setSelection(next);
      void pushToEngine(next);
    },
    [canSelect, pushToEngine],
  );

  // ---------- legend = selection (like a native Qlik chart coloured by dimension) ----------
  // A click on a legend entry selects: the zone (as range selections) in zone mode, the
  // dimension value (selectHyperCubeValues on the 2nd dimension) in category mode.
  // The checkbox that shows on hover hides or shows the entry (view only, no selection).
  const [hiddenKeys, setHiddenKeys] = useState<ReadonlySet<string>>(EMPTY_KEYS);
  const selectionRef = useRef<DensityScatterSelection | undefined>(undefined);
  // A click on a dot toggles its point-dimension value, like a native bubble tap.
  const onPointClick = useCallback(
    (index: number) => {
      if (!canSelect) return;
      const base = liveSelection();
      const cur = base?.points ?? [];
      const points = cur.includes(index) ? cur.filter((i) => i !== index) : [...cur, index];
      const next: DensityScatterSelection = { ...base, points };
      if (!points.length) delete next.points;
      setSelection(next);
      void pushToEngine(next);
    },
    [canSelect, pushToEngine],
  );
  selectionRef.current = selection;
  // A click on the empty plot opens Qlik's selection toolbar (lasso lives there),
  // as a click on a native chart does.
  const onBackgroundClick = useCallback(() => {
    if (!canSelect || !selections || selections.isActive?.()) return;
    Promise.resolve(selections.begin(["/qHyperCubeDef"])).catch(() => undefined);
  }, [canSelect, selections]);
  // Tooltip title = the point dimension's value (+ its row values).
  const describePoint = useCallback(
    (i: number) => {
      const c = colsRef.current;
      const title = c.labels[i];
      return title ? { title } : undefined;
    },
    [],
  );
  const onLegendPick = useCallback(
    (next: ReadonlySet<string>) => {
      const key = [...next][0];
      if (key === undefined || !canSelect || !selections) return;
      if (colorBy.kind === "category") {
        const cat = cols.categories?.category;
        const k = cat ? cat.labels.indexOf(key) : -1;
        const elem = k >= 0 ? cat!.elems[k] : undefined;
        if (elem === undefined || elem < 0) return;
        void (async () => {
          try {
            if (!selections.isActive()) await selections.begin(["/qHyperCubeDef"]);
            await selections.select({ method: "selectHyperCubeValues", params: ["/qHyperCubeDef", 1, [elem], true] });
          } catch (e) {
            // eslint-disable-next-line no-console
            console.warn("[qixHighDScatter] legend selection failed", e);
          }
        })();
        return;
      }
      if (colorBy.kind === "zone") {
        if (key === DENSITY_OUTSIDE_ID && props.outsideInteractive === false) return;
        const nextSel = toggleZoneConstraint(liveSelection(), key);
        setSelection(nextSel);
        void pushToEngine(nextSel);
      }
    },
    [canSelect, selections, colorBy.kind, cols, pushToEngine, props.outsideInteractive],
  );

  const onLegendItemClick = useCallback((key: string) => onLegendPick(new Set([key])), [onLegendPick]);

  // ---------- size ----------
  // Responsive like the native charts. The plot itself never goes away: when
  // the object shrinks, the chrome gives way in this order — statistics box,
  // zone tags, legend, axis titles, tick labels. The legend is MEASURED (its
  // height depends on how its entries wrap), and it stays only while the plot
  // keeps MIN_PLOT_W × MIN_PLOT_H.
  const tiny = width < 160 || height < 120;
  const small = width < 280 || height < 200;
  const legendMode: string =
    props.legendShow === false || (props.legendShow === undefined && props.legend === false) ? "off" : "auto";
  const legendWanted =
    legendMode !== "off" && !small && colorBy.kind !== "density" && colorBy.kind !== "value";
  const legendEntries =
    colorBy.kind === "category" ? (cols.categories?.category.labels.length ?? 0) : zones.length + 1;
  const legendSizeKey = `${width}|${height}|${colorBy.kind}|${legendEntries}|${legendWanted}|${props.legendPosition || "auto"}`;
  // Measured once per size/entries: whether the legend fits at all, the room it
  // takes, and whether a side legend had to fall back to the bottom (taller
  // than the object).
  const [legendFit, setLegendFit] = useState<{ key: string; fits: boolean; w: number; h: number; toBottom: boolean }>({
    key: legendSizeKey,
    fits: true,
    w: 0,
    h: 0,
    toBottom: false,
  });
  const fitCurrent = legendFit.key === legendSizeKey;
  const legendPos: "right" | "bottom" | "top" | "left" = (() => {
    const want = props.legendPosition || "auto";
    // The chart's legend engine never puts a legend at the side under 480 px.
    const sideOk = width >= 480 && width - SIDE_LEGEND_W >= MIN_PLOT_W && !(fitCurrent && legendFit.toBottom);
    if (want !== "auto") return (!sideOk && (want === "left" || want === "right") ? "bottom" : want) as any;
    return sideOk && width > height * 0.9 ? "right" : "bottom";
  })();
  const legendOn = legendWanted && (!fitCurrent || legendFit.fits);
  const frameRef = useRef<HTMLDivElement | null>(null);
  // Space the legend takes from the frame, from the last measurement (an
  // estimate until it is in the DOM).
  const legendW = legendOn ? (fitCurrent ? legendFit.w : legendPos === "left" || legendPos === "right" ? SIDE_LEGEND_W : 0) : 0;
  const legendH = legendOn ? (fitCurrent ? legendFit.h : legendPos === "top" || legendPos === "bottom" ? 36 : 0) : 0;
  // The shape key: a strip under the chart when the legend cannot carry the
  // glyphs (colour is by zone / density / measure, shape by the dimension).
  const shapeKeyOn = Boolean(
    shapeBy && colorBy.kind !== "category" && !small && catLabels?.length && height - legendH - SHAPE_KEY_H >= MIN_PLOT_H,
  );
  const shapeKeyH = shapeKeyOn ? SHAPE_KEY_H : 0;
  const plotHeight = Math.min(height - shapeKeyH, Math.max(MIN_PLOT_H, Math.floor(height - legendH - shapeKeyH)));
  const plotWidth = Math.min(width, Math.max(MIN_PLOT_W, Math.floor(width - legendW)));
  useLayoutEffect(() => {
    const root = frameRef.current?.querySelector('[data-slot="container-legend-root"]') as HTMLElement | null;
    const box = root?.querySelector(':scope > div:not(.flex-1)') as HTMLElement | null;
    if (!root || !box) {
      if (!fitCurrent) setLegendFit({ key: legendSizeKey, fits: true, w: 0, h: 0, toBottom: false });
      return;
    }
    const pos = root.getAttribute("data-container-legend-position");
    const side = pos === "left" || pos === "right";
    const gap = 16; // the engine's gap-4 between legend and plot
    const w = side ? box.offsetWidth + gap : 0;
    const h = side ? 0 : box.offsetHeight + gap;
    // A side legend taller than the object moves to the bottom (measured again there).
    const toBottom = (fitCurrent && legendFit.toBottom) || (side && box.offsetHeight > height);
    const fits = width - w >= MIN_PLOT_W && height - h - shapeKeyH >= MIN_PLOT_H && h <= height * 0.5 && w <= width * 0.5;
    if (!fitCurrent || legendFit.fits !== fits || legendFit.w !== w || legendFit.h !== h || legendFit.toBottom !== toBottom)
      setLegendFit({ key: legendSizeKey, fits, w, h, toBottom });
  });
  const axisOpt = (a: any, key: "x" | "y") => {
    const show: string = a?.show || "all";
    const labels = !tiny && (show === "all" || show === "labels");
    const title = !small && (show === "all" || show === "title");
    const spacing = a?.spacing === "narrow" ? (key === "x" ? 60 : 40) : a?.spacing === "wide" ? (key === "x" ? 140 : 95) : undefined;
    return { labels, title, spacing };
  };
  const xAx = axisOpt(props.xAxis, "x");
  const yAx = axisOpt(props.yAxis, "y");
  // The statistics box and the zone tags float over the plot: only when the plot has room for them.
  const roomy = plotWidth >= 360 && plotHeight >= 240;
  // The chart's bottom gutter (tick labels + axis title), as it computes it.
  const xGutter = Math.max(8, (xAx.labels ? 20 : 0) + (xAx.title ? 20 : 4));

  const status = !hc
    ? null
    : hc.qCalcCondMsg
      ? hc.qCalcCondMsg
      : hc.qError
        ? `Error: ${hc.qError.qErrorCode}`
        : nDims < 1 || nMeas < 2
          ? "Add a point dimension (one row per point) and two measures for X and Y."
          : error
            ? `Could not load data: ${error}`
            : null;

  domainRef.current = domain;

  // Number format per axis (the measure's own format, Qlik abbreviations on
  // "Auto"); the precision follows the visible span, so it tracks the zoom.
  const marks = useMemo(() => localeMarks(layout?.qLocaleInfo), [layout?.qLocaleInfo]);
  const [spans, setSpans] = useState<{ x: number; y: number } | null>(null);
  const homeSpans = domain ? { x: domain.x1 - domain.x0, y: domain.y1 - domain.y0 } : { x: 1, y: 1 };
  const span = spans ?? homeSpans;
  // ---------- statistics box ----------
  const statsOn = props.showStats === true && roomy;
  const viewRef = useRef<{ x0: number; x1: number; y0: number; y1: number } | null>(null);
  const [viewTick, setViewTick] = useState(0);
  const viewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onViewChange = useCallback((v: { x0: number; x1: number; y0: number; y1: number }) => {
    viewRef.current = v;
    if (!viewTimer.current) {
      viewTimer.current = setTimeout(() => {
        viewTimer.current = null;
        setViewTick((t) => t + 1);
      }, 120);
    }
    // Only a change of order of magnitude re-renders (every frame of a zoom would otherwise).
    const q = (n: number) => Math.round(Math.log10(Math.max(n, 1e-300)) * 4) / 4;
    setSpans((prev) => {
      const next = { x: v.x1 - v.x0, y: v.y1 - v.y0 };
      return prev && q(prev.x) === q(next.x) && q(prev.y) === q(next.y) ? prev : next;
    });
  }, []);
  const xTickN = Math.max(3, Math.round(Math.max(width - 120, 100) / (xAx.spacing ?? 90)));
  const yTickN = Math.max(3, Math.round(Math.max(height - 80, 80) / (yAx.spacing ?? 60)));
  const formatX = useMemo(
    () => makeAxisFormatter(hc?.qMeasureInfo?.[0], marks, span.x, xTickN),
    [hc?.qMeasureInfo?.[0]?.qNumFormat, marks, span.x, xTickN],
  );
  const formatY = useMemo(
    () => makeAxisFormatter(hc?.qMeasureInfo?.[1], marks, span.y, yTickN),
    [hc?.qMeasureInfo?.[1]?.qNumFormat, marks, span.y, yTickN],
  );
  const formatter = useMemo(() => {
    const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
    return (v: number) => nf.format(v);
  }, []);

  const visibleCount = useMemo(() => {
    if (!statsOn) return 0;
    const v = viewRef.current ?? domain;
    if (!v) return cols.n;
    let k = 0;
    for (let i = 0; i < cols.n; i++) {
      const x = cols.x[i]!;
      const y = cols.y[i]!;
      if (x >= v.x0 && x <= v.x1 && y >= v.y0 && y <= v.y1) k++;
    }
    return k;
  }, [statsOn, version, viewTick, domain]); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedCount = useMemo(() => {
    if (!statsOn) return 0;
    if (selection && (inSelections || selections?.isActive?.())) {
      const c = cols;
      const pts = { x: c.x.subarray(0, c.n), y: c.y.subarray(0, c.n), n: c.n, values: {}, categories: {} };
      const mask = new Uint8Array(c.n);
      if (!resolveSelection(pts, classifyZones(pts, zones), zones.map((z) => z.id), selection, mask)) return 0;
      let k = 0;
      for (let i = 0; i < c.n; i++) if (mask[i]) k++;
      return k;
    }
    const hasSel = (hc?.qDimensionInfo?.[0]?.qStateCounts?.qSelected ?? 0) > 0;
    if (!hasSel) return 0;
    let k = 0;
    for (let i = 0; i < cols.n; i++) k += cols.selected[i]!;
    return k;
  }, [statsOn, version, selection, inSelections, zones]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- zone editor ----------
  const [editorOpen, setEditorOpen] = useState(false);
  const [editorTab, setEditorTab] = useState<"zones" | "shapes">("zones");
  const qId: string | undefined = layout?.qInfo?.qId;
  useEffect(() => {
    if (!qId) return;
    return registerEditor(qId, (tab) => {
      setEditorTab(tab === "shapes" ? "shapes" : "zones");
      setEditorOpen(true);
    });
  }, [qId]);
  // Leaving edit mode closes the editor without saving.
  useEffect(() => {
    if (!editMode) setEditorOpen(false);
  }, [editMode]);

  // Reference lines from the property panel (Add-ons › Reference lines).
  const statLines = useMemo<DensityStatLine[]>(
    () =>
      (Array.isArray(props.statLines) ? props.statLines : []).map((l: any): DensityStatLine => {
        const k = Number(l?.k);
        const custom = typeof l?.labelText === "string" ? l.labelText.trim() : "";
        return {
          value:
            l?.stat === "Median" ? "median" : l?.stat === "Std dev" ? { stddev: Number.isFinite(k) && k > 0 ? k : 1 } : "mean",
          axis: l?.axis === "x" ? "x" : "y",
          by: l?.by === "all" ? "all" : "class",
          span: l?.span === "plot" ? "plot" : "class",
          label: !roomy
            ? "none"
            : l?.labelMode === "none" || l?.labelMode === "value"
              ? l.labelMode
              : l?.labelMode === "custom" && custom
                ? custom
                : "computation",
          style: l?.lineStyle === "solid" || l?.lineStyle === "dashed" || l?.lineStyle === "dotted" ? l.lineStyle : undefined,
        };
      }),
    // Keyed by content: the layout object is new on every engine push.
    [JSON.stringify(props.statLines ?? []), roomy], // eslint-disable-line react-hooks/exhaustive-deps
  );

  if (width < 40 || height < 40) return null;

  if (status) {
    return (
      <div className="qhds-empty" style={{ width, height }}>
        <span>{status}</span>
      </div>
    );
  }

  // Legend title: on by default, like a native chart. Empty text = automatic
  // ("Zone", or the 2nd dimension's title when colouring by dimension).
  const legendTitle =
    props.legendTitleShow === false
      ? undefined
      : String(props.legendTitle ?? "").trim() ||
        (colorBy.kind === "category" ? hc.qDimensionInfo[1]?.qFallbackTitle : undefined) ||
        "Zone";
  const xTitle = hc.qMeasureInfo[0]?.qFallbackTitle;
  const yTitle = hc.qMeasureInfo[1]?.qFallbackTitle;
  const loading = !progress.done && !error;
  const pct = progress.total > 0 ? Math.min(100, Math.round((100 * progress.n) / progress.total)) : null;
  // Loading indicator: the bar along the top edge and/or the "n / total" text.
  const indicator: string = typeof props.loadingIndicator === "string" ? props.loadingIndicator : "both";
  // "animated": the points stay back until every page is in; a loading card
  // (with the same bar / text choice) sits over the empty plot meanwhile.
  const animatedLoading = loading && renderMode === "animated";
  const wantBar = indicator === "bar" || indicator === "both";
  const wantText = indicator === "text" || indicator === "both";
  const showBar = loading && !animatedLoading && wantBar;
  const showText = loading && !animatedLoading && wantText && !tiny;


  // Render mode "Loading animation": while the points load, the animation is
  // all there is — no plot, axes, legend or stats — as large as the object
  // allows at the artwork's 520 × 310 ratio, with the bar / text underneath.
  if (animatedLoading) {
    const below = (wantBar ? 14 : 0) + (wantText ? 22 : 0);
    const robotW = Math.max(60, Math.min(width - 24, ((height - below - 24) * 520) / 310));
    // Fun mode (default on): the robot. Off: a plain loading screen — spinner, bar, text.
    const fun = props.funMode !== false;
    const barW = fun ? robotW : Math.min(320, Math.max(120, width - 48));
    return (
      <div className="qhds-frame" ref={frameRef} style={{ width, height }}>
        <div className="qhds-loader qhds-loader-full" data-plain={fun ? undefined : ""} role="status" aria-live="polite">
          {fun ? (
            <div
              aria-hidden="true"
              className="qhds-loader-robot"
              dangerouslySetInnerHTML={{ __html: pct === null ? ROBOT_FREE : ROBOT_CONTROLLED }}
              style={{ width: robotW, ["--progress" as any]: pct === null ? 0 : pct / 100 }}
            />
          ) : (
            <div aria-hidden="true" className="qhds-loader-spinner" />
          )}
          {wantBar && (
            <div className="qhds-loader-bar" data-indeterminate={pct === null ? "" : undefined} style={{ width: barW }}>
              <i style={pct === null ? undefined : { width: `${pct}%` }} />
            </div>
          )}
          {wantText && !tiny && (
            <span className="qhds-loader-text">
              {progress.total > 0
                ? `Loading ${fmt(progress.n)} of ${fmt(progress.total)} points${pct === null ? "" : ` · ${pct}%`}`
                : "Loading points…"}
            </span>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className="qhds-frame"
      data-edit={editMode ? "" : undefined}
      ref={frameRef}
      style={{ width, height, ["--qhds-h" as any]: `${height}px`, ["--qhds-x-gutter" as any]: `${xGutter}px` }}
    >
      <DensityScatterChart
        accessibleLabel={layout?.title || `${yTitle} by ${xTitle}`}
        data={data}
        zones={colorBy.kind === "zone" ? zones : zones}
        statLines={statLines}
        outside={outside}
        colorBy={colorBy}
        valueKey={colorBy.kind === "value" ? "value" : undefined}
        sizeKey={hasSize ? "size" : undefined}
        sizeRange={sizeRange}
        pointOpacity={Number.isFinite(Number(props.pointOpacity)) ? Number(props.pointOpacity) : 1}
        densityFloor={Number.isFinite(Number(props.densityFloor)) ? Number(props.densityFloor) : 0.55}
        xLabel={xAx.title ? xTitle : undefined}
        yLabel={yAx.title ? yTitle : undefined}
        xAxis={{ labels: xAx.labels, tickSpacing: xAx.spacing }}
        yAxis={{ labels: yAx.labels, tickSpacing: yAx.spacing }}
        formatX={formatX}
        formatY={formatY}
        formatValue={formatter}
        onViewChange={onViewChange}
        pointRadius={Number(props.pointRadius) || 1.35}
        cellSize={Number(props.cellSize) || 5}
        underlay={Number.isFinite(Number(props.underlay)) ? Number(props.underlay) : 4}
        zoom={!passive && props.zoom !== false}
        legend={
          legendOn
            ? {
                interactive: "toggle",
                toggleControl: "checkbox",
                position: legendPos,
                layout: legendPos === "left" || legendPos === "right" ? "stack" : "row",
                title: legendTitle,
              }
            : false
        }
        hiddenKeys={hiddenKeys}
        onHiddenKeysChange={setHiddenKeys}
        onLegendItemClick={onLegendItemClick}
        selection={selection ?? NO_SELECTION}
        onSelectionChange={onSelectionChange}
        selectionGestures={canSelect ? ["range", "lasso"] : undefined}
        onSelectionIntent={canSelect ? () => undefined : undefined}
        selectionToolbar="none"
        selectionTool={lassoActive ? "lasso" : "pointer"}
        onPointClick={canSelect ? onPointClick : undefined}
        onBackgroundClick={canSelect ? onBackgroundClick : undefined}
        describePoint={describePoint}
        showLassoShape={false}
        zoomControlsPlacement="bottom-end"
        plotHeight={plotHeight}
        domain={domain}
        zoneTags={props.showZoneTags !== false && roomy}
        shapeBy={shapeBy}
      />
      {shapeKeyOn && (
        <div aria-label={`Shapes by ${catTitle}`} className="qhds-shapekey" role="group" style={{ height: SHAPE_KEY_H }}>
          {catTitle ? <b>{catTitle}</b> : null}
          {shapeEntries(catLabels!, props.shapes).map((e) => (
            <span key={e.label}>
              <DensityShapeGlyph shape={e.shape} size={10} />
              {e.label}
            </span>
          ))}
        </div>
      )}
      {statsOn && cols.n > 0 && (
        <div
          aria-live="polite"
          className="qhds-stats"
          // Bottom-left inside the plot: the one corner nothing else claims — zone
          // tags hang at a zone's first vertex (upper left), reference-line tags
          // prefer the right end, the minimap and zoom buttons take the bottom-right.
          style={{
            left: 64 + (legendOn && legendPos === "left" ? legendW : 0),
            bottom: 6 + xGutter + (legendOn && legendPos === "bottom" ? legendH : 0) + shapeKeyH,
          }}
        >
          <span>On surface</span>
          <b>{fmt(cols.n)}</b>
          <span>Visible</span>
          <b>{fmt(visibleCount)}</b>
          <span>Selected</span>
          <b>{fmt(selectedCount)}</b>
        </div>
      )}
      {showBar && (
        <div
          aria-label="Loading points"
          aria-valuemax={100}
          aria-valuemin={0}
          aria-valuenow={pct ?? undefined}
          className="qhds-progress"
          data-indeterminate={pct === null ? "" : undefined}
          role="progressbar"
        >
          <i style={pct === null ? undefined : { width: `${pct}%` }} />
        </div>
      )}
      {(showText || (editMode && issues.length > 0)) && (
        <div className="qhds-status" aria-live="polite">
          {showText && (
            <span>
              Loading {fmt(progress.n)} / {fmt(progress.total)} points{pct === null ? "" : ` · ${pct}%`}
            </span>
          )}
          {(editMode ? issues : []).map((i) => (
            <span key={i.zone + i.message} className="qhds-warn">
              {i.zone}: {i.message}
            </span>
          ))}
        </div>
      )}
      {editorOpen ? (
        <ZoneEditor
          app={app}
          data={data}
          domain={domain}
          layout={layout}
          model={model}
          onClose={() => setEditorOpen(false)}
          theme={theme}
          totalPoints={cols.n}
          initialTab={editorTab}
          catLabels={catLabels ?? []}
          catTitle={catTitle}
          shapeBy={shapeBy}
          xTitle={xTitle}
          yTitle={yTitle}
        />
      ) : null}
      {hc.qSize.qcy > (Number(props.maxPoints) || 1_000_000) && cols.done && (
        <div className="qhds-status">
          <span className="qhds-warn">
            Showing {fmt(cols.total)} of {fmt(hc.qSize.qcy)} rows (max points in Add-ons › Data handling)
          </span>
        </div>
      )}
    </div>
  );
}
