/**
 * Point shapes by the 2nd dimension — the `props.shapes` property and its
 * mapping to the chart's `shapeBy`.
 *
 * Stored shape (property panel friendly, patchable):
 *   props.shapes = { enabled: boolean, map: [{ value: "Aurora Air", shape: "star" }, …] }
 * Values the map does not name take the chart's default cycle, in the order
 * the values first appear in the data (the same rule the chart applies).
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
  shape: DensityPointShape;
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
    if (!value || seen.has(value) || !isShape(shape)) continue;
    seen.add(value);
    map.push({ value, shape });
  }
  return { enabled: p.enabled === true, map };
}

/**
 * `shapeBy` for the chart, or nothing. The glyph column is the 3rd dimension
 * (`shape`) when there is one, else the 2nd (`category`, shared with colour).
 */
export function toShapeBy(raw: unknown, key: "category" | "shape" | null): DensityShapeBy | undefined {
  const { enabled, map } = readShapes(raw);
  if (!enabled || !key) return undefined;
  const shapes: Record<string, DensityPointShape> = {};
  for (const e of map) shapes[e.value] = e.shape;
  return { kind: "category", key, shapes };
}

/** Every value with the glyph it will get — for the shape key and the editor table. */
export function shapeEntries(labels: readonly string[], raw: unknown): DensityShapeEntry[] {
  const { map } = readShapes(raw);
  const shapes: Record<string, DensityPointShape> = {};
  for (const e of map) shapes[e.value] = e.shape;
  return dealShapes(labels, { shapes });
}
