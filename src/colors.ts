/**
 * Colour by the colour dimension — the `props.colors` property and its mapping
 * to the chart's `colorBy.colors`.
 *
 * Stored (property panel friendly, patchable):
 *   props.colors = { persistent: boolean, map: [{ value: "Aurora Air", color: "#c00" }, …] }
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

export interface ColorsProps {
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
export function readColors(raw: unknown): { persistent: boolean; map: ColorMapEntry[] } {
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
  return { persistent: p.persistent === true, map };
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
 * `colorBy.colors` for the chart: the hash slot of every value when
 * `persistent` is on, with the user's pinned colours over the top. Slots go out
 * as `var(--chart-N)` (the tokens `theme.ts` fills from the app palette), so a
 * theme flip re-colours without a re-render. `undefined` when nothing is pinned.
 */
export function categoryColors(
  labels: readonly string[] | undefined,
  raw: unknown,
  paletteSize: number,
): Record<string, string> | undefined {
  const { persistent, map } = readColors(raw);
  if (!persistent && !map.length) return undefined;
  const colors: Record<string, string> = {};
  // Only the first 12 palette entries have a `--chart-N` token (theme.ts).
  const slots = Math.max(1, Math.min(paletteSize || 0, 12));
  if (persistent) for (const label of labels ?? []) colors[label] = `var(--chart-${stableSlot(label, slots) + 1})`;
  for (const e of map) colors[e.value] = e.color;
  return Object.keys(colors).length ? colors : undefined;
}
