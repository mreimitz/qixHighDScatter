/**
 * The chart's intersection selection → engine range selections, the way the
 * native scatter does it (decision D3): everything is expressed as rectangles
 * on the two measures and sent as ONE `multiRangeSelectHyperCubeValues`
 * (entries OR'ed, x AND y inside an entry) — or a single
 * `rangeSelectHyperCubeValues` when one rectangle is enough. Empty → reset.
 *
 * Regions are computed as interval sets over vertical strips. The strip edges
 * include every x breakpoint of the shapes involved (zone vertices, rectangle
 * edges, range ends), so rectangles, bands and ranges stay EXACT; slanted
 * edges (envelopes, polygons, lassos) are subdivided and covered conservatively.
 * Zone picks follow the chart's classification: first match wins (inner →
 * outer), `invert` zones own the outside of their shape, and the "outside"
 * class is everything no zone covers.
 */
import { DENSITY_OUTSIDE_ID, type DensityScatterSelection, type DensityZone } from "@elabs-ai/components-charts";

export interface Rect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
export interface Domain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

type Pt = readonly [number, number];
type Iv = [number, number];
/** One interval list per strip. */
type Region = Iv[][];

/** Strips a slanted segment is split into (per breakpoint gap). */
export const SUBDIV = 32;
const MAX_RECTS = 600;

// ---------- interval helpers ----------
function norm(list: Iv[]): Iv[] {
  const s = list.filter(([a, b]) => b >= a).sort((p, q) => p[0] - q[0]);
  const out: Iv[] = [];
  for (const iv of s) {
    const last = out[out.length - 1];
    if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
    else out.push([iv[0], iv[1]]);
  }
  return out;
}
function ivIntersect(a: Iv[], b: Iv[]): Iv[] {
  const out: Iv[] = [];
  for (const [a0, a1] of a) for (const [b0, b1] of b) {
    const lo = Math.max(a0, b0);
    const hi = Math.min(a1, b1);
    if (lo <= hi) out.push([lo, hi]);
  }
  return norm(out);
}
function ivComplement(a: Iv[], lo: number, hi: number): Iv[] {
  const out: Iv[] = [];
  let cur = lo;
  for (const [a0, a1] of norm(a)) {
    if (a0 > cur) out.push([cur, Math.min(a0, hi)]);
    cur = Math.max(cur, a1);
  }
  if (cur < hi) out.push([cur, hi]);
  return out.filter(([x, y]) => y > x);
}

// ---------- shapes at a strip ----------
function polylineAt(poly: ReadonlyArray<Pt>, x: number): number {
  if (x <= poly[0]![0]) return poly[0]![1];
  for (let i = 1; i < poly.length; i++) {
    const [ax, ay] = poly[i - 1]!;
    const [bx, by] = poly[i]!;
    if (x <= bx) return bx === ax ? by : ay + ((by - ay) * (x - ax)) / (bx - ax);
  }
  return poly[poly.length - 1]![1];
}
function polygonAt(poly: ReadonlyArray<Pt>, x0: number, x1: number): Iv[] {
  const crossings = (cx: number) => {
    const hits: number[] = [];
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i]!;
      const [xj, yj] = poly[j]!;
      if (xi > cx !== xj > cx) hits.push(yi + ((cx - xi) * (yj - yi)) / (xj - xi));
    }
    return hits.sort((a, b) => a - b);
  };
  const out: Iv[] = [];
  // sample both edges (nudged inside) and the centre; union keeps it conservative
  const w = x1 - x0;
  for (const cx of [x0 + w * 1e-6, (x0 + x1) / 2, x1 - w * 1e-6]) {
    const h = crossings(cx);
    for (let k = 0; k + 1 < h.length; k += 2) out.push([h[k]!, h[k + 1]!]);
  }
  // join intervals that overlap between samples into one conservative band
  return norm(out);
}

interface Shape {
  /** x breakpoints this shape needs as strip edges */
  xs: number[];
  /** whether its edges are slanted between breakpoints (needs subdivision) */
  slanted: boolean;
  /** inside intervals for the strip [x0, x1] */
  at: (x0: number, x1: number) => Iv[];
}

const FULL: Iv = [-Number.MAX_VALUE, Number.MAX_VALUE];

