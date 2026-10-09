/**
 * Colour by the colour dimension — the `props.colors` property and its mapping
 * to the chart's `colorBy.colors`.
 *
 * Stored (property panel friendly, patchable):
 *   props.colors = { scheme: "12" | "100", persistent: boolean, map: [{ value: "Aurora Air", color: "#c00" }, …] }
 *
 * `scheme` is the palette, as in a native Qlik chart's *Color scheme*: the
 * theme's "12 colors" (default) or "100 colors". With 12, values past the
 * twelfth repeat the palette; with 100, a hundred values get an ink of their own.
 *
 * Two independent things, both of which pin a class to an ink instead of the
 * slot its first-seen position in the data would give it:
 *
 * - `persistent`: every value takes the palette slot its NAME hashes to, so a
 *   value keeps its colour when a selection, a sort or a reload changes which
 *   values are present and in what order. Native Qlik charts call this
 *   "persistent colours"; like theirs, two names can hash to the same slot.
 * - `map`: a colour a user picked for a value (the Colors tab of the editor),
 *   which wins over the hash.
 *
 * Both only apply to `Color by = Dimension`. A fixed colour on the Shapes tab
 * (`props.shapes`, keyed on the SHAPE column) is a harder override still: it
 * beats every colouring, this one included.
 */

/** One value of the colour dimension with the colour a user pinned to it. */
export interface ColorMapEntry {
  value: string;
  color: string;
}

export type ColorScheme = "12" | "100";

export interface ColorsProps {
  scheme?: ColorScheme;
  persistent?: boolean;
  map?: ColorMapEntry[];
}

/** A usable CSS colour string (hex, rgb()/rgba(), hsl(), named), or nothing. */
export function cleanColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) || /^(rgba?|hsla?)\(/i.test(t) || /^[a-z]+$/i.test(t)) return t;
  return undefined;
}

/** The property, cleaned: usable colours only, one entry per value. */
export function readColors(raw: unknown): { scheme: ColorScheme; persistent: boolean; map: ColorMapEntry[] } {
  const p = (raw && typeof raw === "object" ? raw : {}) as ColorsProps;
  const seen = new Set<string>();
  const map: ColorMapEntry[] = [];
  for (const e of Array.isArray(p.map) ? p.map : []) {
    const value = String((e as any)?.value ?? "");
    const color = cleanColor((e as any)?.color);
    if (!value || !color || seen.has(value)) continue;
    seen.add(value);
    map.push({ value, color });
  }
  return { scheme: p.scheme === "100" ? "100" : "12", persistent: p.persistent === true, map };
}

/**
 * The palette slot a value's name hashes to — FNV-1a over the UTF-16 units,
 * which is stable across sessions, machines and app copies (what makes the
 * colour persistent). `slots` is how many palette entries the theme gives.
 */
export function stableSlot(value: string, slots: number): number {
  const n = Math.max(1, Math.floor(slots));
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % n;
}

/**
 * The ink a value of the colour dimension gets when nothing is pinned to it:
 * the slot its NAME hashes to while `persistent` is on, else the slot of its
 * position `k` in the data. Scheme 12 answers `var(--chart-N)` (the tokens
 * `theme.ts` fills from the app palette, so a theme flip re-colours without a
 * re-render); scheme 100 answers the colour itself.
 */
export function autoColor(
  label: string,
  k: number,
  scheme: ColorScheme,
  persistent: boolean,
  palettes: { palette: readonly string[]; palette100: readonly string[] },
): { slot: number; color: string; token?: string } {
  if (scheme === "100" && palettes.palette100.length) {
    const n = palettes.palette100.length;
    const slot = persistent ? stableSlot(label, n) : k % n;
    return { slot, color: palettes.palette100[slot]! };
  }
  // Only the first 12 palette entries have a `--chart-N` token (theme.ts).
  const n = Math.max(1, Math.min(palettes.palette.length || 0, 12));
  const slot = persistent ? stableSlot(label, n) : k % n;
  return { slot, color: palettes.palette[slot] ?? "#4477aa", token: `var(--chart-${slot + 1})` };
}

/** Most values a scheme colours on their own (the rest share "Other"). */
export function schemeClasses(raw: unknown): number {
  return readColors(raw).scheme === "100" ? 100 : 12;
}

/**
 * `colorBy.colors` for the chart: the automatic ink of every value when
 * `persistent` is on or the scheme is 100 (the chart only knows the twelve
 * series tokens), with the user's pinned colours over the top. `undefined`
 * when nothing needs saying.
 */
export function categoryColors(
  labels: readonly string[] | undefined,
  raw: unknown,
  palettes: { palette: readonly string[]; palette100: readonly string[] },
): Record<string, string> | undefined {
  const { scheme, persistent, map } = readColors(raw);
  if (!persistent && scheme === "12" && !map.length) return undefined;
  const colors: Record<string, string> = {};
  if (persistent || scheme === "100")
    (labels ?? []).forEach((label, k) => {
      const a = autoColor(label, k, scheme, persistent, palettes);
      colors[label] = a.token ?? a.color;
    });
  for (const e of map) colors[e.value] = e.color;
  return Object.keys(colors).length ? colors : undefined;
}
