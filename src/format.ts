/**
 * Axis / tooltip number formatting that follows the native Qlik charts:
 *
 * - "Auto" measures (qNumFormat qType "U", or no explicit pattern) get Qlik's
 *   abbreviations — 5k, 2.5M, 1G, 3T — with just enough decimals for the
 *   current tick step, so axes read "0 · 10M · 20M" instead of "20,000,000".
 * - Measures with an explicit number format keep its flavour: a percent
 *   pattern prints as a percent, a money pattern keeps its currency prefix /
 *   suffix, and the pattern's decimals are the minimum.
 *
 * The locale's grouping and decimal marks come from the app (qLocaleInfo)
 * when available, else from the browser.
 */

export interface LocaleMarks {
  decimal: string;
  thousand: string;
}

const UNITS: Array<[number, string]> = [
  [1e12, "T"],
  [1e9, "G"],
  [1e6, "M"],
  [1e3, "k"],
];

function decimalsFor(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const d = -Math.floor(Math.log10(step) + 1e-9);
  return Math.max(0, Math.min(6, d));
}

function group(intPart: string, sep: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

function fixed(v: number, maxDecimals: number, minDecimals: number, marks: LocaleMarks, grouping = true): string {
  const s = Math.abs(v).toFixed(maxDecimals);
  let [i, f = ""] = s.split(".");
  f = f.replace(/0+$/, "");
  while (f.length < minDecimals) f += "0";
  const out = (grouping ? group(i!, marks.thousand) : i!) + (f ? marks.decimal + f : "");
  return (v < 0 && Number(s) !== 0 ? "-" : "") + out;
}

interface Pattern {
  prefix: string;
  suffix: string;
  percent: boolean;
  decimals: number;
}

function parsePattern(fmt: string | undefined): Pattern | null {
  if (!fmt) return null;
  const pos = fmt.split(";")[0]!;
  const m = /[#0][#0,.\s']*/.exec(pos);
  if (!m) return null;
  const core = m[0];
  const prefix = pos.slice(0, m.index).trim();
  const suffix = pos.slice(m.index + core.length).trim();
  const dot = core.lastIndexOf(".");
  const decimals = dot >= 0 ? core.slice(dot + 1).replace(/[^0#]/g, "").length : 0;
  return { prefix, suffix: suffix.replace("%", "").trim(), percent: pos.includes("%"), decimals };
}

/**
 * `span` is the visible data span of the axis; `ticks` the approximate tick
 * count. Both only steer the precision.
 */
export function makeAxisFormatter(
  measureInfo: any,
  marks: LocaleMarks,
  span: number,
  ticks = 6,
): (v: number) => string {
  const nf = measureInfo?.qNumFormat;
  const explicit = nf && nf.qType && nf.qType !== "U" && nf.qFmt ? parsePattern(nf.qFmt) : null;
  const step = span / Math.max(1, ticks);

  if (explicit?.percent) {
    const d = Math.max(explicit.decimals, decimalsFor(step * 100));
    return (v) => `${explicit.prefix}${fixed(v * 100, d, 0, marks)}%${explicit.suffix ? " " + explicit.suffix : ""}`;
  }

  const affix = (s: string) =>
    explicit ? `${explicit.prefix}${s}${explicit.suffix ? (/^\W$/.test(explicit.suffix) ? "" : " ") + explicit.suffix : ""}` : s;

  return (v) => {
    if (!Number.isFinite(v)) return "";
    const a = Math.abs(v);
    // The unit is chosen per value (as Qlik does), the precision per step.
    const unit = UNITS.find(([u]) => a >= u);
    if (!unit) {
      const d = Math.max(explicit?.decimals ?? 0, Math.min(2, decimalsFor(step)));
      return affix(fixed(v, a < 1 && a > 0 ? Math.max(d, 2) : d, 0, marks));
    }
    const [u, sym] = unit;
    // Enough decimals that neighbouring ticks never print the same text, plus
    // one extra (capped) so tooltips keep useful precision.
    const d = Math.min(3, Math.max(decimalsFor(step / u), 0) + 1);
    return affix(fixed(v / u, d, 0, marks, false) + sym);
  };
}

/** The app's grouping / decimal marks (qLocaleInfo), falling back to the browser. */
export function localeMarks(localeInfo: any): LocaleMarks {
  if (localeInfo?.qDecimalSep) {
    return { decimal: localeInfo.qDecimalSep, thousand: localeInfo.qThousandSep ?? "," };
  }
  const parts = new Intl.NumberFormat().formatToParts(12345.6);
  return {
    decimal: parts.find((p) => p.type === "decimal")?.value ?? ".",
    thousand: parts.find((p) => p.type === "group")?.value ?? ",",
  };
}

/** Round a [lo, hi] extent outward to "nice" tick multiples, like Qlik's auto range. */
export function niceExtent(lo: number, hi: number, ticks = 6): [number, number] {
  if (!(hi > lo)) {
    const d = Math.abs(lo) || 1;
    return [lo - d / 2, hi + d / 2];
  }
  const raw = (hi - lo) / ticks;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / p;
  const step = (m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10) * p;
  let a = Math.floor(lo / step) * step;
  let b = Math.ceil(hi / step) * step;
  // Keep data off the frame: a point sitting exactly on the edge gets one step of air.
  if (lo - a < step * 0.02) a -= step;
  if (b - hi < step * 0.02) b += step;
  return [a, b];
}

/**
 * A Qlik colour expression result → a CSS colour, or `null`. Accepts what
 * colour functions and literals return as text: `RGB(r,g,b)`, `ARGB(a,r,g,b)`,
 * `#rrggbb` / `#rgb`, `rgb()/rgba()/hsl()` and CSS names; or the dual's number
 * (ARGB packed into an integer, as `RGB()`'s numeric value is).
 */
export function parseQlikColor(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    const n = value >>> 0;
    const a = (n >>> 24) & 255;
    const r = (n >>> 16) & 255;
    const g = (n >>> 8) & 255;
    const b = n & 255;
    return a && a < 255 ? `rgba(${r},${g},${b},${(a / 255).toFixed(3)})` : `rgb(${r},${g},${b})`;
  }
  if (typeof value !== "string") return null;
  const t = value.trim();
  if (!t) return null;
  const argb = /^argb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(t);
  if (argb) return `rgba(${argb[2]},${argb[3]},${argb[4]},${(Number(argb[1]) / 255).toFixed(3)})`;
  const rgb = /^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i.exec(t);
  if (rgb) return `rgb(${rgb[1]},${rgb[2]},${rgb[3]})`;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t)) return t;
  if (/^(rgba?|hsla?)\(/i.test(t)) return t;
  if (/^[a-z]+$/i.test(t) && typeof CSS !== "undefined" && CSS.supports?.("color", t)) return t;
  return null;
}
