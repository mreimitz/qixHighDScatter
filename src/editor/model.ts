/**
 * Zone editor draft model: raw properties (numbers or {qValueExpression}) plus
 * the engine-evaluated layout values, merged into one editable shape, and back.
 */

export type ZoneKind = "band" | "rect" | "envelope" | "line" | "polygon" | "circle" | "quadrant";
export const ZONE_KINDS: ZoneKind[] = ["band", "rect", "envelope", "line", "polygon", "circle", "quadrant"];
export const QUADRANT_NAMES = ["Top left", "Top right", "Bottom left", "Bottom right"];

/** One of a quadrant zone's 4 areas (0 top left, 1 top right, 2 bottom left, 3 bottom right). */
export interface QuadPart {
  label: string;
  /** Raw label when it is an expression. */
  labelRaw?: unknown;
  color: { index: number; color: string | null };
}

/** A number the user typed, or an expression (with its last evaluated value). */
export interface Num {
  v: number | null;
  expr?: string;
}
export interface Pt {
  x: Num;
  y: Num;
}
export interface DraftZone {
  key: string;
  label: string;
  /** Raw label when it is an expression: kept untouched unless the label is edited. */
  labelRaw?: unknown;
  showRaw: unknown;
  kind: ZoneKind;
  /** "inside": the points in the shape; "outside": everything beyond it. */
  cover: "inside" | "outside";
  color: { index: number; color: string | null };
  /** Colour from a Qlik expression instead of the fixed colour. */
  colorByExpr: boolean;
  /** The colour expression as typed: `=If(…, RGB(…), …)`, or a literal colour. */
  colorExpr: string;
  /** Its evaluated text (the engine's result), for the preview. */
  colorExprValue?: string | null;
  yMin: Num;
  yMax: Num;
  xMin: Num;
  xMax: Num;
  mirror: boolean;
  upper: Pt[];
  lower: Pt[];
  points: Pt[];
  /** line kind: the threshold polyline and the covered side */
  line: Pt[];
  side: "above" | "below";
  /** rect / envelope / line: open (endless) left and right ends */
  extendStart: boolean;
  extendEnd: boolean;
  /** circle: centre and radii (an ellipse in data units) */
  cx: Num;
  cy: Num;
  rx: Num;
  ry: Num;
  /** quadrant: the vertical (x) and horizontal (y) split lines; empty = axis middle */
  xSplit: Num;
  ySplit: Num;
  quads: QuadPart[];
}

let seq = 0;
export const newKey = () => `z${Date.now().toString(36)}${(seq++).toString(36)}`;

const isExprObj = (r: any) => r && typeof r === "object" && r.qValueExpression && typeof r.qValueExpression.qExpr === "string";

export function toNum(raw: unknown, evaluated: unknown): Num {
  const ev = typeof evaluated === "number" && Number.isFinite(evaluated) ? evaluated : typeof evaluated === "string" && evaluated.trim() !== "" && Number.isFinite(Number(evaluated)) ? Number(evaluated) : null;
  if (isExprObj(raw)) {
    const e = (raw as any).qValueExpression.qExpr as string;
    return { v: ev, expr: e.startsWith("=") ? e : `=${e}` };
  }
  if (typeof raw === "number") return { v: raw };
  if (typeof raw === "string" && raw.trim() !== "" && Number.isFinite(Number(raw))) return { v: Number(raw) };
  return { v: ev };
}

export function fromNum(n: Num): unknown {
  if (n.expr) return { qValueExpression: { qExpr: n.expr } };
  return n.v ?? null;
}

const pts = (raw: any[] | undefined, ev: any[] | undefined): Pt[] =>
  (raw ?? []).map((p, i) => ({ x: toNum(p?.x, ev?.[i]?.x), y: toNum(p?.y, ev?.[i]?.y) }));

/** A stored colour expression (plain text or a qStringExpression) → the text the user edits. */
function colorExprText(raw: any): string {
  if (raw && typeof raw === "object" && raw.qStringExpression && typeof raw.qStringExpression.qExpr === "string") {
    const e = raw.qStringExpression.qExpr as string;
    return e.startsWith("=") ? e : `=${e}`;
  }
  return typeof raw === "string" ? raw : "";
}

