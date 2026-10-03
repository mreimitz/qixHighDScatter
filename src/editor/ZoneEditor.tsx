/**
 * The zone editor modal. Opens over the sheet (portal into document.body, inside
 * its own `.qhds` root so the scoped CSS applies), edits a DRAFT of props.zones
 * and writes it back with ONE `applyPatches` on Apply. Preview = the same
 * DensityScatterChart on the points the chart already holds, with the editing
 * layer mounted through the chart's `renderOverlay` seam.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as RKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  DensityScatterChart,
  DensityShapeGlyph,
  classifyZones,
  countClasses,
  dealShapes,
  type DensityPointShape,
  type DensityShapeBy,
  type DensityView,
} from "@elabs-ai/components-charts";
import { ALL_SHAPES, SHAPE_LABEL, readShapes, type ShapeMapEntry } from "../shapes";
import { quadrantId, toDensityZones } from "../zones";
import type { QhdsTheme } from "../theme";
import { localeMarks, makeAxisFormatter, parseQlikColor } from "../format";
import { EditorOverlay, type DrawResult, type Tool } from "./EditorOverlay";
import { createEvaluator } from "./evaluator";
import {
  QUADRANT_NAMES,
  ZONE_KINDS,
  blankShapeFields,
  boundsOf,
  convertKind,
  draftsToEvaluated,
  fromDrafts,
  newKey,
  parseCell,
  toDrafts,
  validate,
  type DraftZone,
  type Num,
  type Pt,
  type ZoneKind,
} from "./model";

export interface ZoneEditorProps {
  model: any;
  app: any;
  layout: any;
  theme: QhdsTheme;
  data: { x: Float32Array; y: Float32Array };
  domain?: DensityView;
  xTitle?: string;
  yTitle?: string;
  totalPoints: number;
  onClose: () => void;
  /** Which view opens first: the zones or the Shapes tab. */
  initialTab?: "zones" | "shapes";
  /** The 2nd dimension's distinct values (first-seen order) and title — the Shapes tab's rows. */
  catLabels?: readonly string[];
  catTitle?: string;
  /** What the live chart currently draws with, so the preview starts identical. */
  shapeBy?: DensityShapeBy;
}

const KIND_LABEL: Record<ZoneKind, string> = {
  band: "Band",
  rect: "Rectangle",
  envelope: "Envelope",
  line: "Line",
  polygon: "Polygon",
  circle: "Circle",
  quadrant: "Quadrants",
};
const KIND_HELP: Record<ZoneKind, string> = {
  band: "Y min – Y max across all X",
  rect: "X and Y min – max",
  envelope: "Upper and lower edge that change with X",
  line: "Everything above or below a line",
  polygon: "Any closed shape, point by point",
  circle: "A circle or ellipse: centre and radius",
  quadrant: "Four areas split by one X and one Y line",
};
const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 2 });
const fmt = (v: number | null) =>
  v === null || !Number.isFinite(v) ? "—" : nf.format(v);

function Icon({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg
      aria-hidden="true"
      fill="none"
      height={size}
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
      width={size}
    >
      <path d={d} />
    </svg>
  );
}
/** Covers: the shaded region is what the zone owns (inside vs everything beyond). */
function CoverIcon({ outside }: { outside: boolean }) {
  return (
    <svg aria-hidden="true" height={18} viewBox="0 0 24 24" width={18}>
      {outside ? (
        <rect
          fill="currentColor"
          height={18}
          opacity={0.35}
          rx={2}
          width={20}
          x={2}
          y={3}
        />
      ) : null}
      <path
        d="M6 9l6-3 6 3v6l-6 3-6-3z"
        fill={outside ? "var(--card, #fff)" : "currentColor"}
        opacity={outside ? 1 : 0.45}
        stroke="currentColor"
        strokeWidth={1.6}
      />
    </svg>
  );
}
const ICONS = {
  undo: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  redo: "m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13",
  close: "M6 6l12 12M18 6 6 18",
  select: "m4 3 7 17 2.5-7.5L21 10z",
  band: "M2 8h20M2 16h20",
  rect: "M4 6h16v12H4z",
  envelope: "M2 5l8 5h12M2 19l8-5h12",
  line: "M2 17l7-6 5 3 8-8M4 21h.01M9 21h.01M14 21h.01M19 21h.01",
  polygon: "M5 7 12 3l7 5-2 10H7z",
  circle: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18",
  quadrant: "M3 3h18v18H3zM12 3v18M3 12h18",
  eye: "M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6",
  eyeOff:
    "M3 3l18 18M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4M6.1 6.1C3.6 7.8 2 12 2 12s3.6 7 10 7a9.6 9.6 0 0 0 4.3-1",
  plus: "M12 5v14M5 12h14",
  up: "m6 15 6-6 6 6",
  down: "m6 9 6 6 6-6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3",
  copy: "M8 8h12v12H8zM4 16V4h12",
  check: "m5 12 5 5L20 7",
};

/** One coordinate cell: a number or `=expression`, with the evaluated value beside it. */
function CoordInput({
  label,
  value,
  onCommit,
  testId,
  placeholder,
}: {
  label: string;
  value: Num;
  onCommit: (n: Num) => void;
  testId?: string;
  /** Set: the cell may be left empty (= no value). */
  placeholder?: string;
}) {
  const shown = value.expr ?? (value.v === null ? "" : String(value.v));
  const [text, setText] = useState(shown);
  const [focus, setFocus] = useState(false);
  useEffect(() => {
    if (!focus) setText(shown);
  }, [shown, focus]);
  const commit = () => {
    const next = parseCell(text, value, placeholder !== undefined);
    if (next.expr !== value.expr || next.v !== value.v) onCommit(next);
  };
  return (
    <label className="qhds-ze-coord">
      <span className="qhds-ze-sr">{label}</span>
      <input
        aria-label={label}
        className={value.expr ? "is-expr" : undefined}
        data-testid={testId}
        onBlur={() => {
          setFocus(false);
          commit();
        }}
        onChange={(e) => setText(e.target.value)}
        onFocus={() => setFocus(true)}
        placeholder={placeholder}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") {
            e.stopPropagation();
            setText(shown);
            (e.target as HTMLInputElement).blur();
          }
        }}
        spellCheck={false}
        value={text}
      />
      {value.expr ? (
        <span className="qhds-ze-eval" title="Evaluated value">
          = {fmt(value.v)}
        </span>
      ) : null}
    </label>
  );
}

function PointTable({
  title,
  list,
  min,
  onChange,
  prefix,
}: {
  title: string;
  list: Pt[];
  min: number;
  onChange: (list: Pt[]) => void;
  prefix: string;
}) {
  const set = (i: number, axis: "x" | "y", n: Num) =>
    onChange(list.map((p, k) => (k === i ? { ...p, [axis]: n } : p)));
  const add = () => {
    const last = list[list.length - 1];
    const prev = list[list.length - 2];
    const step =
      last && prev && last.x.v !== null && prev.x.v !== null
        ? last.x.v - prev.x.v || 1
        : 1;
    onChange([
      ...list,
      {
        x: { v: last?.x.v !== null && last ? last.x.v! + step : 0 },
        y: { v: last?.y.v ?? 0 },
      },
    ]);
  };
  return (
    <div className="qhds-ze-group">
      <div className="qhds-ze-group-head">
        <span className="qhds-ze-h">{title}</span>
        <span className="qhds-ze-muted">{list.length} points</span>
      </div>
      <div className="qhds-ze-table" role="table" aria-label={title}>
        <div className="qhds-ze-tr qhds-ze-th" role="row">
          <span role="columnheader">#</span>
          <span role="columnheader">X</span>
          <span role="columnheader">Y</span>
          <span role="columnheader" className="qhds-ze-sr">
            Remove
          </span>
        </div>
        {list.map((p, i) => (
          <div className="qhds-ze-tr" key={i} role="row">
            <span className="qhds-ze-muted" role="cell">
              {i + 1}
            </span>
            <span role="cell">
              <CoordInput
                label={`${title} point ${i + 1} X`}
                onCommit={(n) => set(i, "x", n)}
                testId={`${prefix}-${i}-x`}
                value={p.x}
              />
            </span>
            <span role="cell">
              <CoordInput
                label={`${title} point ${i + 1} Y`}
                onCommit={(n) => set(i, "y", n)}
                testId={`${prefix}-${i}-y`}
                value={p.y}
              />
            </span>
            <span role="cell">
              <button
                aria-label={`Remove point ${i + 1}`}
                className="qhds-ze-icon-btn"
                disabled={list.length <= min}
                onClick={() => onChange(list.filter((_, k) => k !== i))}
                type="button"
              >
                <Icon d={ICONS.close} size={12} />
              </button>
            </span>
          </div>
        ))}
      </div>
      <button className="qhds-ze-link" onClick={add} type="button">
        + Add point
      </button>
    </div>
  );
}