function zoneShape(zone: DensityZone): Shape {
  const b: any = zone.bounds;
  if ("polygon" in b) {
    const poly: Pt[] = b.polygon;
    return { xs: poly.map((p) => p[0]), slanted: true, at: (x0, x1) => polygonAt(poly, x0, x1) };
  }
  if ("line" in b) {
    const ln = [...b.line].sort((p: Pt, q: Pt) => p[0] - q[0]) as Pt[];
    const a = b.extend?.start ? -Infinity : ln[0]![0];
    const c = b.extend?.end ? Infinity : ln[ln.length - 1]![0];
    const above = b.side !== "below";
    return {
      xs: ln.map((p) => p[0]),
      slanted: true,
      at: (x0, x1) => {
        if (x1 <= a || x0 >= c) return [];
        const xa = Math.max(x0, a);
        const xb = Math.min(x1, c);
        const ys = [xa, (xa + xb) / 2, xb].map((x) => polylineAt(ln, x));
        // conservative: the strip's lowest line point for "above", highest for "below"
        return above ? [[Math.min(...ys), FULL[1]]] : [[FULL[0], Math.max(...ys)]];
      },
    };
  }
  if ("upper" in b) {
    const u = [...b.upper].sort((p: Pt, q: Pt) => p[0] - q[0]) as Pt[];
    const l = [...b.lower].sort((p: Pt, q: Pt) => p[0] - q[0]) as Pt[];
    const lo = b.extend?.start ? -Infinity : Math.max(u[0]![0], l[0]![0]);
    const hi = b.extend?.end ? Infinity : Math.min(u[u.length - 1]![0], l[l.length - 1]![0]);
    return {
      xs: [...u, ...l].map((p) => p[0]),
      slanted: true,
      at: (x0, x1) => {
        if (x1 <= lo || x0 >= hi) return [];
        let a = Infinity;
        let c = -Infinity;
        for (const x of [Math.max(x0, lo), (Math.max(x0, lo) + Math.min(x1, hi)) / 2, Math.min(x1, hi)]) {
          const yu = polylineAt(u, x);
          const yl = polylineAt(l, x);
          a = Math.min(a, yu, yl);
          c = Math.max(c, yu, yl);
        }
        return [[a, c]];
      },
    };
  }
  const [xa, xb] = b.x ?? [-Infinity, Infinity];
  const [ya, yb] = b.y;
  return {
    xs: [xa, xb].filter(Number.isFinite),
    slanted: false,
    at: (x0, x1) => ((x0 + x1) / 2 >= xa && (x0 + x1) / 2 <= xb ? [[Math.min(ya, yb), Math.max(ya, yb)]] : []),
  };
}

// ---------- the plan ----------
export interface EnginePlan {
  /** `null` = no constraint (reset). */
  rects: Rect[] | null;
  /** The strips were coarsened to stay under MAX_RECTS rectangles. */
  coarse?: boolean;
}

function rangeShape(axis: "x" | "y", lo: number, hi: number): Shape {
  const a = Math.min(lo, hi);
  const b = Math.max(lo, hi);
  return axis === "x"
    ? { xs: [a, b], slanted: false, at: (x0, x1) => ((x0 + x1) / 2 >= a && (x0 + x1) / 2 <= b ? [FULL] : []) }
    : { xs: [], slanted: false, at: () => [[a, b]] };
}

export function planSelection(
  selection: DensityScatterSelection | undefined,
  zones: readonly DensityZone[],
  domain?: Domain,
): EnginePlan {
  // Finest strips first; coarsen until the message stays bounded.
  for (let sub = SUBDIV; ; sub = Math.floor(sub / 2)) {
    const plan = planAt(selection, zones, domain, Math.max(1, sub));
    if (plan.rects === null || plan.rects.length <= MAX_RECTS || sub <= 1) return { ...plan, coarse: sub < SUBDIV };
  }
}