/** Raw property zones + layout zones (same order) → drafts. */
export function toDrafts(raw: any[] | undefined, evaluated: any[] | undefined): DraftZone[] {
  return (raw ?? []).map((r, i) => {
    const e = evaluated?.[i] ?? {};
    const labelIsExpr = r?.label && typeof r.label === "object";
    return {
      key: typeof r?.cId === "string" ? r.cId : newKey(),
      label: String(labelIsExpr ? (e.label ?? "Zone") : (r?.label ?? `Zone ${i + 1}`)),
      labelRaw: labelIsExpr ? r.label : undefined,
      showRaw: r?.show ?? true,
      kind: (ZONE_KINDS.includes(r?.kind) ? r.kind : "band") as ZoneKind,
      cover: r?.cover === "outside" ? "outside" : "inside",
      color: {
        index: typeof r?.color?.index === "number" ? r.color.index : Number(r?.color?.index ?? -1),
        color: typeof r?.color?.color === "string" ? r.color.color : null,
      },
      colorByExpr: r?.colorByExpr === true,
      colorExpr: colorExprText(r?.colorExpr),
      colorExprValue: typeof e.colorExpr === "string" ? e.colorExpr : null,
      yMin: toNum(r?.yMin, e.yMin),
      yMax: toNum(r?.yMax, e.yMax),
      xMin: toNum(r?.xMin, e.xMin),
      xMax: toNum(r?.xMax, e.xMax),
      mirror: r?.mirror !== false,
      upper: pts(r?.upper, e.upper),
      lower: pts(r?.lower, e.lower),
      points: pts(r?.points, e.points),
      line: pts(r?.line, e.line),
      side: r?.side === "below" ? "below" : "above",
      extendStart: r?.extendStart === true,
      extendEnd: r?.extendEnd === true,
      cx: toNum(r?.cx, e.cx),
      cy: toNum(r?.cy, e.cy),
      rx: toNum(r?.rx, e.rx),
      ry: toNum(r?.ry, e.ry),
      xSplit: toNum(r?.xSplit, e.xSplit),
      ySplit: toNum(r?.ySplit, e.ySplit),
      quads: QUADRANT_NAMES.map((name, q) => {
        const lr = r?.[`q${q}Label`];
        const isExpr = lr && typeof lr === "object";
        const c = r?.[`q${q}Color`];
        return {
          label: String(isExpr ? (e[`q${q}Label`] ?? name) : (lr ?? name)) || name,
          labelRaw: isExpr ? lr : undefined,
          color: {
            index: typeof c?.index === "number" ? c.index : Number(c?.index ?? -1),
            color: typeof c?.color === "string" ? c.color : null,
          },
        };
      }),
    };
  });
}

/** Defaults for the fields a kind doesn't use yet (new drafts, old properties). */
export function blankShapeFields(): Pick<DraftZone, "cx" | "cy" | "rx" | "ry" | "xSplit" | "ySplit" | "quads"> {
  return {
    cx: { v: null },
    cy: { v: null },
    rx: { v: null },
    ry: { v: null },
    xSplit: { v: null },
    ySplit: { v: null },
    quads: QUADRANT_NAMES.map((label) => ({ label, color: { index: -1, color: null } })),
  };
}

