/**
 * Qlik app theme → brand-ui tokens (decision D6: the extension looks like the app).
 * Everything goes through `useTheme()`; every lookup is guarded because the theme
 * API surface differs between Qlik Cloud and older client-managed releases.
 */

export interface QhdsTheme {
  vars: Record<string, string>;
  dark: boolean;
  /** The theme's "12 colors" palette (the `--chart-N` tokens). */
  palette: string[];
  /** The theme's "100 colors" palette — generated from `palette` when the theme has none. */
  palette100: string[];
  fontFamily: string;
  resolveColor: (c: any, fallbackIndex: number) => string;
}

const HEX = /^#|^rgb|^hsl|^oklch/i;

function safe<T>(fn: () => T, fallback: T): T {
  try {
    const v = fn();
    return v === undefined || v === null || v === "" ? fallback : v;
  } catch {
    return fallback;
  }
}

const DEFAULT_PALETTE = [
  "#4477aa", "#7db8da", "#b6d7ea", "#46c646", "#f93f17", "#ffcf02",
  "#276e27", "#b0afae", "#7b7a78", "#545352", "#8e477d", "#d6a6c3",
];

function luminance(color: string): number | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!m) return null;
  const v = parseInt(m[1]!, 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((u) => {
    const s = u / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
}

/**
 * `n` colours from a short palette, for a theme without a 100-colour one: the
 * palette itself, then its hues again, lighter and darker by turns.
 */
export function extendPalette(base: readonly string[], n: number): string[] {
  const rgb = base
    .map((c) => /^#?([0-9a-f]{6})$/i.exec(c.trim()))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => parseInt(m[1]!, 16))
    .map((v) => [(v >> 16) & 255, (v >> 8) & 255, v & 255]);
  if (!rgb.length) return [...base];
  const out: string[] = [];
  const hex = (c: number[]) => "#" + c.map((u) => Math.round(u).toString(16).padStart(2, "0")).join("");
  for (let round = 0; out.length < n; round++) {
    // round 0: as is; then toward white and toward black by turns, a bit further each pair.
    const step = Math.ceil(round / 2);
    const t = 1 - 0.7 ** step;
    const to = round % 2 ? 255 : 0;
    for (const c of rgb) {
      if (out.length >= n) break;
      out.push(round === 0 ? hex(c) : hex(c.map((u) => u + (to - u) * t)));
    }
  }
  return out;
}

let latest: { palette: string[]; palette100: string[] } = {
  palette: DEFAULT_PALETTE,
  palette100: extendPalette(DEFAULT_PALETTE, 100),
};

/** The palettes of the theme a chart last rendered with — for the property panel's Color scheme list. */
export function latestPalettes(): { palette: string[]; palette100: string[] } {
  return latest;
}

export function mapTheme(theme: any): QhdsTheme {
  const style = (base: string, path: string, attr: string) => safe<string>(() => theme?.getStyle?.(base, path, attr), "");

  const palettes: any[] = safe(() => theme.getDataColorPalettes(), []) || [];
  const pickerPalettes: any[] = safe(() => theme.getDataColorPickerPalettes(), []) || [];
  const fromPalette = (p: any): string[] => {
    const colors = Array.isArray(p?.colors?.[0]) ? p.colors[p.colors.length - 1] : p?.colors;
    return (colors || []).filter((c: unknown) => typeof c === "string" && HEX.test(c));
  };
  // Qlik themes ship two data palettes, keyed like a native chart's
  // `color.dimensionScheme`: "12" (12 colors, a pyramid) and "100" (100 colors,
  // a row). Themes that do not key them: the big one is the 100.
  const keyOf = (p: any) => String(p?.key ?? p?.propertyValue ?? p?.name ?? "");
  const big = (p: any) => fromPalette(p).length >= 50;
  const p100 = palettes.find((p) => /^100\b/.test(keyOf(p))) ?? palettes.find(big);
  const p12 =
    palettes.find((p) => /^12\b/.test(keyOf(p))) ??
    palettes.find((p) => p !== p100 && p?.type === "row") ??
    palettes.find((p) => p !== p100);
  let palette = fromPalette(p12 ?? palettes[0]);
  if (palette.length < 3) palette = fromPalette(pickerPalettes[0]);
  if (palette.length < 3) palette = DEFAULT_PALETTE;
  let palette100 = p100 ? fromPalette(p100) : [];
  if (palette100.length < 50) palette100 = extendPalette(palette, 100);

  const background = style("object", "", "backgroundColor");
  const text = style("object", "", "color") || "#404040";
  const axisLabel = style("object.axis", "label.name", "color") || text;
  const axisTitle = style("object.axis", "title", "color") || text;
  // Qlik themes: object.grid.line.major (gridlines), object.axis.line.major (axis line).
  // getStyle falls back to ancestor `color` when a path is missing — treat that as missing.
  const pick = (v: string, fb: string) => (!v || v === text ? fb : v);
  const isDarkApi = safe<boolean | null>(() => theme?.background?.isDark ?? null, null);
  const lum = background ? luminance(background) : null;
  const textLum = luminance(text);
  // Themes with a transparent object background: judge by the text colour.
  const dark = isDarkApi ?? (lum !== null ? lum < 0.3 : textLum !== null ? textLum > 0.45 : false);
  const bgDarkGuess = dark;
  const grid = pick(style("object.grid", "line.major", "color"), bgDarkGuess ? "#3d3d3d" : "#e6e6e6");
  const axisLine = pick(style("object.axis", "line.major", "color"), bgDarkGuess ? "#666666" : "#cccccc");
  const fontFamily = style("", "", "fontFamily") || "'Source Sans Pro', 'Source Sans 3', Arial, sans-serif";
  const specials = safe<any>(() => theme.getDataColorSpecials(), {});
  const primary = typeof specials?.primary === "string" ? specials.primary : palette[0]!;

  const vars: Record<string, string> = {
    "--font-sans": fontFamily,
    "--foreground": text,
    "--muted-foreground": axisLabel,
    "--card-foreground": text,
    "--popover-foreground": text,
    "--border": grid,
    "--chart-grid": grid,
    "--chart-axis-line": axisLine,
    "--chart-axis": axisTitle,
    "--primary": primary,
  };
  if (background && background !== "transparent") {
    vars["--background"] = background;
    vars["--card"] = background;
  } else {
    vars["--background"] = "transparent";
    vars["--card"] = dark ? "#262626" : "#ffffff";
  }
  // Surfaces the chart chrome sits on (tooltip, toolbar, zone tags).
  vars["--popover"] = vars["--card"]!;
  vars["--muted"] = dark ? "#333333" : "#f2f2f2";
  vars["--secondary"] = vars["--muted"]!;
  vars["--accent"] = dark ? "#3d3d3d" : "#e8e8e8";
  vars["--accent-foreground"] = text;
  vars["--secondary-foreground"] = text;
  palette.slice(0, 12).forEach((c, i) => {
    vars[`--chart-${i + 1}`] = c;
  });

  const resolveColor = (c: any, fallbackIndex: number): string => {
    if (typeof c === "string" && HEX.test(c)) return c;
    if (c && typeof c === "object") {
      if (typeof c.color === "string" && HEX.test(c.color) && (c.index === -1 || c.index === "-1" || c.index == null)) return c.color;
      const viaApi = safe<string>(() => theme.getColorPickerColor(c), "");
      if (HEX.test(viaApi)) return viaApi;
      if (typeof c.color === "string" && HEX.test(c.color)) return c.color;
    }
    return palette[fallbackIndex % palette.length]!;
  };

  latest = { palette, palette100 };
  return { vars, dark, palette, palette100, fontFamily, resolveColor };
}
