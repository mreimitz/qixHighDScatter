/**
 * Layout (engine-evaluated properties) → DensityScatterChart zones.
 * Every coordinate may have been an expression; the layout already holds numbers.
 * Invalid zones are reported, never thrown, so the chart can show a warning chip.
 */
import { parseQlikColor } from "./format";
import type { DensityZone } from "@elabs-ai/components-charts";

export interface ZoneIssue {
  zone: string;
  message: string;
}

const n = (v: unknown): number => (typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

type Pt = [number, number];

function points(list: any[] | undefined): Pt[] {
  return (list ?? [])
    .map((p) => [n(p?.x), n(p?.y)] as Pt)
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

export const QUADRANT_DEFAULT_NAMES = ["Top left", "Top right", "Bottom left", "Bottom right"];
/** Vertices of the ellipse a circle zone is drawn / classified as. */
export const CIRCLE_SEGMENTS = 72;

export function circlePolygon(cx: number, cy: number, rx: number, ry: number): Pt[] {
  const out: Pt[] = [];
  for (let k = 0; k < CIRCLE_SEGMENTS; k++) {
    const a = (k / CIRCLE_SEGMENTS) * Math.PI * 2;
    out.push([cx + rx * Math.cos(a), cy + ry * Math.sin(a)]);
  }
  return out;
}

export interface ZoneDomain {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * The 4 rectangles of a quadrant zone, top left → bottom right. X is open
 * (±∞); Y reaches far past the axis (the chart draws finite y edges).
 */
export function quadrantRects(xs: number, ys: number, domain: ZoneDomain | undefined) {
  const span = domain ? Math.max(Math.abs(domain.y1 - domain.y0), 1e-9) : Math.max(Math.abs(ys), 1);
  const top = (domain ? Math.max(domain.y1, ys) : ys) + span * 1000;
  const bottom = (domain ? Math.min(domain.y0, ys) : ys) - span * 1000;
  return [
    { x: [-Infinity, xs], y: [ys, top] },
    { x: [xs, Infinity], y: [ys, top] },
    { x: [-Infinity, xs], y: [bottom, ys] },
    { x: [xs, Infinity], y: [bottom, ys] },
  ] as Array<{ x: [number, number]; y: [number, number] }>;
}

/** Id of quadrant `q` (0–3) of zone `id`. */
export const quadrantId = (id: string, q: number) => `${id}:q${q}`;

export function toDensityZones(
  raw: any[] | undefined,
  resolveColor: (c: any, index: number) => string,
  domain?: ZoneDomain,
): { zones: DensityZone[]; issues: ZoneIssue[] } {
  const zones: DensityZone[] = [];
  const issues: ZoneIssue[] = [];
  (raw ?? []).forEach((z, i) => {
    const label = String(z?.label ?? `Zone ${i + 1}`) || `Zone ${i + 1}`;
    if (z?.show === false || z?.show === 0) return;
    if (zones.length >= 15) {
      issues.push({ zone: label, message: "At most 15 zones are drawn." });
      return;
    }
    const id = z?.cId || `z${i}`;
    // Colour by expression (evaluated in the layout) wins when it yields a colour.
    const exprColor = z?.colorByExpr ? parseQlikColor(z?.colorExpr) : null;
    if (z?.colorByExpr && !exprColor && z?.colorExpr !== undefined && z?.colorExpr !== "")
      issues.push({ zone: label, message: `Colour expression gave “${String(z?.colorExpr)}”, not a colour.` });
    const color = exprColor ?? resolveColor(z?.color, i);
    const kind = z?.kind || "band";
    const invert = z?.cover === "outside" ? { invert: true } : {};
    if (kind === "quadrant") {
      if (zones.length + 4 > 15) {
        issues.push({ zone: label, message: "At most 15 zones are drawn (quadrants count as 4)." });
        return;
      }
      const xsRaw = n(z?.xSplit);
      const ysRaw = n(z?.ySplit);
      const xs = Number.isFinite(xsRaw) ? xsRaw : domain ? (domain.x0 + domain.x1) / 2 : NaN;
      const ys = Number.isFinite(ysRaw) ? ysRaw : domain ? (domain.y0 + domain.y1) / 2 : NaN;
      if (!Number.isFinite(xs) || !Number.isFinite(ys)) {
        issues.push({ zone: label, message: "Quadrant lines need an X and a Y value." });
        return;
      }
      quadrantRects(xs, ys, domain).forEach((b, q) => {
        const name = z?.[`q${q}Label`];
        zones.push({
          id: quadrantId(id, q),
          label: typeof name === "string" && name.trim() ? name : QUADRANT_DEFAULT_NAMES[q]!,
          color: resolveColor(z?.[`q${q}Color`], i + q),
          bounds: b,
        });
      });
      return;
    }
    if (kind === "circle") {
      const cx = n(z?.cx);
      const cy = n(z?.cy);
      const rx = Math.abs(n(z?.rx));
      const ry = Math.abs(n(z?.ry));
      if (![cx, cy, rx, ry].every(Number.isFinite) || rx === 0 || ry === 0) {
        issues.push({ zone: label, message: "A circle needs a centre and two radii above 0." });
        return;
      }
      zones.push({ id, label, color, ...invert, bounds: { polygon: circlePolygon(cx, cy, rx, ry) } });
      return;
    }
    if (kind === "polygon") {
      const polygon = points(z?.points);
      if (polygon.length < 3) {
        issues.push({ zone: label, message: "A polygon needs at least 3 valid points." });
        return;
      }
      zones.push({ id, label, color, ...invert, bounds: { polygon } });
      return;
    }
    const extend = { start: z?.extendStart === true, end: z?.extendEnd === true };
    if (kind === "line") {
      const line = points(z?.line);
      if (line.length < 2) {
        issues.push({ zone: label, message: "A line needs at least 2 valid points." });
        return;
      }
      zones.push({ id, label, color, ...invert, bounds: { line, side: z?.side === "below" ? "below" : "above", extend } });
      return;
    }
    if (kind === "envelope") {
      const upper = points(z?.upper);
      const lower = z?.mirror === false ? points(z?.lower) : upper.map(([x, y]) => [x, -y] as Pt);
      if (upper.length < 2 || lower.length < 2) {
        issues.push({ zone: label, message: "Envelope needs at least 2 valid points on each edge." });
        return;
      }
      zones.push({ id, label, color, ...invert, bounds: { upper, lower, extend } });
      return;
    }
    const y0 = n(z?.yMin);
    const y1 = n(z?.yMax);
    if (!Number.isFinite(y0) || !Number.isFinite(y1)) {
      issues.push({ zone: label, message: "Y min / Y max must be numbers." });
      return;
    }
    if (kind === "rect") {
      const x0 = n(z?.xMin);
      const x1 = n(z?.xMax);
      if ((!extend.start && !Number.isFinite(x0)) || (!extend.end && !Number.isFinite(x1)) || (!Number.isFinite(x0) && !Number.isFinite(x1))) {
        issues.push({ zone: label, message: "X min / X max must be numbers." });
        return;
      }
      zones.push({
        id,
        label,
        color,
        ...invert,
        bounds: {
          x: [extend.start ? -Infinity : Math.min(x0, x1), extend.end ? Infinity : Math.max(x0, x1)],
          y: [Math.min(y0, y1), Math.max(y0, y1)],
        },
      });
      return;
    }
    zones.push({ id, label, color, ...invert, bounds: { y: [Math.min(y0, y1), Math.max(y0, y1)] } });
  });
  return { zones, issues };
}