/** Drafts → raw property zones (what `applyPatches` writes to /props/zones). */
export function fromDrafts(drafts: DraftZone[]): any[] {
  const p = (list: Pt[]) => list.map((q) => ({ x: fromNum(q.x), y: fromNum(q.y) }));
  return drafts.map((d) => {
    const out: any = { cId: d.key, label: d.labelRaw ?? d.label, show: d.showRaw ?? true, kind: d.kind, cover: d.cover, color: d.color };
    out.colorByExpr = d.colorByExpr;
    const ce = d.colorExpr.trim();
    out.colorExpr = ce.startsWith("=") ? { qStringExpression: { qExpr: ce } } : ce;
    if (d.kind === "band" || d.kind === "rect") {
      out.yMin = fromNum(d.yMin);
      out.yMax = fromNum(d.yMax);
    }
    if (d.kind === "rect") {
      out.xMin = fromNum(d.xMin);
      out.xMax = fromNum(d.xMax);
    }
    if (d.kind === "envelope") {
      out.mirror = d.mirror;
      out.upper = p(d.upper);
      out.lower = d.mirror ? [] : p(d.lower);
    }
    if (d.kind === "polygon") out.points = p(d.points);
    if (d.kind === "line") {
      out.line = p(d.line);
      out.side = d.side;
    }
    if (d.kind === "rect" || d.kind === "envelope" || d.kind === "line") {
      out.extendStart = d.extendStart;
      out.extendEnd = d.extendEnd;
    }
    if (d.kind === "circle") {
      out.cx = fromNum(d.cx);
      out.cy = fromNum(d.cy);
      out.rx = fromNum(d.rx);
      out.ry = fromNum(d.ry);
    }
    if (d.kind === "quadrant") {
      // empty split = the axis middle: stored as "" so the panel shows it empty
      out.xSplit = d.xSplit.expr || d.xSplit.v !== null ? fromNum(d.xSplit) : "";
      out.ySplit = d.ySplit.expr || d.ySplit.v !== null ? fromNum(d.ySplit) : "";
      d.quads.forEach((q, i) => {
        out[`q${i}Label`] = q.labelRaw ?? q.label;
        out[`q${i}Color`] = q.color;
      });
    }
    return out;
  });
}

/** Drafts → the evaluated shape `toDensityZones` reads (numbers only). */
export function draftsToEvaluated(drafts: DraftZone[]): any[] {
  const p = (list: Pt[]) => list.map((q) => ({ x: q.x.v, y: q.y.v }));
  return drafts.map((d) => ({
    cId: d.key,
    label: d.label,
    show: d.showRaw === false ? false : true,
    kind: d.kind,
    cover: d.cover,
    color: d.color,
    colorByExpr: d.colorByExpr,
    colorExpr: d.colorExpr.trim().startsWith("=") ? (d.colorExprValue ?? "") : d.colorExpr,
    yMin: d.yMin.v,
    yMax: d.yMax.v,
    xMin: d.xMin.v,
    xMax: d.xMax.v,
    mirror: d.mirror,
    upper: p(d.upper),
    lower: p(d.lower),
    points: p(d.points),
    line: p(d.line),
    side: d.side,
    extendStart: d.extendStart,
    extendEnd: d.extendEnd,
    cx: d.cx.v,
    cy: d.cy.v,
    rx: d.rx.v,
    ry: d.ry.v,
    xSplit: d.xSplit.v,
    ySplit: d.ySplit.v,
    ...Object.fromEntries(d.quads.flatMap((q, i) => [[`q${i}Label`, q.label], [`q${i}Color`, q.color]])),
  }));
}

/** Parses what the user typed into a coordinate cell: a number, or `=expression`. */
export function parseCell(text: string, prev: Num, allowEmpty = false): Num {
  const t = text.trim().replace(/−/g, "-");
  if (t === "" && allowEmpty) return { v: null };
  if (t.startsWith("=")) return { v: prev.expr === t ? prev.v : null, expr: t };
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) && t !== "" ? { v: n } : { v: prev.v };
}

export function validate(d: DraftZone): string | null {
  const ok = (n: Num) => n.v !== null && Number.isFinite(n.v);
  const okPts = (l: Pt[], min: number) => l.filter((q) => ok(q.x) && ok(q.y)).length >= min;
  switch (d.kind) {
    case "band":
      return ok(d.yMin) && ok(d.yMax) ? null : "Y min and Y max need values";
    case "rect":
      return ok(d.yMin) && ok(d.yMax) && (d.extendStart || ok(d.xMin)) && (d.extendEnd || ok(d.xMax)) ? null : "X and Y min/max need values";
    case "line":
      return okPts(d.line, 2) ? null : "A line needs at least 2 points";
    case "envelope":
      if (!okPts(d.upper, 2)) return "Upper edge needs at least 2 points";
      if (!d.mirror && !okPts(d.lower, 2)) return "Lower edge needs at least 2 points";
      return null;
    case "polygon":
      return okPts(d.points, 3) ? null : "A polygon needs at least 3 points";
    case "circle":
      return ok(d.cx) && ok(d.cy) && ok(d.rx) && ok(d.ry) && d.rx.v !== 0 && d.ry.v !== 0 ? null : "Centre and radii need values";
    case "quadrant":
      return (!d.xSplit.expr || ok(d.xSplit)) && (!d.ySplit.expr || ok(d.ySplit)) ? null : "Split line expressions need values";
  }
}

