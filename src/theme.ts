/**
 * Qlik app theme → brand-ui tokens (decision D6: the extension looks like the app).
 * Everything goes through `useTheme()`; every lookup is guarded because the theme
 * API surface differs between Qlik Cloud and older client-managed releases.
 */

export interface QhdsTheme {
  vars: Record<string, string>;
  dark: boolean;
  palette: string[];
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

export function mapTheme(theme: any): QhdsTheme {
  const style = (base: string, path: string, attr: string) => safe<string>(() => theme?.getStyle?.(base, path, attr), "");

  const palettes: any[] = safe(() => theme.getDataColorPalettes(), []) || [];
  const pickerPalettes: any[] = safe(() => theme.getDataColorPickerPalettes(), []) || [];
  const fromPalette = (p: any): string[] => {
    const colors = Array.isArray(p?.colors?.[0]) ? p.colors[p.colors.length - 1] : p?.colors;
    return (colors || []).filter((c: unknown) => typeof c === "string" && HEX.test(c));
  };
  let palette = fromPalette(palettes.find((p) => p?.type === "row") ?? palettes[0]);
  if (palette.length < 3) palette = fromPalette(pickerPalettes[0]);
  if (palette.length < 3) palette = DEFAULT_PALETTE;

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

  return { vars, dark, palette, fontFamily, resolveColor };
}