export function ZoneEditor({
  model,
  app,
  layout,
  theme,
  data,
  domain,
  xTitle,
  yTitle,
  totalPoints,
  onClose,
  initialTab = "zones",
  catLabels = [],
  catTitle = "",
}: ZoneEditorProps) {
  const [loaded, setLoaded] = useState(false);
  // "zones" shows the Properties / Data model views (by `source`); "shapes" the Shapes tab.
  const [tab, setTab] = useState<"zones" | "shapes">(initialTab);
  // Draft of props.shapes: on/off + the explicit value → glyph assignments.
  const [shapesDraft, setShapesDraft] = useState<{ enabled: boolean; map: Record<string, DensityPointShape> }>({
    enabled: false,
    map: {},
  });
  const shapesInitial = useRef<string>("");
  const shapesJson = JSON.stringify(shapesDraft);
  const shapesDirty = loaded && shapesJson !== shapesInitial.current;
  const [drafts, setDrafts] = useState<DraftZone[]>([]);
  const [past, setPast] = useState<DraftZone[][]>([]);
  const [future, setFuture] = useState<DraftZone[][]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  // The preview fills its pane (no dead space under the plot).
  const [previewH, setPreviewH] = useState(300);
  const previewObs = useRef<ResizeObserver | null>(null);
  const previewRef = useCallback((el: HTMLDivElement | null) => {
    previewObs.current?.disconnect();
    previewObs.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() =>
      setPreviewH(Math.max(240, Math.floor(el.clientHeight - 14))),
    );
    ro.observe(el);
    previewObs.current = ro;
  }, []);
  const [snap, setSnap] = useState(true);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const [hover, setHover] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [source, setSource] = useState<"props" | "data">(
    layout?.props?.zoneSource === "data" ? "data" : "props",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<DensityView | undefined>(undefined);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Hint bubbles for [data-tip] controls: fixed-position, so no scroll box or
  // overflow clips them (a CSS ::after bubble was cut off by the inspector).
  const [tip, setTip] = useState<{
    text: string;
    x: number;
    y: number;
    above: boolean;
  } | null>(null);
  const showTip = (target: EventTarget | null) => {
    const el = (target as HTMLElement | null)?.closest?.(
      "[data-tip]",
    ) as HTMLElement | null;
    if (!el) return setTip(null);
    const r = el.getBoundingClientRect();
    const above = r.bottom + 40 > window.innerHeight;
    setTip({
      text: el.getAttribute("data-tip") ?? "",
      x: r.left + r.width / 2,
      y: above ? r.top - 6 : r.bottom + 6,
      above,
    });
  };
  const evaluator = useMemo(() => createEvaluator(app), [app]);
  useEffect(() => () => evaluator.dispose(), [evaluator]);

  // ---------- load: raw properties (expressions intact) + evaluated layout ----------
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const props = await model.getProperties();
        if (!alive) return;
        const d = toDrafts(props?.props?.zones, layout?.props?.zones);
        setDrafts(d);
        setSelected(d[0]?.key ?? null);
        const sh = readShapes(props?.props?.shapes ?? layout?.props?.shapes);
        const draft = { enabled: sh.enabled, map: Object.fromEntries(sh.map.map((e) => [e.value, e.shape])) };
        shapesInitial.current = JSON.stringify(draft);
        setShapesDraft(draft);
      } catch (e) {
        setError(String((e as any)?.message ?? e));
      } finally {
        if (alive) setLoaded(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [model]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- focus handling ----------
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => prev?.focus?.();
  }, []);

  // ---------- history ----------
  const commit = useCallback(
    (next: DraftZone[]) => {
      setPast((p) => [...p.slice(-99), drafts]);
      setFuture([]);
      setDrafts(next);
    },
    [drafts],
  );
  const undo = () => {
    if (!past.length) return;
    setFuture((f) => [drafts, ...f]);
    setDrafts(past[past.length - 1]!);
    setPast((p) => p.slice(0, -1));
  };
  const redo = () => {
    if (!future.length) return;
    setPast((p) => [...p, drafts]);
    setDrafts(future[0]!);
    setFuture((f) => f.slice(1));
  };
  const updateZone = (z: DraftZone, record = true) => {
    const next = drafts.map((d) => (d.key === z.key ? z : d));
    if (record) commit(next);
    else setDrafts(next);
  };
  // live overlay drags: first transient change records the pre-drag state once
  const dragStart = useRef<DraftZone[] | null>(null);
  const onOverlayChange = (z: DraftZone, done: boolean) => {
    if (!done) {
      dragStart.current ??= drafts;
      setDrafts((ds) => ds.map((d) => (d.key === z.key ? z : d)));
      return;
    }
    const before = dragStart.current ?? drafts;
    dragStart.current = null;
    setPast((p) => [...p.slice(-99), before]);
    setFuture([]);
    setDrafts((ds) => ds.map((d) => (d.key === z.key ? z : d)));
  };

  // ---------- expressions → engine values ----------
  const exprKey = useMemo(() => {
    const list: string[] = [];
    const push = (n: Num) => n.expr && list.push(n.expr);
    for (const d of drafts) {
      [
        d.yMin,
        d.yMax,
        d.xMin,
        d.xMax,
        d.cx,
        d.cy,
        d.rx,
        d.ry,
        d.xSplit,
        d.ySplit,
      ].forEach(push);
      [...d.upper, ...d.lower, ...d.points, ...d.line].forEach(
        (p) => (push(p.x), push(p.y)),
      );
    }
    return JSON.stringify([...new Set(list)].sort());
  }, [drafts]);
  useEffect(() => {
    const exprs = JSON.parse(exprKey) as string[];
    if (!exprs.length) return;
    const t = setTimeout(async () => {
      try {
        const values = await evaluator.evaluate(exprs);
        const fix = (n: Num): Num =>
          n.expr && n.expr in values ? { ...n, v: values[n.expr] ?? null } : n;
        const fixPts = (l: Pt[]) =>
          l.map((p) => ({ x: fix(p.x), y: fix(p.y) }));
        setDrafts((ds) =>
          ds.map((d) => ({
            ...d,
            yMin: fix(d.yMin),
            yMax: fix(d.yMax),
            xMin: fix(d.xMin),
            xMax: fix(d.xMax),
            cx: fix(d.cx),
            cy: fix(d.cy),
            rx: fix(d.rx),
            ry: fix(d.ry),
            xSplit: fix(d.xSplit),
            ySplit: fix(d.ySplit),
            upper: fixPts(d.upper),
            lower: fixPts(d.lower),
            points: fixPts(d.points),
            line: fixPts(d.line),
          })),
        );
      } catch {
        /* keep last values */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [exprKey, evaluator]);

  // Colour expressions → their text results (for the preview).
  const colorExprKey = useMemo(
    () =>
      JSON.stringify(
        [
          ...new Set(
            drafts
              .filter(
                (d) => d.colorByExpr && d.colorExpr.trim().startsWith("="),
              )
              .map((d) => d.colorExpr.trim()),
          ),
        ].sort(),
      ),
    [drafts],
  );
  useEffect(() => {
    const exprs = JSON.parse(colorExprKey) as string[];
    if (!exprs.length) return;
    const t = setTimeout(async () => {
      try {
        const values = await evaluator.evaluateText(exprs);
        setDrafts((ds) =>
          ds.map((d) =>
            d.colorByExpr && d.colorExpr.trim() in values
              ? { ...d, colorExprValue: values[d.colorExpr.trim()] ?? null }
              : d,
          ),
        );
      } catch {
        /* keep last values */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [colorExprKey, evaluator]);

  // ---------- derived ----------
  const evaluated = useMemo(() => draftsToEvaluated(drafts), [drafts]);
  const { zones } = useMemo(
    () => toDensityZones(evaluated, theme.resolveColor, domain),
    [evaluated, theme, domain],
  );
  const shares = useMemo(() => {
    const n = data.x.length;
    if (!n || !zones.length) return new Map<string, number>();
    const cls = classifyZones(
      { x: data.x, y: data.y, n, values: {}, categories: {} },
      zones,
    );
    const counts = countClasses(cls, zones.length + 1);
    const m = new Map<string, number>();
    zones.forEach((z, i) => m.set(z.id, counts[i]! / n));
    m.set("__outside", counts[zones.length]! / n);
    // A quadrant zone is 4 chart zones: its row shows their sum.
    for (const d of drafts) {
      if (d.kind !== "quadrant") continue;
      let sum = 0;
      let any = false;
      for (let q = 0; q < 4; q++) {
        const v = m.get(quadrantId(d.key, q));
        if (v !== undefined) ((sum += v), (any = true));
      }
      if (any) m.set(d.key, sum);
    }
    return m;
  }, [data, zones, drafts]);
  // Hiding a quadrant zone hides its 4 parts.
  const hiddenIds = useMemo(() => {
    const out = new Set<string>();
    for (const k of hidden) {
      const d = drafts.find((z) => z.key === k);
      if (d?.kind === "quadrant")
        for (let q = 0; q < 4; q++) out.add(quadrantId(k, q));
      else out.add(k);
    }
    return out;
  }, [hidden, drafts]);
  const current = drafts.find((d) => d.key === selected) ?? null;
  const issues = drafts
    .map((d) => ({ d, msg: validate(d) }))
    .filter((x) => x.msg);
  const exprCount = (JSON.parse(exprKey) as string[]).length;
  const home: DensityView | undefined = domain;
  const extent = home ?? { x0: 0, x1: 1, y0: 0, y1: 1 };

  const quadColor = (d: DraftZone, i: number, q: number) =>
    theme.resolveColor(d.quads[q]?.color, i + q);
  const colorOf = (d: DraftZone, i: number) =>
    d.kind === "quadrant"
      ? quadColor(d, i, 0)
      : ((d.colorByExpr
          ? parseQlikColor(
              d.colorExpr.trim().startsWith("=")
                ? d.colorExprValue
                : d.colorExpr,
            )
          : null) ?? theme.resolveColor(d.color, i));
  const swatchOf = (d: DraftZone, i: number) =>
    d.kind === "quadrant"
      ? `conic-gradient(${quadColor(d, i, 1)} 0 25%, ${quadColor(d, i, 3)} 0 50%, ${quadColor(d, i, 2)} 0 75%, ${quadColor(d, i, 0)} 0)`
      : colorOf(d, i);
  // Same axis numbers as the chart (Qlik abbreviations, the measure's format).
  const marks = useMemo(
    () => localeMarks(layout?.qLocaleInfo),
    [layout?.qLocaleInfo],
  );
  const vx = view ? view.x1 - view.x0 : extent.x1 - extent.x0;
  const vy = view ? view.y1 - view.y0 : extent.y1 - extent.y0;
  const qx = Math.round(Math.log10(Math.max(vx, 1e-300)) * 4);
  const qy = Math.round(Math.log10(Math.max(vy, 1e-300)) * 4);
  const fmtX = useMemo(
    () =>
      makeAxisFormatter(layout?.qHyperCube?.qMeasureInfo?.[0], marks, vx, 7),
    [marks, qx],
  );
  const fmtY = useMemo(
    () =>
      makeAxisFormatter(layout?.qHyperCube?.qMeasureInfo?.[1], marks, vy, 7),
    [marks, qy],
  );

  // ---------- zone operations ----------
  const addZone = (res: DrawResult) => {
    const idx = drafts.length;
    const n = (v: number | undefined): Num => ({ v: v ?? null });
    const base: DraftZone = {
      ...blankShapeFields(),
      key: newKey(),
      label: `Zone ${idx + 1}`,
      showRaw: true,
      kind: res.kind,
      cover: "inside",
      color: {
        index: -1,
        color: theme.palette[idx % theme.palette.length] ?? "#4477aa",
      },
      colorByExpr: false,
      colorExpr: "",
      yMin: n(res.y0),
      yMax: n(res.y1),
      xMin: n(res.x0),
      xMax: n(res.x1),
      // A drawn envelope is an outline around the region: both edges explicit.
      mirror: false,
      upper:
        res.kind === "envelope"
          ? (res.pts ?? []).map(([x, y]) => ({ x: { v: x }, y: { v: y } }))
          : [],
      lower:
        res.kind === "envelope"
          ? (res.lower ?? []).map(([x, y]) => ({ x: { v: x }, y: { v: y } }))
          : [],
      points:
        res.kind === "polygon"
          ? (res.pts ?? []).map(([x, y]) => ({ x: { v: x }, y: { v: y } }))
          : [],
      line:
        res.kind === "line"
          ? (res.pts ?? []).map(([x, y]) => ({ x: { v: x }, y: { v: y } }))
          : [],
      side: "above",
      extendStart: res.kind === "line",
      extendEnd: res.kind === "line",
    };
    if (res.kind === "circle") {
      base.cx = n(res.cx);
      base.cy = n(res.cy);
      base.rx = n(res.rx);
      base.ry = n(res.ry);
    }
    if (res.kind === "quadrant") {
      base.xSplit = n(res.cx);
      base.ySplit = n(res.cy);
      base.label = `Quadrants ${idx + 1}`;
      base.quads = QUADRANT_NAMES.map((label, q) => ({
        label,
        color: {
          index: -1,
          color: theme.palette[(idx + q) % theme.palette.length] ?? null,
        },
      }));
    }
    commit([...drafts, base]);
    setSelected(base.key);
    setTool("select");
  };
  const removeZone = (key: string) => {
    const i = drafts.findIndex((d) => d.key === key);
    const next = drafts.filter((d) => d.key !== key);
    commit(next);
    setSelected(next[Math.min(i, next.length - 1)]?.key ?? null);
  };
  const duplicate = (key: string) => {
    const d = drafts.find((z) => z.key === key);
    if (!d) return;
    const copy: DraftZone = JSON.parse(JSON.stringify(d));
    copy.key = newKey();
    copy.label = `${d.label} copy`;
    const i = drafts.findIndex((z) => z.key === key);
    const next = [...drafts];
    next.splice(i + 1, 0, copy);
    commit(next);
    setSelected(copy.key);
  };
  const move = (key: string, delta: number) => {
    const i = drafts.findIndex((d) => d.key === key);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= drafts.length) return;
    const next = [...drafts];
    [next[i], next[j]] = [next[j]!, next[i]!];
    commit(next);
  };
  const dragKey = useRef<string | null>(null);

  // ---------- apply ----------
  const dirty =
    past.length > 0 ||
    shapesDirty ||
    source !== (layout?.props?.zoneSource === "data" ? "data" : "props");
  const apply = async () => {
    setSaving(true);
    setError(null);
    try {
      const patches: any[] = [
        {
          qOp: "replace",
          qPath: "/props/zones",
          qValue: JSON.stringify(fromDrafts(drafts)),
        },
      ];
      patches.push({
        qOp: "replace",
        qPath: "/props/zoneSource",
        qValue: JSON.stringify(source),
      });
      if (shapesDirty) {
        const map: ShapeMapEntry[] = Object.entries(shapesDraft.map).map(([value, shape]) => ({ value, shape }));
        patches.push({
          qOp: "replace",
          qPath: "/props/shapes",
          qValue: JSON.stringify({ enabled: shapesDraft.enabled, map }),
        });
      }
      await model.applyPatches(patches, false);
      onClose();
    } catch (e) {
      setError(`Could not save: ${String((e as any)?.message ?? e)}`);
      setSaving(false);
    }
  };

  // ---------- keyboard ----------
  const onKeyDown = (e: RKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const typing = target.tagName === "INPUT" || target.tagName === "TEXTAREA";
    if (e.key === "Escape" && !typing) {
      e.preventDefault();
      if (menu) setMenu(false);
      else if (tool !== "select") setTool("select");
      else onClose();
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "z" && !typing) {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    }
    // simple focus trap
    if (e.key === "Tab" && dialogRef.current) {
      const f = [
        ...dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not([disabled]), input, select, [tabindex='0']",
        ),
      ];
      if (!f.length) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  // ---------- inspector ----------
  const inspector = current ? (
    <div className="qhds-ze-inspector" data-testid="ze-inspector">
      <label className="qhds-ze-field">
        <span>Label</span>
        <input
          data-testid="ze-label"
          onBlur={(e) =>
            e.target.value !== current.label &&
            updateZone({
              ...current,
              label: e.target.value,
              labelRaw: undefined,
            })
          }
          defaultValue={current.label}
          key={current.key + current.label}
          onKeyDown={(e) =>
            e.key === "Enter" && (e.target as HTMLInputElement).blur()
          }
        />
      </label>
      <div className="qhds-ze-field">
        <span>Type</span>
        <div
          aria-label="Zone type"
          className="qhds-ze-seg qhds-ze-iconseg"
          role="radiogroup"
        >
          {ZONE_KINDS.map((k) => (
            <button
              aria-checked={current.kind === k}
              aria-label={KIND_LABEL[k]}
              className="qhds-ze-tip"
              data-testid={`ze-kind-${k}`}
              data-tip={`${KIND_LABEL[k]} — ${KIND_HELP[k]}`}
              key={k}
              onClick={() =>
                updateZone(
                  convertKind(
                    current,
                    k,
                    boundsOf(current) ?? {
                      x0: extent.x0,
                      x1: extent.x1,
                      y0: extent.y0,
                      y1: extent.y1,
                    },
                  ),
                )
              }
              role="radio"
              type="button"
            >
              <Icon d={ICONS[k]} size={18} />
            </button>
          ))}
        </div>
      </div>
      {current.kind !== "quadrant" ? (
        <>
          <div className="qhds-ze-field">
            <span>Covers</span>
            <div
              aria-label="Zone covers"
              className="qhds-ze-seg qhds-ze-iconseg"
              role="radiogroup"
            >
              <button
                aria-checked={current.cover === "inside"}
                aria-label="Inside the shape"
                className="qhds-ze-tip"
                data-testid="ze-cover-inside"
                data-tip="Inside — the points in the shape"
                onClick={() => updateZone({ ...current, cover: "inside" })}
                role="radio"
                type="button"
              >
                <CoverIcon outside={false} />
              </button>
              <button
                aria-checked={current.cover === "outside"}
                aria-label="Outside the shape"
                className="qhds-ze-tip"
                data-testid="ze-cover-outside"
                data-tip="Outside — everything beyond the shape"
                onClick={() => updateZone({ ...current, cover: "outside" })}
                role="radio"
                type="button"
              >
                <CoverIcon outside />
              </button>
            </div>
          </div>
          <div className="qhds-ze-field">
            <span className="qhds-ze-row">
              Color
              <span
                aria-label="Color source"
                className="qhds-ze-seg qhds-ze-mini"
                role="radiogroup"
              >
                <button
                  aria-checked={!current.colorByExpr}
                  data-testid="ze-color-fixed"
                  onClick={() => updateZone({ ...current, colorByExpr: false })}
                  role="radio"
                  type="button"
                >
                  Fixed
                </button>
                <button
                  aria-checked={current.colorByExpr}
                  className="qhds-ze-tip"
                  data-testid="ze-color-expr"
                  data-tip="A Qlik expression: RGB(), ARGB(), hex, or a colour name"
                  onClick={() => updateZone({ ...current, colorByExpr: true })}
                  role="radio"
                  type="button"
                >
                  ƒx
                </button>
              </span>
            </span>
            {current.colorByExpr ? (
              <div className="qhds-ze-colorexpr">
                <input
                  aria-label="Color expression"
                  data-testid="ze-color-expr-input"
                  defaultValue={current.colorExpr}
                  key={current.key + "-cx"}
                  onBlur={(e) =>
                    e.target.value !== current.colorExpr &&
                    updateZone({
                      ...current,
                      colorExpr: e.target.value,
                      colorExprValue: null,
                    })
                  }
                  onKeyDown={(e) =>
                    e.key === "Enter" && (e.target as HTMLInputElement).blur()
                  }
                  placeholder="=If(Avg([Risk]) > 5, RGB(200,40,40), '#4477aa')"
                  spellCheck={false}
                />
                <span className="qhds-ze-muted">
                  {(() => {
                    const shown = current.colorExpr.trim().startsWith("=")
                      ? current.colorExprValue
                      : current.colorExpr;
                    const css = parseQlikColor(shown);
                    return css ? (
                      <>
                        <i
                          className="qhds-ze-dot"
                          style={{ background: css }}
                        />{" "}
                        {shown}
                      </>
                    ) : shown ? (
                      `“${shown}” is not a colour — the fixed colour is used`
                    ) : (
                      "Evaluated in the app; the fixed colour is the fallback"
                    );
                  })()}
                </span>
              </div>
            ) : null}
            <div className="qhds-ze-swatches" hidden={current.colorByExpr}>
              {theme.palette.slice(0, 10).map((c, i) => {
                const on =
                  (current.color.color ?? "").toLowerCase() === c.toLowerCase();
                return (
                  <button
                    aria-label={`Color ${i + 1} ${c}`}
                    aria-pressed={on}
                    className="qhds-ze-swatch"
                    key={c + i}
                    onClick={() =>
                      updateZone({ ...current, color: { index: -1, color: c } })
                    }
                    style={{ background: c }}
                    type="button"
                  />
                );
              })}
              <input
                aria-label="Custom color"
                className="qhds-ze-colorin"
                onChange={(e) =>
                  updateZone(
                    { ...current, color: { index: -1, color: e.target.value } },
                    false,
                  )
                }
                onBlur={(e) =>
                  updateZone({
                    ...current,
                    color: { index: -1, color: e.target.value },
                  })
                }
                type="color"
                value={
                  /^#[0-9a-f]{6}$/i.test(current.color.color ?? "")
                    ? current.color.color!
                    : "#4477aa"
                }
              />
            </div>
          </div>
        </>
      ) : null}
      {current.kind === "band" || current.kind === "rect" ? (
        <div className="qhds-ze-group">
          {current.kind === "rect" ? (
            <>
              <span className="qhds-ze-h">X</span>
              <div className="qhds-ze-pair">
                <div>
                  <span className="qhds-ze-muted">Min</span>
                  {current.extendStart ? (
                    <span className="qhds-ze-endless">−∞ (endless)</span>
                  ) : (
                    <CoordInput
                      label="X min"
                      onCommit={(n) => updateZone({ ...current, xMin: n })}
                      testId="ze-xMin"
                      value={current.xMin}
                    />
                  )}
                </div>
                <div>
                  <span className="qhds-ze-muted">Max</span>
                  {current.extendEnd ? (
                    <span className="qhds-ze-endless">+∞ (endless)</span>
                  ) : (
                    <CoordInput
                      label="X max"
                      onCommit={(n) => updateZone({ ...current, xMax: n })}
                      testId="ze-xMax"
                      value={current.xMax}
                    />
                  )}
                </div>
              </div>
            </>
          ) : null}
          <span className="qhds-ze-h">Y</span>
          <div className="qhds-ze-pair">
            <div>
              <span className="qhds-ze-muted">Min</span>
              <CoordInput
                label="Y min"
                onCommit={(n) => updateZone({ ...current, yMin: n })}
                testId="ze-yMin"
                value={current.yMin}
              />
            </div>
            <div>
              <span className="qhds-ze-muted">Max</span>
              <CoordInput
                label="Y max"
                onCommit={(n) => updateZone({ ...current, yMax: n })}
                testId="ze-yMax"
                value={current.yMax}
              />
            </div>
          </div>
        </div>
      ) : null}
      {current.kind === "envelope" ? (
        <>
          <PointTable
            list={current.upper}
            min={2}
            onChange={(l) => updateZone({ ...current, upper: l })}
            prefix="ze-upper"
            title="Upper edge"
          />
          <label className="qhds-ze-switch">
            <span>Lower edge mirrors upper (−y)</span>
            <input
              checked={current.mirror}
              onChange={(e) =>
                updateZone({
                  ...current,
                  mirror: e.target.checked,
                  lower:
                    !e.target.checked && current.lower.length < 2
                      ? current.upper.map((p) => ({
                          x: { ...p.x },
                          y: { v: p.y.v === null ? null : -p.y.v },
                        }))
                      : current.lower,
                })
              }
              role="switch"
              type="checkbox"
            />
          </label>
          {!current.mirror ? (
            <PointTable
              list={current.lower}
              min={2}
              onChange={(l) => updateZone({ ...current, lower: l })}
              prefix="ze-lower"
              title="Lower edge"
            />
          ) : null}
        </>
      ) : null}
      {current.kind === "line" ? (
        <>
          <PointTable
            list={current.line}
            min={2}
            onChange={(l) => updateZone({ ...current, line: l })}
            prefix="ze-line"
            title="Line"
          />
          <div className="qhds-ze-field">
            <span>Covers the side</span>
            <div
              aria-label="Side"
              className="qhds-ze-seg qhds-ze-seg-2"
              role="radiogroup"
            >
              <button
                aria-checked={current.side === "above"}
                data-testid="ze-side-above"
                onClick={() => updateZone({ ...current, side: "above" })}
                role="radio"
                type="button"
              >
                Above the line
              </button>
              <button
                aria-checked={current.side === "below"}
                data-testid="ze-side-below"
                onClick={() => updateZone({ ...current, side: "below" })}
                role="radio"
                type="button"
              >
                Below the line
              </button>
            </div>
          </div>
        </>
      ) : null}
      {current.kind === "rect" ||
      current.kind === "envelope" ||
      current.kind === "line" ? (
        <div className="qhds-ze-pair">
          {(["extendStart", "extendEnd"] as const).map((k) => (
            <div className="qhds-ze-field" key={k}>
              <span>{k === "extendStart" ? "Left end" : "Right end"}</span>
              <div
                aria-label={k === "extendStart" ? "Left end" : "Right end"}
                className="qhds-ze-seg qhds-ze-seg-2"
                role="radiogroup"
              >
                <button
                  aria-checked={!current[k]}
                  data-testid={`ze-${k}-closed`}
                  onClick={() => updateZone({ ...current, [k]: false })}
                  role="radio"
                  type="button"
                >
                  Closed
                </button>
                <button
                  aria-checked={current[k]}
                  data-testid={`ze-${k}-open`}
                  onClick={() => updateZone({ ...current, [k]: true })}
                  role="radio"
                  type="button"
                >
                  Endless
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
      {current.kind === "circle" ? (
        <div className="qhds-ze-group">
          <span className="qhds-ze-h">Centre</span>
          <div className="qhds-ze-pair">
            <div>
              <span className="qhds-ze-muted">X</span>
              <CoordInput
                label="Centre X"
                onCommit={(n) => updateZone({ ...current, cx: n })}
                testId="ze-cx"
                value={current.cx}
              />
            </div>
            <div>
              <span className="qhds-ze-muted">Y</span>
              <CoordInput
                label="Centre Y"
                onCommit={(n) => updateZone({ ...current, cy: n })}
                testId="ze-cy"
                value={current.cy}
              />
            </div>
          </div>
          <span className="qhds-ze-h">Radius</span>
          <div className="qhds-ze-pair">
            <div>
              <span className="qhds-ze-muted">along X</span>
              <CoordInput
                label="Radius along X"
                onCommit={(n) => updateZone({ ...current, rx: n })}
                testId="ze-rx"
                value={current.rx}
              />
            </div>
            <div>
              <span className="qhds-ze-muted">along Y</span>
              <CoordInput
                label="Radius along Y"
                onCommit={(n) => updateZone({ ...current, ry: n })}
                testId="ze-ry"
                value={current.ry}
              />
            </div>
          </div>
          <span className="qhds-ze-muted">
            In data units — different radii make an ellipse.
          </span>
        </div>
      ) : null}
      {current.kind === "quadrant" ? (
        <>
          <div className="qhds-ze-group">
            <span className="qhds-ze-h">Split lines</span>
            <div className="qhds-ze-pair">
              <div>
                <span className="qhds-ze-muted">Vertical at X</span>
                <CoordInput
                  label="Vertical split line X"
                  onCommit={(n) => updateZone({ ...current, xSplit: n })}
                  placeholder={`Middle (${fmt((extent.x0 + extent.x1) / 2)})`}
                  testId="ze-xSplit"
                  value={current.xSplit}
                />
              </div>
              <div>
                <span className="qhds-ze-muted">Horizontal at Y</span>
                <CoordInput
                  label="Horizontal split line Y"
                  onCommit={(n) => updateZone({ ...current, ySplit: n })}
                  placeholder={`Middle (${fmt((extent.y0 + extent.y1) / 2)})`}
                  testId="ze-ySplit"
                  value={current.ySplit}
                />
              </div>
            </div>
            <span className="qhds-ze-muted">
              Empty = the middle of the axis. A number or =expression, or drag
              the lines in the preview.
            </span>
          </div>
          <div className="qhds-ze-group">
            <span className="qhds-ze-h">Areas</span>
            <div className="qhds-ze-quads">
              {current.quads.map((q, k) => {
                const c = quadColor(current, drafts.indexOf(current), k);
                return (
                  <div
                    className="qhds-ze-quad"
                    data-testid={`ze-quad-${k}`}
                    key={k}
                  >
                    <span
                      aria-hidden="true"
                      className="qhds-ze-quad-pos"
                      data-q={k}
                    />
                    <input
                      aria-label={`${QUADRANT_NAMES[k]} name`}
                      data-testid={`ze-quad-${k}-label`}
                      defaultValue={q.label}
                      key={current.key + k + q.label}
                      onBlur={(e) =>
                        e.target.value !== q.label &&
                        updateZone({
                          ...current,
                          quads: current.quads.map((p, j) =>
                            j === k
                              ? {
                                  ...p,
                                  label: e.target.value || QUADRANT_NAMES[k]!,
                                  labelRaw: undefined,
                                }
                              : p,
                          ),
                        })
                      }
                      onKeyDown={(e) =>
                        e.key === "Enter" &&
                        (e.target as HTMLInputElement).blur()
                      }
                    />
                    <input
                      aria-label={`${QUADRANT_NAMES[k]} colour`}
                      className="qhds-ze-colorin"
                      data-testid={`ze-quad-${k}-color`}
                      onBlur={(e) =>
                        updateZone({
                          ...current,
                          quads: current.quads.map((p, j) =>
                            j === k
                              ? {
                                  ...p,
                                  color: { index: -1, color: e.target.value },
                                }
                              : p,
                          ),
                        })
                      }
                      onChange={(e) =>
                        updateZone(
                          {
                            ...current,
                            quads: current.quads.map((p, j) =>
                              j === k
                                ? {
                                    ...p,
                                    color: { index: -1, color: e.target.value },
                                  }
                                : p,
                            ),
                          },
                          false,
                        )
                      }
                      type="color"
                      value={
                        /^#[0-9a-f]{6}$/i.test(c)
                          ? c
                          : /^#[0-9a-f]{6}$/i.test(q.color.color ?? "")
                            ? q.color.color!
                            : "#4477aa"
                      }
                    />
                  </div>
                );
              })}
            </div>
          </div>
        </>
      ) : null}
      {current.kind === "polygon" ? (
        <PointTable
          list={current.points}
          min={3}
          onChange={(l) => updateZone({ ...current, points: l })}
          prefix="ze-points"
          title="Points"
        />
      ) : null}
      <label className="qhds-ze-field">
        <span>Show condition</span>
        <input
          defaultValue={
            current.showRaw && typeof current.showRaw === "object"
              ? String((current.showRaw as any).qValueExpression?.qExpr ?? "")
              : ""
          }
          key={current.key + "show"}
          onBlur={(e) => {
            const t = e.target.value.trim();
            updateZone({
              ...current,
              showRaw: t
                ? {
                    qValueExpression: {
                      qExpr: t.startsWith("=") ? t : `=${t}`,
                    },
                  }
                : true,
            });
          }}
          placeholder="Always shown (enter =expression)"
        />
      </label>
      <div className="qhds-ze-row-actions">
        <button
          className="qhds-ze-btn"
          onClick={() => duplicate(current.key)}
          type="button"
        >
          <Icon d={ICONS.copy} size={14} /> Duplicate
        </button>
        <button
          className="qhds-ze-btn is-danger"
          data-testid="ze-delete"
          onClick={() => removeZone(current.key)}
          type="button"
        >
          <Icon d={ICONS.trash} size={14} /> Delete zone
        </button>
      </div>
    </div>
  ) : (
    <div className="qhds-ze-inspector qhds-ze-empty-insp">
      <p>No zone selected.</p>
      <p className="qhds-ze-muted">
        Add a zone with “Add zone”, pick its shape, then draw it on the preview.
      </p>
    </div>
  );

  // ---------- data-model source view ----------
  const fields = layout?.props?.zoneFields ?? {};
  const dataView = (
    <div className="qhds-ze-dataview" data-testid="ze-dataview">
      <div>
        <div className="qhds-ze-h">Field mapping</div>
        <p className="qhds-ze-muted">
          One row per vertex. The load order of the zone ID sets the priority.
          Zones follow selections.
        </p>
        {[
          ["id", "Zone ID"],
          ["label", "Label"],
          ["color", "Color"],
          ["edge", "Edge"],
          ["seq", "Seq"],
          ["x", "X"],
          ["y", "Y"],
          ["cover", "Covers"],
          ["ends", "Ends"],
        ].map(([k, l]) => (
          <div className="qhds-ze-maprow" key={k}>
            <span>{l}</span>
            <code>{String(fields[k!] ?? "—")}</code>
          </div>
        ))}
        <p className="qhds-ze-muted">
          Change the field names in the property panel (Add-ons › Zones).
        </p>
      </div>
      <div>
        <div className="qhds-ze-h">Edge values</div>
        <ul className="qhds-ze-list-plain">
          <li>
            <code>upper</code> / <code>lower</code> — an envelope, ordered by
            Seq (no lower rows = mirrored)
          </li>
          <li>
            <code>min</code> / <code>max</code> — rectangle corners; empty X =
            horizontal band
          </li>
          <li>
            <code>point</code> — polygon vertices, ordered by Seq
          </li>
          <li>
            <code>above</code> / <code>below</code> — a line zone: its vertices,
            and the side it covers
          </li>
          <li>
            Ends: <code>closed</code> (default), <code>endless</code>,{" "}
            <code>endless-left</code>, <code>endless-right</code> — for
            rectangles, envelopes and lines
          </li>
          <li>
            Covers: <code>inside</code> (default) or <code>outside</code> — a
            negative zone owns everything beyond its shape
          </li>
        </ul>
        <div className="qhds-ze-note">
          Zones from the data model are read-only here. Change them in the load
          script, or switch to <strong>Properties</strong> to edit zones by
          hand.
        </div>
      </div>
    </div>
  );

  // ---------- Shapes tab ----------
  const previewShapeBy: DensityShapeBy | undefined =
    shapesDraft.enabled && catLabels.length ? { kind: "category", key: "category", shapes: shapesDraft.map } : undefined;
  const shapeRows = dealShapes(catLabels, { shapes: shapesDraft.map });
  const setShape = (value: string, shape: DensityPointShape | null) =>
    setShapesDraft((d) => {
      const map = { ...d.map };
      if (shape) map[value] = shape;
      else delete map[value];
      return { ...d, map };
    });
  const shapesView = (
    <div className="qhds-ze-shapes" data-testid="ze-shapes" key="shapes">
      <section className="qhds-ze-shapes-list">
        <label className="qhds-ze-switch">
          <input
            checked={shapesDraft.enabled}
            data-testid="ze-shapes-enabled"
            onChange={(e) => setShapesDraft((d) => ({ ...d, enabled: e.target.checked }))}
            type="checkbox"
          />
          <span>
            <strong>Shape points by {catTitle || "the 2nd dimension"}</strong>
            <span className="qhds-ze-muted">
              Every value gets its own glyph instead of a dot. Colour stays as it is (zone, dimension or measure).
            </span>
          </span>
        </label>
        {!catLabels.length ? (
          <div className="qhds-ze-note">
            Add a 2nd dimension (<strong>Category</strong>) in the Data section to shape points by it.
          </div>
        ) : (
          <>
            <div className="qhds-ze-shapes-head">
              <span className="qhds-ze-h">
                {catLabels.length} {catLabels.length === 1 ? "value" : "values"}
              </span>
              <button
                className="qhds-ze-link"
                disabled={!Object.keys(shapesDraft.map).length}
                onClick={() => setShapesDraft((d) => ({ ...d, map: {} }))}
                type="button"
              >
                Reset all to automatic
              </button>
            </div>
            <ul aria-label="Shape per value" className="qhds-ze-shaperows">
              {shapeRows.map((row) => {
                const explicit = shapesDraft.map[row.label] !== undefined;
                return (
                  <li className="qhds-ze-shaperow" data-testid={`ze-shape-${row.label}`} key={row.label}>
                    <span className="qhds-ze-shape-cur" title={SHAPE_LABEL[row.shape]}>
                      <DensityShapeGlyph shape={row.shape} size={14} />
                    </span>
                    <span className="qhds-ze-item-text">
                      <span className="qhds-ze-item-name">{row.label}</span>
                      <span className="qhds-ze-item-sub">
                        {SHAPE_LABEL[row.shape]}
                        {explicit ? "" : " · automatic"}
                      </span>
                    </span>
                    <div
                      aria-label={`Shape for ${row.label}`}
                      className="qhds-ze-seg qhds-ze-iconseg qhds-ze-shapepick"
                      role="radiogroup"
                    >
                      {ALL_SHAPES.map((sh) => (
                        <button
                          aria-checked={explicit && row.shape === sh}
                          aria-label={SHAPE_LABEL[sh]}
                          className="qhds-ze-tip"
                          data-tip={SHAPE_LABEL[sh]}
                          disabled={!shapesDraft.enabled}
                          key={sh}
                          onClick={() => setShape(row.label, sh)}
                          role="radio"
                          type="button"
                        >
                          <DensityShapeGlyph shape={sh} size={12} />
                        </button>
                      ))}
                    </div>
                    <button
                      aria-label={`Automatic shape for ${row.label}`}
                      className="qhds-ze-icon-btn qhds-ze-tip"
                      data-tip="Back to automatic"
                      disabled={!explicit || !shapesDraft.enabled}
                      onClick={() => setShape(row.label, null)}
                      type="button"
                    >
                      <Icon d={ICONS.close} size={14} />
                    </button>
                  </li>
                );
              })}
            </ul>
            <p className="qhds-ze-muted">
              Values without an assignment take the next free glyph, in the order they appear in the data.
              Glyphs read best from a point size of about 2 or more (Appearance › Presentation).
            </p>
          </>
        )}
      </section>
      <section aria-label="Shape preview" className="qhds-ze-center">
        <div className="qhds-ze-preview" ref={previewRef}>
          {loaded ? (
            <DensityScatterChart
              accessibleLabel="Shape preview"
              colorBy={zones.length ? { kind: "zone" } : { kind: "density" }}
              data={data}
              domain={domain}
              formatX={fmtX}
              formatY={fmtY}
              hiddenKeys={hiddenIds}
              legend={false}
              onViewChange={setView}
              outside={{
                label: String(layout?.props?.outsideLabel ?? "Outside"),
                color: theme.resolveColor(layout?.props?.outsideColor, 7),
              }}
              plotHeight={previewH}
              pointRadius={Math.max(Number(layout?.props?.pointRadius) || 1.35, shapesDraft.enabled ? 2 : 0)}
              selectionToolbar="none"
              shapeBy={previewShapeBy}
              view={view}
              xLabel={xTitle}
              yLabel={yTitle}
              zoneTags={false}
              zones={zones}
              zoom
            />
          ) : (
            <div className="qhds-ze-muted">Loading…</div>
          )}
        </div>
        <div className="qhds-ze-hints">
          <span>Preview: wheel zooms in to see the glyphs · drag pans</span>
          <span className="qhds-ze-hints-tools">
            <button
              className="qhds-ze-btn"
              onClick={() => setView(home ? { ...home } : undefined)}
              type="button"
            >
              Fit
            </button>
          </span>
        </div>
      </section>
    </div>
  );

  const body = (
    <div
      className="qhds qhds-ze-root"
      data-theme={theme.dark ? "dark" : "light"}
      style={{ ...(theme.vars as any), fontFamily: theme.fontFamily }}
    >
      <div
        className="qhds-ze-backdrop"
        onPointerDown={(e) => e.target === e.currentTarget && undefined}
      />
      <div
        aria-labelledby="qhds-ze-title"
        aria-modal="true"
        className="qhds-ze-modal"
        data-testid="zone-editor"
        onBlur={() => setTip(null)}
        onFocus={(e) =>
          (e.target as HTMLElement).matches?.(":focus-visible") &&
          showTip(e.target)
        }
        onKeyDown={onKeyDown}
        onPointerDown={() => setTip(null)}
        onPointerOut={(e) => {
          const from = (e.target as HTMLElement).closest?.("[data-tip]");
          if (from && !from.contains(e.relatedTarget as Node | null))
            setTip(null);
        }}
        onPointerOver={(e) =>
          (e.target as HTMLElement).closest?.("[data-tip]") && showTip(e.target)
        }
        ref={dialogRef}
        role="dialog"
        tabIndex={-1}
      >
        <header className="qhds-ze-header">
          <div className="qhds-ze-titles">
            <h2 id="qhds-ze-title">{tab === "shapes" ? "Shapes" : "Zones"}</h2>
            <span className="qhds-ze-muted">
              {xTitle ?? "X"} × {yTitle ?? "Y"} · {totalPoints.toLocaleString()}{" "}
              points
            </span>
          </div>
          <div
            aria-label="Editor view"
            className="qhds-ze-seg"
            role="radiogroup"
          >
            <button
              aria-checked={tab === "zones" && source === "props"}
              onClick={() => {
                setTab("zones");
                setSource("props");
              }}
              role="radio"
              type="button"
            >
              Properties
            </button>
            <button
              aria-checked={tab === "zones" && source === "data"}
              data-testid="ze-src-data"
              onClick={() => {
                setTab("zones");
                setSource("data");
              }}
              role="radio"
              type="button"
            >
              Data model
            </button>
            <button
              aria-checked={tab === "shapes"}
              data-testid="ze-tab-shapes"
              onClick={() => setTab("shapes")}
              role="radio"
              type="button"
            >
              Shapes
            </button>
          </div>
          <span className="qhds-ze-sep" />
          <button
            aria-label="Undo"
            className="qhds-ze-icon-btn"
            disabled={!past.length}
            onClick={undo}
            type="button"
          >
            <Icon d={ICONS.undo} size={18} />
          </button>
          <button
            aria-label="Redo"
            className="qhds-ze-icon-btn"
            disabled={!future.length}
            onClick={redo}
            type="button"
          >
            <Icon d={ICONS.redo} size={18} />
          </button>
          <button
            aria-label="Close"
            className="qhds-ze-icon-btn"
            onClick={onClose}
            type="button"
          >
            <Icon d={ICONS.close} size={18} />
          </button>
        </header>

        {tab === "shapes" ? (
          shapesView
        ) : source === "data" ? (
          dataView
        ) : (
          <div className="qhds-ze-body" key="zones">
            {/* zone list */}
            <aside className="qhds-ze-listcol">
              <div className="qhds-ze-list-head">
                <span className="qhds-ze-h">
                  {drafts.length} {drafts.length === 1 ? "zone" : "zones"}
                </span>
                <span className="qhds-ze-muted">first match wins ↓</span>
              </div>
              <ul
                aria-label="Zones, in priority order"
                className="qhds-ze-list"
                role="listbox"
              >
                {drafts.map((d, i) => {
                  const bad = validate(d);
                  const share = shares.get(d.key);
                  return (
                    <li
                      aria-selected={d.key === selected}
                      className="qhds-ze-item"
                      data-testid={`ze-item-${i}`}
                      draggable
                      key={d.key}
                      onClick={() => setSelected(d.key)}
                      onDragOver={(e) => e.preventDefault()}
                      onDragStart={() => (dragKey.current = d.key)}
                      onDrop={() => {
                        const from = drafts.findIndex(
                          (z) => z.key === dragKey.current,
                        );
                        if (from < 0 || from === i) return;
                        const next = [...drafts];
                        const [m] = next.splice(from, 1);
                        next.splice(i, 0, m!);
                        commit(next);
                      }}
                      onKeyDown={(e) => {
                        if (e.altKey && e.key === "ArrowUp")
                          (e.preventDefault(), move(d.key, -1));
                        if (e.altKey && e.key === "ArrowDown")
                          (e.preventDefault(), move(d.key, 1));
                        if (e.key === "Enter" || e.key === " ")
                          (e.preventDefault(), setSelected(d.key));
                      }}
                      role="option"
                      tabIndex={0}
                    >
                      <span aria-hidden="true" className="qhds-ze-grip">
                        ⋮⋮
                      </span>
                      <span
                        className="qhds-ze-swatch-sm"
                        style={{ background: swatchOf(d, i) }}
                      />
                      <span className="qhds-ze-item-text">
                        <span className="qhds-ze-item-name">{d.label}</span>
                        <span
                          className={
                            bad ? "qhds-ze-item-sub is-bad" : "qhds-ze-item-sub"
                          }
                        >
                          {KIND_LABEL[d.kind]}
                          {d.kind === "envelope" && d.mirror
                            ? " · mirrored"
                            : ""}
                          {d.kind === "line" ? ` · ${d.side}` : ""}
                          {(d.kind === "rect" ||
                            d.kind === "envelope" ||
                            d.kind === "line") &&
                          (d.extendStart || d.extendEnd)
                            ? " · endless"
                            : ""}
                          {d.cover === "outside" ? " · outside" : ""} ·{" "}
                          {bad ??
                            (share === undefined
                              ? "—"
                              : `${(share * 100).toFixed(1)}%`)}
                        </span>
                      </span>
                      <span className="qhds-ze-item-actions">
                        <button
                          aria-label={`Move ${d.label} up`}
                          className="qhds-ze-icon-btn"
                          disabled={i === 0}
                          onClick={(e) => (
                            e.stopPropagation(),
                            move(d.key, -1)
                          )}
                          type="button"
                        >
                          <Icon d={ICONS.up} size={12} />
                        </button>
                        <button
                          aria-label={`Move ${d.label} down`}
                          className="qhds-ze-icon-btn"
                          disabled={i === drafts.length - 1}
                          onClick={(e) => (e.stopPropagation(), move(d.key, 1))}
                          type="button"
                        >
                          <Icon d={ICONS.down} size={12} />
                        </button>
                        <button
                          aria-label={`${hidden.has(d.key) ? "Show" : "Hide"} ${d.label} in preview`}
                          aria-pressed={hidden.has(d.key)}
                          className="qhds-ze-icon-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            const n = new Set(hidden);
                            if (n.has(d.key)) n.delete(d.key);
                            else n.add(d.key);
                            setHidden(n);
                          }}
                          type="button"
                        >
                          <Icon
                            d={hidden.has(d.key) ? ICONS.eyeOff : ICONS.eye}
                            size={14}
                          />
                        </button>
                      </span>
                    </li>
                  );
                })}
                <li
                  className={
                    layout?.props?.outsideInteractive === false
                      ? "qhds-ze-item is-outside is-muted"
                      : "qhds-ze-item is-outside"
                  }
                  role="presentation"
                >
                  <span
                    className="qhds-ze-swatch-sm"
                    style={{
                      background: theme.resolveColor(
                        layout?.props?.outsideColor,
                        7,
                      ),
                    }}
                  />
                  <span className="qhds-ze-item-text">
                    <span className="qhds-ze-item-name">
                      {String(layout?.props?.outsideLabel ?? "Outside")}
                    </span>
                    <span className="qhds-ze-item-sub">
                      no zone matched ·{" "}
                      {shares.has("__outside")
                        ? `${(shares.get("__outside")! * 100).toFixed(1)}%`
                        : "—"}
                      {layout?.props?.outsideInteractive === false
                        ? " · not in legend"
                        : ""}
                    </span>
                  </span>
                </li>
              </ul>
              <div className="qhds-ze-list-foot">
                <div className="qhds-ze-menu-wrap">
                  <button
                    aria-expanded={menu}
                    aria-haspopup="menu"
                    className="qhds-ze-btn qhds-ze-btn-block"
                    data-testid="ze-add"
                    onClick={() => setMenu((m) => !m)}
                    type="button"
                  >
                    <Icon d={ICONS.plus} size={14} /> Add zone
                  </button>
                  {menu ? (
                    <div
                      aria-label="Add zone"
                      className="qhds-ze-menu"
                      role="menu"
                    >
                      {ZONE_KINDS.map((k) => (
                        <button
                          className="qhds-ze-menuitem"
                          data-testid={`ze-add-${k}`}
                          key={k}
                          onClick={() => {
                            setMenu(false);
                            setTool(k);
                          }}
                          role="menuitem"
                          type="button"
                        >
                          <Icon d={ICONS[k]} size={18} />
                          <span>
                            <strong>{KIND_LABEL[k]}</strong>
                            <span className="qhds-ze-muted">
                              {KIND_HELP[k]}
                            </span>
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <span className="qhds-ze-muted">
                  Drag rows (or Alt+↑/↓) to change priority.
                </span>
              </div>
            </aside>

            {/* preview */}
            <section aria-label="Preview" className="qhds-ze-center">
              <div
                className="qhds-ze-preview"
                data-testid="ze-preview"
                ref={previewRef}
              >
                {tool !== "select" ? (
                  <div className="qhds-ze-drawbar" role="status">
                    <Icon d={ICONS[tool as ZoneKind]} size={16} />
                    <span>
                      <strong>
                        New {KIND_LABEL[tool as ZoneKind].toLowerCase()}
                      </strong>{" "}
                      ·{" "}
                      {hover ??
                        (tool === "quadrant"
                          ? "Click where the two lines should cross"
                          : tool === "circle"
                            ? "Drag from the centre outwards"
                            : tool === "envelope" || tool === "polygon"
                              ? "Click around the region · click the first point (or ✓ Finish) to close"
                              : tool === "line"
                                ? "Click points left to right · ✓ Finish or Enter ends"
                                : "Drag in the plot")}
                    </span>
                    <button
                      className="qhds-ze-btn"
                      data-testid="ze-draw-cancel"
                      onClick={() => setTool("select")}
                      type="button"
                    >
                      Cancel (Esc)
                    </button>
                  </div>
                ) : null}
                {loaded ? (
                  <DensityScatterChart
                    accessibleLabel="Zone editor preview"
                    colorBy={
                      zones.length ? { kind: "zone" } : { kind: "density" }
                    }
                    data={data}
                    domain={domain}
                    hiddenKeys={hiddenIds}
                    legend={false}
                    onViewChange={setView}
                    outside={{
                      label: String(layout?.props?.outsideLabel ?? "Outside"),
                      color: theme.resolveColor(layout?.props?.outsideColor, 7),
                    }}
                    plotHeight={previewH}
                    renderOverlay={(ctx) => (
                      <EditorOverlay
                        color={
                          current
                            ? colorOf(current, drafts.indexOf(current))
                            : "#404040"
                        }
                        ctx={ctx}
                        onCancelDraw={() => setTool("select")}
                        onChange={onOverlayChange}
                        onDraw={addZone}
                        onHover={setHover}
                        quadDefault={{
                          x: (extent.x0 + extent.x1) / 2,
                          y: (extent.y0 + extent.y1) / 2,
                        }}
                        snap={snap}
                        tool={tool}
                        zone={current}
                      />
                    )}
                    selectionToolbar="none"
                    shapeBy={previewShapeBy}
                    view={view}
                    formatX={fmtX}
                    formatY={fmtY}
                    xLabel={xTitle}
                    yLabel={yTitle}
                    zoneTags={false}
                    zones={zones}
                    zoom
                  />
                ) : (
                  <div className="qhds-ze-muted">Loading…</div>
                )}
              </div>
              <div className="qhds-ze-hints">
                <span>
                  Drag a point to move it · click a dashed midpoint to add one ·
                  Alt-click removes · wheel zooms
                </span>
                <span className="qhds-ze-hints-tools">
                  <label className="qhds-ze-check">
                    <input
                      checked={snap}
                      onChange={(e) => setSnap(e.target.checked)}
                      type="checkbox"
                    />{" "}
                    Snap
                  </label>
                  <button
                    className="qhds-ze-btn"
                    onClick={() => setView(home ? { ...home } : undefined)}
                    type="button"
                  >
                    Fit
                  </button>
                </span>
              </div>
            </section>

            {inspector}
          </div>
        )}

        <footer className="qhds-ze-footer">
          {error ? (
            <span className="qhds-ze-err" role="alert">
              {error}
            </span>
          ) : issues.length ? (
            <span className="qhds-ze-err">
              {issues.length} zone{issues.length > 1 ? "s" : ""} need attention:{" "}
              {issues.map((x) => `${x.d.label} — ${x.msg}`).join("; ")}
            </span>
          ) : (
            <span className="qhds-ze-ok">
              <Icon d={ICONS.check} size={14} /> {drafts.length} zones valid
              {exprCount
                ? ` · ${exprCount} expression${exprCount > 1 ? "s" : ""}`
                : ""}
              {past.length
                ? ` · ${past.length} unsaved change${past.length > 1 ? "s" : ""}`
                : ""}
            </span>
          )}
          <span className="qhds-ze-grow" />
          <button
            className="qhds-ze-btn"
            data-testid="ze-cancel"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          <button
            className="qhds-ze-btn is-primary"
            data-testid="ze-apply"
            disabled={saving || !dirty}
            onClick={apply}
            type="button"
          >
            {saving ? "Saving…" : "Apply"}
          </button>
        </footer>
      </div>
      {tip ? (
        <div
          className="qhds-ze-tipbox"
          data-testid="ze-tip"
          role="tooltip"
          style={{
            left: Math.min(Math.max(tip.x, 140), window.innerWidth - 140),
            top: tip.y,
            transform: tip.above
              ? "translate(-50%, -100%)"
              : "translateX(-50%)",
          }}
        >
          {tip.text}
        </div>
      ) : null}
    </div>
  );

  return createPortal(body, document.body);
}