function planAt(
  selection: DensityScatterSelection | undefined,
  zones: readonly DensityZone[],
  domain: Domain | undefined,
  subdiv: number,
): EnginePlan {
  if (!selection) return { rects: null };
  const constraints: Array<{ shapes: Shape[]; eval: (per: Iv[][], strip: number) => Iv[] }> = [];
  const shapes: Shape[] = [];
  const add = (s: Shape) => (shapes.push(s), shapes.length - 1);

  if (selection.x) {
    const i = add(rangeShape("x", selection.x[0], selection.x[1]));
    constraints.push({ shapes: [], eval: (per, k) => per[i]![k]! });
  }
  if (selection.y) {
    const i = add(rangeShape("y", selection.y[0], selection.y[1]));
    constraints.push({ shapes: [], eval: (per, k) => per[i]![k]! });
  }
  if (selection.lasso && selection.lasso.length >= 3) {
    const poly = selection.lasso as Pt[];
    const i = add({ xs: poly.map((p) => p[0]), slanted: true, at: (a, b) => polygonAt(poly, a, b) });
    constraints.push({ shapes: [], eval: (per, k) => per[i]![k]! });
  }
  if (selection.zones?.length) {
    // every zone's shape, so priority (first match) and "outside" can be resolved
    const idx = zones.map((z) => add(zoneShape(z)));
    const picked = new Set(selection.zones);
    constraints.push({
      shapes: [],
      eval: (per, k) => {
        // covered-so-far, walking zones inner → outer
        let covered: Iv[] = [];
        let out: Iv[] = [];
        zones.forEach((z, zi) => {
          const inside = per[idx[zi]!]![k]!;
          const own = z.invert ? ivComplement(inside, FULL[0], FULL[1]) : inside;
          const mine = ivIntersect(own, ivComplement(covered, FULL[0], FULL[1]));
          if (picked.has(z.id)) out = norm([...out, ...mine]);
          covered = norm([...covered, ...own]);
        });
        if (picked.has(DENSITY_OUTSIDE_ID)) out = norm([...out, ...ivComplement(covered, FULL[0], FULL[1])]);
        return out;
      },
    });
  }
  if (!constraints.length) return { rects: null };

  // strip edges: domain + every breakpoint, slanted gaps subdivided
  const dx0 = domain?.x0 ?? -Number.MAX_VALUE;
  const dx1 = domain?.x1 ?? Number.MAX_VALUE;
  const finite = (v: number) => Number.isFinite(v) && Math.abs(v) < 1e300;
  let edges = [dx0, dx1, ...shapes.flatMap((s) => s.xs)].filter(finite);
  edges = [...new Set(edges)].sort((a, b) => a - b);
  if (edges.length < 2) edges = [edges[0] ?? -1, (edges[0] ?? -1) + 1];
  // subdivide only where a slanted shape actually spans the gap
  const slantedSpans = shapes
    .filter((s) => s.slanted && s.xs.length)
    .map((s) => [Math.min(...s.xs), Math.max(...s.xs)] as const);
  const strips: Iv[] = [];
  for (let i = 0; i + 1 < edges.length; i++) {
    const a = edges[i]!;
    const b = edges[i + 1]!;
    const n = slantedSpans.some(([lo, hi]) => a < hi && b > lo) ? subdiv : 1;
    for (let k = 0; k < n; k++) strips.push([a + ((b - a) * k) / n, a + ((b - a) * (k + 1)) / n]);
  }
  // unbounded left/right of the domain: one strip each (points there are rare/none)
  strips.unshift([-Number.MAX_VALUE, edges[0]!]);
  strips.push([edges[edges.length - 1]!, Number.MAX_VALUE]);

  const per: Iv[][][] = shapes.map((s) => strips.map(([a, b]) => (a === -Number.MAX_VALUE || b === Number.MAX_VALUE ? s.at(a === -Number.MAX_VALUE ? b - 1 : a, b === Number.MAX_VALUE ? a + 1 : b) : s.at(a, b))));
  const region: Region = strips.map((_, k) => {
    let r: Iv[] = [FULL];
    for (const c of constraints) r = ivIntersect(r, c.eval(per, k));
    return r;
  });

  // rects, merging neighbouring strips with identical intervals
  const rects: Rect[] = [];
  let open: Map<string, Rect> = new Map();
  strips.forEach(([a, b], k) => {
    const next = new Map<string, Rect>();
    for (const [y0, y1] of region[k]!) {
      const key = `${y0}|${y1}`;
      const prev = open.get(key);
      if (prev && prev.x1 === a) {
        prev.x1 = b;
        next.set(key, prev);
      } else {
        const r = { x0: a, x1: b, y0, y1 };
        rects.push(r);
        next.set(key, r);
      }
    }
    open = next;
  });
  return { rects };
}

const range = (ix: number, lo: number, hi: number) => ({
  qMeasureIx: ix,
  qRange: { qMin: lo, qMax: hi, qMinInclEq: true, qMaxInclEq: true },
});
/** An axis the plan leaves open (±huge) is no constraint: leave it out, as a native axis range does. */
const bounded = (lo: number, hi: number) => !(lo <= -1e300 && hi >= 1e300);
const ranges = (r: { x0: number; x1: number; y0: number; y1: number }) => {
  const out = [];
  if (bounded(r.x0, r.x1)) out.push(range(0, r.x0, r.x1));
  if (bounded(r.y0, r.y1)) out.push(range(1, r.y0, r.y1));
  return out.length ? out : [range(0, r.x0, r.x1)];
};

/** The stardust `selections.select(...)` argument for a plan. */
export function toEngineSelect(plan: EnginePlan): { method: string; params: unknown[] } {
  if (plan.rects === null) return { method: "resetMadeSelections", params: [] };
  const rects = plan.rects.length ? plan.rects : [{ x0: 1, x1: 0, y0: 1, y1: 0 }]; // empty → selects nothing
  if (rects.length === 1) {
    const r = rects[0]!;
    return {
      method: "rangeSelectHyperCubeValues",
      params: ["/qHyperCubeDef", ranges(r), [], false],
    };
  }
  return {
    method: "multiRangeSelectHyperCubeValues",
    params: ["/qHyperCubeDef", rects.map((r) => ({ qRanges: ranges(r) }))],
  };
}
