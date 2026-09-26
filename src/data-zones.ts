/**
 * Layer C — zones from the data model. A session object (destroyed on unmount,
 * per the Qlik extension guidelines) reads a zone table and turns it into the
 * same raw zone shape the property panel produces, so one code path draws both.
 *
 * Zone table (one row per vertex):
 *   ZoneID · Label · Color (hex or palette index) · Edge (upper | lower | min | max) · Seq · X · Y
 *   - upper/lower rows (ordered by Seq) → an envelope; no lower rows → mirrored
 *   - min/max rows → a rectangle from the two corners; X empty → a horizontal band
 *   - point rows (ordered by Seq) → a polygon
 * Zones keep the load order of ZoneID (first match wins, inner → outer).
 */

export interface ZoneFieldMap {
  id?: string;
  label?: string;
  color?: string;
  edge?: string;
  seq?: string;
  x?: string;
  y?: string;
  /** Optional: "inside" (default) or "outside" per zone. */
  cover?: string;
  /** Optional: closed (default) | endless | endless-left | endless-right. */
  ends?: string;
}

export const ZONE_FIELD_KEYS: (keyof ZoneFieldMap)[] = ["id", "label", "color", "edge", "seq", "x", "y", "cover", "ends"];

const fieldDef = (f: string) => (f.trim().startsWith("=") ? f.trim() : `[${f.trim().replace(/^\[|\]$/g, "")}]`);

export function zoneCubeDef(fields: ZoneFieldMap) {
  return {
    qInfo: { qType: "qixHighDScatter-zones" },
    qHyperCubeDef: {
      qDimensions: ZONE_FIELD_KEYS.map((k) => ({
        qDef: {
          qFieldDefs: [fields[k] ? fieldDef(fields[k]!) : "=Null()"],
          qSortCriterias: [{ qSortByLoadOrder: 1 }],
        },
        qNullSuppression: false,
      })),
      qMeasures: [],
      qMode: "S",
      qSuppressMissing: true,
      qInitialDataFetch: [{ qWidth: 9, qHeight: 1100 }],
    },
  };
}

export function rowsToRawZones(matrix: any[][]): any[] {
  const order: string[] = [];
  const by = new Map<string, { label: string; color: any; cover: string; ends: string; side?: string; upper: any[]; lower: any[]; points: any[]; line: any[]; min?: any; max?: any }>();
  for (const row of matrix) {
    const [id, label, color, edge, seq, x, y, cover, ends] = row;
    const key = String(id?.qText ?? "");
    if (!key || key === "-") continue;
    let z = by.get(key);
    if (!z) {
      const c = color?.qText;
      const colorVal = c && /^#|^rgb/i.test(c) ? { index: -1, color: c } : Number.isFinite(color?.qNum) ? { index: color.qNum } : undefined;
      z = { label: String(label?.qText && label.qText !== "-" ? label.qText : key), color: colorVal, cover: String(cover?.qText ?? "").toLowerCase() === "outside" ? "outside" : "inside", ends: String(ends?.qText ?? "").toLowerCase(), upper: [], lower: [], points: [], line: [] };
      by.set(key, z);
      order.push(key);
    }
    const e = String(edge?.qText ?? "").toLowerCase();
    const pt = { x: x?.qNum, y: y?.qNum, s: Number.isFinite(seq?.qNum) ? seq.qNum : z.upper.length + z.lower.length };
    if (e === "upper") z.upper.push(pt);
    else if (e === "lower") z.lower.push(pt);
    else if (e === "point" || e === "vertex") z.points.push(pt);
    else if (e === "above" || e === "below") {
      z.line.push(pt);
      z.side = e;
    }
    else if (e === "min") z.min = pt;
    else if (e === "max") z.max = pt;
  }
  return order.map((key, i) => {
    const z = by.get(key)!;
    const base = {
      cId: `d:${key}`,
      label: z.label,
      show: true,
      color: z.color,
      cover: z.cover,
      extendStart: z.ends === "endless" || z.ends === "endless-left",
      extendEnd: z.ends === "endless" || z.ends === "endless-right",
    };
    const sort = (a: any[]) => a.sort((p, q) => p.s - q.s);
    if (z.points.length) return { ...base, kind: "polygon", points: sort(z.points) };
    if (z.line.length) return { ...base, kind: "line", side: z.side, line: sort(z.line) };
    if (z.upper.length) {
      return { ...base, kind: "envelope", mirror: z.lower.length === 0, upper: sort(z.upper), lower: sort(z.lower) };
    }
    const hasX = Number.isFinite(z.min?.x) && Number.isFinite(z.max?.x);
    return {
      ...base,
      kind: hasX ? "rect" : "band",
      xMin: z.min?.x,
      xMax: z.max?.x,
      yMin: z.min?.y,
      yMax: z.max?.y,
      _order: i,
    };
  });
}

/** Opens the session object, streams its rows, returns a disposer. */
export function watchZoneTable(app: any, fields: ZoneFieldMap, onZones: (raw: any[], error?: string) => void): () => void {
  let disposed = false;
  let model: any = null;
  const read = async () => {
    if (!model || disposed) return;
    try {
      const layout = await model.getLayout();
      if (disposed) return;
      const hc = layout.qHyperCube;
      if (hc?.qError) return onZones([], `Zone table error ${hc.qError.qErrorCode}`);
      const rows = hc?.qDataPages?.[0]?.qMatrix ?? [];
      onZones(rowsToRawZones(rows));
    } catch (e) {
      if (!disposed) onZones([], String((e as any)?.message ?? e));
    }
  };
  (async () => {
    try {
      model = await app.createSessionObject(zoneCubeDef(fields));
      if (disposed) {
        app.destroySessionObject?.(model.id);
        return;
      }
      model.on?.("changed", read);
      await read();
    } catch (e) {
      onZones([], String((e as any)?.message ?? e));
    }
  })();
  return () => {
    disposed = true;
    if (model) {
      model.removeListener?.("changed", read);
      app.destroySessionObject?.(model.id);
    }
  };
}
