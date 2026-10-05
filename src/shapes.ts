/**
 * Point shapes by the 2nd dimension — the `props.shapes` property and its
 * mapping to the chart's `shapeBy`.
 *
 * Stored shape (property panel friendly, patchable):
 *   props.shapes = { enabled: boolean, map: [{ value: "Aurora Air", shape: "star", color: "#c00" }, …] }
 * Values the map does not name take the chart's default cycle, in the order
 * the values first appear in the data (the same rule the chart applies). A
 * `color` is a hard-set ink for the value: it overrides every other colouring
 * (zone, dimension, measure) for those points; an entry may carry a colour
 * alone (glyph stays automatic) or a glyph alone.
 */
import {
  DENSITY_SHAPES,
  dealShapes,
  type DensityPointShape,
  type DensityShapeBy,
  type DensityShapeEntry,
} from "@elabs-ai/components-charts";

export interface ShapeMapEntry {
  value: string;
  shape?: DensityPointShape;
  /** Fixed colour (CSS), overriding the chart's colouring for this value. */
  color?: string;
}

export interface ShapesProps {
  enabled?: boolean;
  map?: ShapeMapEntry[];
}

export const SHAPE_LABEL: Record<DensityPointShape, string> = {
  circle: "Circle",
  square: "Square",
  diamond: "Diamond",
  triangle: "Triangle up",
  "triangle-down": "Triangle down",
  plus: "Plus",
  minus: "Minus",
  cross: "Cross",
  star: "Star",
  hexagon: "Hexagon",
};

export const ALL_SHAPES: readonly DensityPointShape[] = DENSITY_SHAPES;

export function isShape(v: unknown): v is DensityPointShape {
  return typeof v === "string" && (DENSITY_SHAPES as readonly string[]).includes(v);
}

/** The property, cleaned: only known shapes, one entry per value. */
export function readShapes(raw: unknown): { enabled: boolean; map: ShapeMapEntry[] } {
  const p = (raw && typeof raw === "object" ? raw : {}) as ShapesProps;
  const seen = new Set<string>();
  const map: ShapeMapEntry[] = [];
  for (const e of Array.isArray(p.map) ? p.map : []) {
    const value = String((e as any)?.value ?? "");
    const shape = (e as any)?.shape;
    const color = cleanColor((e as any)?.color);
    const hasShape = isShape(shape);
    if (!value || seen.has(value) || (!hasShape && !color)) continue;
    seen.add(value);
    map.push({ value, ...(hasShape ? { shape } : {}), ...(color ? { color } : {}) });
  }
  return { enabled: p.enabled === true, map };
}

/** A usable CSS colour string (hex, rgb()/rgba(), hsl(), named), or nothing. */
export function cleanColor(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(t) || /^(rgba?|hsla?)\(/i.test(t) || /^[a-z]+$/i.test(t)) return t;
  return undefined;
}

/** Value → fixed colour, for the chart's `shapeBy.colors`. */
export function fixedColors(map: readonly ShapeMapEntry[]): Record<string, string> {
  const colors: Record<string, string> = {};
  for (const e of map) if (e.color) colors[e.value] = e.color;
  return colors;
}

/**
 * `shapeBy` for the chart, or nothing. The glyph column is the 3rd dimension
 * (`shape`) when there is one, else the 2nd (`category`, shared with colour).
 */
export function toShapeBy(raw: unknown, key: "category" | "shape" | null): DensityShapeBy | undefined {
  const { enabled, map } = readShapes(raw);
  if (!enabled || !key) return undefined;
  const shapes: Record<string, DensityPointShape> = {};
  for (const e of map) if (e.shape) shapes[e.value] = e.shape;
  const colors = fixedColors(map);
  return { kind: "category", key, shapes, ...(Object.keys(colors).length ? { colors } : {}) };
}

/** Every value with the glyph it will get — for the shape key and the editor table. */
export function shapeEntries(labels: readonly string[], raw: unknown): DensityShapeEntry[] {
  const { map } = readShapes(raw);
  const shapes: Record<string, DensityPointShape> = {};
  for (const e of map) if (e.shape) shapes[e.value] = e.shape;
  return dealShapes(labels, { shapes, colors: fixedColors(map) });
}