/** Converts a zone to another kind, keeping its extent where it can. */
export function convertKind(d: DraftZone, kind: ZoneKind, extent: { x0: number; x1: number; y0: number; y1: number }): DraftZone {
  if (d.kind === kind) return d;
  const n = (v: number | null): Num => ({ v });
  const raw = boundsOf(d) ?? extent;
  const fin = (v: number, f: number) => (Number.isFinite(v) ? v : f);
  const b = { x0: fin(raw.x0, extent.x0), x1: fin(raw.x1, extent.x1), y0: fin(raw.y0, extent.y0), y1: fin(raw.y1, extent.y1) };
  const next: DraftZone = { ...d, kind };
  if (kind === "band" || kind === "rect") {
    next.yMin = d.kind === "band" || d.kind === "rect" ? d.yMin : n(b.y0);
    next.yMax = d.kind === "band" || d.kind === "rect" ? d.yMax : n(b.y1);
    next.xMin = d.kind === "rect" ? d.xMin : n(b.x0);
    next.xMax = d.kind === "rect" ? d.xMax : n(b.x1);
  }
  if (kind === "envelope" && !d.upper.length) {
    next.upper = [{ x: n(b.x0), y: n(b.y1) }, { x: n(b.x1), y: n(b.y1) }];
    next.lower = [{ x: n(b.x0), y: n(b.y0) }, { x: n(b.x1), y: n(b.y0) }];
    next.mirror = Math.abs(b.y0 + b.y1) < 1e-9;
  }
  if (kind === "line" && d.line.length < 2) {
    const src = d.upper.length >= 2 ? d.upper : null;
    next.line = src ? src.map((p) => ({ x: { ...p.x }, y: { ...p.y } })) : [{ x: n(b.x0), y: n(b.y1) }, { x: n(b.x1), y: n(b.y1) }];
    next.side = "above";
  }
  if (kind === "circle") {
    next.cx = n((b.x0 + b.x1) / 2);
    next.cy = n((b.y0 + b.y1) / 2);
    next.rx = n(Math.abs(b.x1 - b.x0) / 2 || 1);
    next.ry = n(Math.abs(b.y1 - b.y0) / 2 || 1);
  }
  if (kind === "quadrant") {
    next.xSplit = { v: null };
    next.ySplit = { v: null };
  }
  if (kind === "polygon" && d.points.length < 3) {
    next.points = [
      { x: n(b.x0), y: n(b.y0) },
      { x: n(b.x1), y: n(b.y0) },
      { x: n(b.x1), y: n(b.y1) },
      { x: n(b.x0), y: n(b.y1) },
    ];
  }
  return next;
}

export function boundsOf(d: DraftZone): { x0: number; x1: number; y0: number; y1: number } | null {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (x: number | null, y: number | null) => {
    if (x !== null && Number.isFinite(x)) xs.push(x);
    if (y !== null && Number.isFinite(y)) ys.push(y);
  };
  if (d.kind === "quadrant") return null;
  if (d.kind === "circle") {
    const { cx, cy, rx, ry } = { cx: d.cx.v, cy: d.cy.v, rx: d.rx.v, ry: d.ry.v };
    if (cx === null || cy === null || rx === null || ry === null) return null;
    return { x0: cx - Math.abs(rx), x1: cx + Math.abs(rx), y0: cy - Math.abs(ry), y1: cy + Math.abs(ry) };
  }
  if (d.kind === "band" || d.kind === "rect") {
    add(d.kind === "rect" ? d.xMin.v : null, d.yMin.v);
    add(d.kind === "rect" ? d.xMax.v : null, d.yMax.v);
  } else {
    const list = d.kind === "polygon" ? d.points : d.kind === "line" ? d.line : [...d.upper, ...(d.mirror ? d.upper.map((p) => ({ x: p.x, y: { v: p.y.v === null ? null : -p.y.v } })) : d.lower)];
    for (const p of list) add(p.x.v, p.y.v);
  }
  if (!ys.length) return null;
  return {
    x0: xs.length ? Math.min(...xs) : -Infinity,
    x1: xs.length ? Math.max(...xs) : Infinity,
    y0: Math.min(...ys),
    y1: Math.max(...ys),
  };
}
