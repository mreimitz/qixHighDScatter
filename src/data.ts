/**
 * Straight-cube paging into typed arrays (decision D1: plain paging, kept simple).
 * 10,000 cells per request is the engine's hard limit; pages run a few at a time
 * and every finished page is published so the chart fills progressively.
 */

export interface QhdsColumns {
  x: Float32Array;
  y: Float32Array;
  values?: Record<string, Float32Array>;
  categories?: Record<string, { codes: Uint16Array; labels: string[]; elems: number[] }>;
  /** qElemNumber of the point dimension per row (tap-to-select). */
  elems: Int32Array;
  /** qText of the point dimension per row (tooltip title). */
  labels: string[];
  /** 1 where the point-dimension value is selected (qState "S"). */
  selected: Uint8Array;
  /** Rows written so far (a prefix of the arrays). */
  n: number;
  total: number;
  done: boolean;
  /** Packed transport: "calc" while the engine builds the cube, then "transfer". */
  phase?: "calc" | "transfer";
}

/** The engine's hard limit per NxPage; a CALL may carry many pages. */
const CELLS_PER_PAGE = 10000;
/**
 * Pages per `getHyperCubeData` call. Measured on Qlik Cloud 2026-10: the 10k-cell
 * limit is per CALL (20 pages → "The hypercube results are too large"), so one.
 */
const PAGES_PER_CALL = 1;
const CONCURRENCY = 6;
/** Test hook: `window.__qhdsFetch = { pagesPerCall, concurrency }` overrides the defaults. */
function fetchTuning(): { pagesPerCall: number; concurrency: number } {
  const o = typeof window !== "undefined" ? (window as any).__qhdsFetch : null;
  return {
    pagesPerCall: Math.max(1, Number(o?.pagesPerCall) || PAGES_PER_CALL),
    concurrency: Math.max(1, Number(o?.concurrency) || CONCURRENCY),
  };
}

function num(cell: any): number {
  const v = cell?.qNum;
  return typeof v === "number" ? v : NaN;
}

/**
 * The engine cancels a page request when an "exclusive" request for the same
 * object arrives (a selection, a property patch, a calc): "Request aborted
 * (Exclusive request aborted family requests)", error code 15. That is not a
 * failure of the data — the page is simply asked for again, a little later.
 */
function isAbort(e: unknown): boolean {
  const code = (e as any)?.code;
  const msg = String((e as any)?.message ?? (e as any)?.parameter ?? e ?? "");
  return code === 15 || /aborted/i.test(msg);
}

async function withRetry<T>(call: () => Promise<T>, cancelled: () => boolean, attempts = 6): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (e) {
      if (cancelled() || !isAbort(e) || attempt >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, 120 * (attempt + 1)));
    }
  }
}

export interface FetchHandle {
  cancel(): void;
}

/**
 * Pages `/qHyperCubeDef` in parallel. `onProgress` receives the same (growing)
 * column object every time pages land; `n` only moves forward in row order so
 * the prefix is always contiguous.
 */
/**
 * Measure roles, as in the native scatter: X, Y, then an optional Size and an
 * optional colour measure. `legacyColor3`: an object made before the Size role
 * existed (colour by measure with exactly three measures) keeps the third as colour.
 */
export function fetchAllRows(
  model: any,
  hc: any,
  maxPoints: number,
  legacyColor3: boolean,
  onProgress: (cols: QhdsColumns) => void,
  onError: (err: unknown) => void,
  options: { concurrency?: number } = {},
): FetchHandle {
  let cancelled = false;
  const nDims: number = hc.qDimensionInfo.length;
  const nMeas: number = hc.qMeasureInfo.length;
  const width: number = nDims + nMeas;
  const total = Math.min(hc.qSize.qcy, maxPoints);
  const pageH = Math.max(1, Math.floor(CELLS_PER_PAGE / width));
  const pages = Math.ceil(total / pageH);

  const xCol = nDims; // first measure
  const yCol = nDims + 1;
  const sCol = nMeas >= 3 && !legacyColor3 ? nDims + 2 : -1;
  const vCol = legacyColor3 ? nDims + 2 : nMeas >= 4 ? nDims + 3 : -1;
  const cCol = nDims >= 2 ? 1 : -1;
  const shCol = nDims >= 3 ? 2 : -1;

  const cols: QhdsColumns = {
    x: new Float32Array(total),
    y: new Float32Array(total),
    elems: new Int32Array(total),
    labels: new Array<string>(total),
    selected: new Uint8Array(total),
    n: 0,
    total,
    done: total === 0,
  };
  if (vCol >= 0 || sCol >= 0) cols.values = {};
  if (vCol >= 0) cols.values!.value = new Float32Array(total);
  if (sCol >= 0) cols.values!.size = new Float32Array(total);
  // Categorical columns: the 2nd dimension ("category", colour) and the 3rd ("shape").
  const makeCat = () => ({ labels: [] as string[], elems: [] as number[], index: new Map<string, number>(), codes: new Uint16Array(total) });
  const cat = cCol >= 0 ? makeCat() : null;
  const shp = shCol >= 0 ? makeCat() : null;
  if (cat || shp) cols.categories = {};
  if (cat) cols.categories!.category = { codes: cat.codes, labels: cat.labels, elems: cat.elems };
  if (shp) cols.categories!.shape = { codes: shp.codes, labels: shp.labels, elems: shp.elems };
  const catCodes = cat?.codes ?? null;
  const encode = (k: ReturnType<typeof makeCat>, cell: any): number => {
    const t = String(cell?.qText ?? "");
    let i = k.index.get(t);
    if (i === undefined) {
      i = k.labels.length;
      k.index.set(t, i);
      k.labels.push(t);
      k.elems.push(Number(cell?.qElemNumber ?? -1));
    }
    return i;
  };

  // Rows whose x/y are not numbers are dropped; we compact per page into a
  // staging area, then commit pages strictly in order.
  const staged: Array<
    | { rows: number; x: Float32Array; y: Float32Array; e: Int32Array; t: string[]; st: Uint8Array; v?: Float32Array; sz?: Float32Array; c?: Uint16Array; sh?: Uint16Array }
    | undefined
  > = new Array(pages);
  let committedPage = 0;

  const commit = () => {
    let changed = false;
    while (committedPage < pages && staged[committedPage]) {
      const s = staged[committedPage]!;
      cols.x.set(s.x.subarray(0, s.rows), cols.n);
      cols.y.set(s.y.subarray(0, s.rows), cols.n);
      cols.elems.set(s.e.subarray(0, s.rows), cols.n);
      cols.selected.set(s.st.subarray(0, s.rows), cols.n);
      for (let i = 0; i < s.rows; i++) cols.labels[cols.n + i] = s.t[i]!;
      if (s.v && cols.values) cols.values.value!.set(s.v.subarray(0, s.rows), cols.n);
      if (s.sz && cols.values) cols.values.size!.set(s.sz.subarray(0, s.rows), cols.n);
      if (s.c && catCodes) catCodes.set(s.c.subarray(0, s.rows), cols.n);
      if (s.sh && shp) shp.codes.set(s.sh.subarray(0, s.rows), cols.n);
      cols.n += s.rows;
      staged[committedPage] = undefined;
      committedPage++;
      changed = true;
    }
    if (committedPage === pages) cols.done = true;
    if (changed || cols.done) onProgress(cols);
  };

  const tuning = fetchTuning();
  const pagesPerCall = tuning.pagesPerCall;
  const concurrency = options.concurrency ?? tuning.concurrency;
  // Telemetry (window.__qhdsPerf): where the loading time goes.
  const perf = { t0: performance.now(), pages, pageH, width, total, pagesPerCall, concurrency, calls: 0, waitMs: 0, jsMs: 0, cells: 0, firstPageMs: 0 };
  let next = 0;
  const processPage = (p: number, matrix: any[][]) => {
      perf.cells += matrix.length * width;
      const x = new Float32Array(matrix.length);
      const y = new Float32Array(matrix.length);
      const v = vCol >= 0 ? new Float32Array(matrix.length) : undefined;
      const sz = sCol >= 0 ? new Float32Array(matrix.length) : undefined;
      const e = new Int32Array(matrix.length);
      const t: string[] = new Array(matrix.length);
      const st = new Uint8Array(matrix.length);
      const c = cCol >= 0 ? new Uint16Array(matrix.length) : undefined;
      const sh = shCol >= 0 ? new Uint16Array(matrix.length) : undefined;
      let rows = 0;
      for (const row of matrix) {
        const px = num(row[xCol]);
        const py = num(row[yCol]);
        if (!Number.isFinite(px) || !Number.isFinite(py)) continue;
        x[rows] = px;
        y[rows] = py;
        if (v) v[rows] = num(row[vCol]);
        if (sz) sz[rows] = num(row[sCol]);
        e[rows] = Number(row[0]?.qElemNumber ?? -1);
        t[rows] = String(row[0]?.qText ?? "");
        st[rows] = row[0]?.qState === "S" ? 1 : 0;
        if (c && cat) c[rows] = encode(cat, row[cCol]);
        if (sh && shp) sh[rows] = encode(shp, row[shCol]);
        rows++;
      }
      staged[p] = { rows, x, y, e, t, st, v, sz, c, sh };
  };
  const worker = async (): Promise<void> => {
    while (!cancelled && next < pages) {
      const first = next;
      next = Math.min(pages, next + pagesPerCall);
      const req = [];
      for (let p = first; p < next; p++) {
        const qTop = p * pageH;
        req.push({ qTop, qLeft: 0, qWidth: width, qHeight: Math.min(pageH, total - qTop) });
      }
      const tReq = performance.now();
      const res: any[] = await withRetry(() => model.getHyperCubeData("/qHyperCubeDef", req), () => cancelled);
      const tGot = performance.now();
      perf.calls++;
      perf.waitMs += tGot - tReq;
      if (!perf.firstPageMs) perf.firstPageMs = tGot - perf.t0;
      if (cancelled) return;
      for (let i = 0; i < req.length; i++) processPage(first + i, res?.[i]?.qMatrix ?? []);
      commit();
      perf.jsMs += performance.now() - tGot;
      if (cols.done) {
        const totalMs = performance.now() - perf.t0;
        const w = window as any;
        (w.__qhdsPerf ??= {}).load = { ...perf, totalMs };
        // eslint-disable-next-line no-console
        console.info(`[qixHighDScatter] loaded ${cols.n.toLocaleString()} rows in ${(totalMs / 1000).toFixed(1)}s — ${perf.calls} calls × ${pagesPerCall} pages × ${pageH} rows (${width} cols), ${concurrency} in flight, first data ${(perf.firstPageMs / 1000).toFixed(1)}s, engine wait ${(perf.waitMs / 1000).toFixed(1)}s summed, JS ${(perf.jsMs / 1000).toFixed(1)}s`);
      }
    }
  };

  // Experiment (window.__qhdsFetch.mode = "export"): time the engine's CSV export of the
  // same cube — one streamed file instead of hundreds of 10k-cell pages. Measures only;
  // the points still come through the pages below.
  if (typeof window !== "undefined" && (window as any).__qhdsFetch?.mode === "export" && total > 0) {
    void (async () => {
      const t0 = performance.now();
      try {
        const r = await model.exportData("CSV_C", "/qHyperCubeDef", "", "A");
        const t1 = performance.now();
        const url: string = r?.qUrl ?? r;
        const resp = await fetch(url, { credentials: "include" });
        const text = await resp.text();
        const t2 = performance.now();
        let lines = 0;
        for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
        // eslint-disable-next-line no-console
        console.info(`[qixHighDScatter] EXPORT experiment: exportData ${((t1 - t0) / 1000).toFixed(1)}s, fetch ${((t2 - t1) / 1000).toFixed(1)}s, ${(text.length / 1e6).toFixed(1)} MB, ${lines.toLocaleString()} lines, warnings ${JSON.stringify(r?.qWarnings ?? null)}, url ${url}, head ${JSON.stringify(text.slice(0, 160))}`);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(`[qixHighDScatter] EXPORT experiment failed after ${((performance.now() - t0) / 1000).toFixed(1)}s`, e);
      }
    })();
  }

  if (total === 0) {
    queueMicrotask(() => !cancelled && onProgress(cols));
  } else {
    Promise.all(Array.from({ length: Math.min(concurrency, pages) }, worker)).catch((e) => {
      if (!cancelled) onError(e);
    });
  }

  return {
    cancel() {
      cancelled = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Packed transport. Measured on Qlik Cloud (1M points, 2026-10): the plain
// cube costs ~62 bytes per CELL on the wire and the link saturates at
// 10–15 MB/s, so 1M rows × 3 columns = 190 MB = 20 s whatever the paging.
// A session cube whose one measure concatenates "id⇥x⇥y" per point (bucketed
// by a hash of the id so a cell holds ~1000 points) moves the same points in
// ~25 MB; the engine needs 4–7 s to build it, the transfer ~1.5 s.
// ---------------------------------------------------------------------------

const FIELD_SEP = "\t"; // Chr(9)
const RECORD_SEP = "\n"; // Chr(10)
/** Target bytes per response; the engine refuses "too large" responses (code 6001). */
const PACKED_RESPONSE_BYTES = 1.5e6;
const PACKED_CONCURRENCY = 8;

export interface PackedPlan {
  /** Session-object definition for the packed cube. */
  def: any;
  /** Columns carried per point after id, x, y. */
  size: boolean;
  value: boolean;
  category: boolean;
  /** The 2nd dimension's field (for element numbers of legend clicks). */
  catField: string | null;
  /** The 3rd dimension (shape by), carried as another categorical column. */
  shape: boolean;
  shapeField: string | null;
  /** Human-readable summary for telemetry. */
  info: string;
  /** One data row per point: x/y never change with selections, only the set of points does. */
  rowLevel: boolean;
  /** Session-object definition listing the possible point ids (same buckets, ids only). */
  idDef: any;
}

function stripEq(e: string): string {
  const s = String(e ?? "").trim();
  return s.startsWith("=") ? s.slice(1).trim() : s;
}

function bracket(field: string): string {
  const f = field.trim();
  return f.startsWith("[") && f.endsWith("]") ? f : `[${f.replace(/]/g, "]]")}]`;
}

/** Field name of a plain (non-calculated) dimension, resolving library dimensions. */
async function dimField(app: any, d: any): Promise<string | null> {
  let defs: unknown = d?.qDef?.qFieldDefs;
  if (d?.qLibraryId) {
    try {
      const lay = await (await app.getDimension(d.qLibraryId)).getLayout();
      defs = lay?.qDim?.qFieldDefs;
    } catch {
      return null;
    }
  }
  const f = Array.isArray(defs) ? defs[0] : undefined;
  if (typeof f !== "string" || !f.trim() || f.trim().startsWith("=")) return null;
  if (Array.isArray(defs) && defs.length > 1) return null; // drill-down group
  return f.trim();
}

/** Expression of a measure, resolving library measures. */
async function measureExpr(app: any, m: any): Promise<string | null> {
  let e: unknown = m?.qDef?.qDef;
  if (m?.qLibraryId) {
    try {
      const lay = await (await app.getMeasure(m.qLibraryId)).getLayout();
      e = lay?.qMeasure?.qDef;
    } catch {
      return null;
    }
  }
  const s = typeof e === "string" ? stripEq(e) : "";
  return s ? s : null;
}

/** Number format resolving 1e-6 of the measure's range (plenty for a 1000× zoom; the engine's Concat cost is per byte). */
function numFormat(info: any): string {
  const lo = Number(info?.qMin);
  const hi = Number(info?.qMax);
  const span = Number.isFinite(lo) && Number.isFinite(hi) ? Math.abs(hi - lo) : 0;
  const decimals = span > 0 ? Math.min(12, Math.max(0, Math.ceil(6 - Math.log10(span)))) : 6;
  return decimals ? `0.${"#".repeat(decimals)}` : "0";
}

/** `Agg(Field)` → Field, for the row-level shortcut. */
function singleFieldAgg(expr: string): string | null {
  const m = /^\s*(?:Avg|Sum|Only|Min|Max)\s*\(\s*(\[[^\]]+\]|[A-Za-z_][\w.]*)\s*\)\s*$/i.exec(expr);
  return m ? m[1]! : null;
}

/**
 * The packed plan for this object's cube, or null when the cube cannot be
 * packed (calculated or drill-down dimensions, more than 2 dimensions, …).
 * `rowLevel`: the point dimension is unique per data row AND every measure is
 * a single-field aggregation, so the engine can skip the Aggr (≈ 2 s at 1M).
 */
/** The object's properties as the engine evaluates them (soft patches included). */
export async function effectiveProps(model: any): Promise<any> {
  try {
    const eff = await model.getEffectiveProperties?.();
    if (eff?.qHyperCubeDef) return eff;
  } catch {
    /* fall through */
  }
  return model.getProperties();
}

const AGGREGATION =
  /\b(sum|avg|count|min|max|only|mode|median|fractile|fractileexc|stdev|sterr|skew|kurtosis|var|concat|firstsortedvalue|aggr|maxstring|minstring|firstvalue|lastvalue|correl|linest_\w+|numericcount|textcount|nullcount|missingcount|irr|npv|xirr|xnpv|chi2test_\w+|ttest\w*|ztest\w*)\s*\(/i;

/**
 * Range selections (ranges, lasso, zones) only work on AGGREGATED measures: the
 * engine answers `RangeSelectHyperCubeValues` with `false` for a bare field
 * such as `[XCG]`, and nebula then clears the selection. A bare expression is
 * wrapped in `Only(…)` — exact for one row per point — as a SOFT patch: this
 * session only, the saved object is untouched, the title stays the field's.
 * Returns true when something was patched (the layout changes once).
 */
export async function ensureAggregatedMeasures(model: any): Promise<boolean> {
  const eff = await effectiveProps(model);
  const measures: any[] = eff?.qHyperCubeDef?.qMeasures ?? [];
  const patches: Array<{ qOp: string; qPath: string; qValue: string }> = [];
  measures.forEach((m, i) => {
    if (m?.qLibraryId) return; // a master measure's expression is not ours to touch
    const raw = typeof m?.qDef?.qDef === "string" ? m.qDef.qDef : "";
    const expr = stripEq(raw);
    if (!expr || AGGREGATION.test(expr)) return;
    patches.push({ qOp: "replace", qPath: `/qHyperCubeDef/qMeasures/${i}/qDef/qDef`, qValue: JSON.stringify(`Only(${expr})`) });
    const label = typeof m?.qDef?.qLabel === "string" ? m.qDef.qLabel : "";
    const labelExpr = typeof m?.qDef?.qLabelExpression === "string" ? m.qDef.qLabelExpression : "";
    if (!label && !labelExpr)
      patches.push({ qOp: m?.qDef?.qLabel === undefined ? "add" : "replace", qPath: `/qHyperCubeDef/qMeasures/${i}/qDef/qLabel`, qValue: JSON.stringify(expr.replace(/^\[(.*)\]$/, "$1")) });
  });
  if (!patches.length) return false;
  try {
    await model.applyPatches(patches, true);
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("[qixHighDScatter] could not wrap bare measures in Only() — range selections on them will not work", e);
    return false;
  }
}

export async function planPacked(app: any, model: any, hc: any, legacyColor3: boolean, rowLevel: boolean | null): Promise<PackedPlan | null> {
  const props = await effectiveProps(model);
  const def = props?.qHyperCubeDef;
  if (!def || !app) return null;
  const nDims: number = def.qDimensions?.length ?? 0;
  const nMeas: number = def.qMeasures?.length ?? 0;
  if (nDims < 1 || nDims > 3 || nMeas < 2) return null;
  const idField = await dimField(app, def.qDimensions[0]);
  if (!idField) return null;
  const catField = nDims >= 2 ? await dimField(app, def.qDimensions[1]) : null;
  if (nDims >= 2 && !catField) return null;
  const shapeField = nDims >= 3 ? await dimField(app, def.qDimensions[2]) : null;
  if (nDims >= 3 && !shapeField) return null;
  const exprs: string[] = [];
  for (let i = 0; i < Math.min(nMeas, 4); i++) {
    const e = await measureExpr(app, def.qMeasures[i]);
    if (!e) return null;
    exprs.push(e);
  }
  const sIx = nMeas >= 3 && !legacyColor3 ? 2 : -1;
  const vIx = legacyColor3 ? 2 : nMeas >= 4 ? 3 : -1;
  const roles = [0, 1, sIx, vIx].filter((i) => i >= 0);

  const fields = exprs.map(singleFieldAgg);
  const useRows = rowLevel === true && roles.every((i) => fields[i]);
  const num = (i: number) => {
    const fmt = numFormat(hc.qMeasureInfo?.[i]);
    const e = useRows ? bracket(fields[i]!) : exprs[i]!;
    return `Num(${e},'${fmt}','.','')`;
  };
  const parts = [bracket(idField), num(0), num(1)];
  if (sIx >= 0) parts.push(`Coalesce(${num(sIx)},'')`);
  if (vIx >= 0) parts.push(`Coalesce(${num(vIx)},'')`);
  if (catField) parts.push(bracket(catField));
  if (shapeField) parts.push(bracket(shapeField));
  const inner = parts.join(" & Chr(9) & ");
  const aggrDims = [idField, catField, shapeField].filter((f): f is string => Boolean(f)).map(bracket).join(", ");
  const measure = useRows ? `Concat(${inner}, Chr(10))` : `Concat(Aggr(${inner}, ${aggrDims}), Chr(10))`;
  return {
    def: {
      qInfo: { qType: "qhds-packed" },
      qHyperCubeDef: {
        qDimensions: [{ qDef: { qFieldDefs: [`=Right(Hash128(${bracket(idField)}),2)`] } }],
        qMeasures: [{ qDef: { qDef: measure } }],
        qInitialDataFetch: [],
        qSuppressMissing: true,
      },
    },
    idDef: {
      qInfo: { qType: "qhds-packed-ids" },
      qHyperCubeDef: {
        qDimensions: [{ qDef: { qFieldDefs: [`=Right(Hash128(${bracket(idField)}),2)`] } }],
        qMeasures: [{ qDef: { qDef: `Concat(${bracket(idField)}, Chr(10))` } }], // row-level plans only: one row per id
        qInitialDataFetch: [],
        qSuppressMissing: true,
      },
    },
    rowLevel: useRows,
    size: sIx >= 0,
    value: vIx >= 0,
    category: Boolean(catField),
    catField,
    shape: Boolean(shapeField),
    shapeField,
    info: `${useRows ? "row-level" : "aggr"}${catField ? "+category" : ""}${shapeField ? "+shape" : ""}${sIx >= 0 ? "+size" : ""}${vIx >= 0 ? "+colour" : ""}`,
  };
}

/** Whether the point dimension has one data row per value (checked once per field, over all data). */
const uniqueCache = new Map<string, Promise<boolean>>();
export function pointIdIsUnique(app: any, model: any): Promise<boolean> {
  const key = String(app?.id ?? "") + ":" + String(model?.id ?? "");
  let p = uniqueCache.get(key);
  if (!p) {
    p = (async () => {
      const props = await effectiveProps(model);
      const idField = await dimField(app, props?.qHyperCubeDef?.qDimensions?.[0]);
      if (!idField) return false;
      const f = bracket(idField);
      const obj = await app.createSessionObject({
        qInfo: { qType: "qhds-unique" },
        qHyperCubeDef: {
          qDimensions: [],
          qMeasures: [{ qDef: { qDef: `Count({1} ${f}) - Count({1} DISTINCT ${f})` } }],
          qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 1 }],
        },
      });
      try {
        const lay = await obj.getLayout();
        const v = lay?.qHyperCube?.qDataPages?.[0]?.qMatrix?.[0]?.[0]?.qNum;
        return v === 0;
      } finally {
        void app.destroySessionObject(obj.id).catch(() => undefined);
      }
    })().catch(() => false);
    uniqueCache.set(key, p);
  }
  return p;
}

/** One packed session object per chart object, re-used across fetches while the plan is unchanged. */
export interface PackedCache {
  key?: string;
  obj?: any;
}

export async function disposePacked(app: any, cache: PackedCache): Promise<void> {
  const obj = cache.obj;
  cache.obj = undefined;
  cache.key = undefined;
  if (obj && app) await app.destroySessionObject(obj.id).catch(() => undefined);
}

/**
 * Loads every point through the packed cube. Phases (reported on `cols.phase`):
 * "calc" while the engine builds the cube (no progress available), then
 * "transfer" with `n` growing. Element numbers are not available on this path
 * (`elems` is empty); `selected` is all-on when the point dimension has selections.
 */
export function fetchPacked(
  app: any,
  plan: PackedPlan,
  cache: PackedCache,
  total: number,
  hasSelection: boolean,
  onProgress: (cols: QhdsColumns) => void,
  onError: (err: unknown) => void,
): FetchHandle {
  let cancelled = false;
  const cols: QhdsColumns = {
    x: new Float32Array(total),
    y: new Float32Array(total),
    elems: new Int32Array(0),
    labels: new Array<string>(total),
    selected: new Uint8Array(total),
    n: 0,
    total,
    done: total === 0,
    phase: "calc",
  };
  if (hasSelection) cols.selected.fill(1);
  if (plan.size || plan.value) cols.values = {};
  if (plan.size) cols.values!.size = new Float32Array(total);
  if (plan.value) cols.values!.value = new Float32Array(total);
  const catLabels: string[] = [];
  const catElems: number[] = [];
  const catIndex = new Map<string, number>();
  let catCodes: Uint16Array | null = null;
  let elemMap: Map<string, number> | null = null;
  const shpLabels: string[] = [];
  const shpElems: number[] = [];
  const shpIndex = new Map<string, number>();
  let shpCodes: Uint16Array | null = null;
  if (plan.category || plan.shape) cols.categories = {};
  if (plan.category) {
    catCodes = new Uint16Array(total);
    cols.categories!.category = { codes: catCodes, labels: catLabels, elems: catElems };
    // Element numbers for legend clicks arrive on the side; labels seen before are patched.
    void categoryElems(app, plan.catField!)
      .then((m) => {
        elemMap = m;
        for (let k = 0; k < catLabels.length; k++) catElems[k] = m.get(catLabels[k]!) ?? -1;
      })
      .catch(() => undefined);
  }
  if (plan.shape) {
    shpCodes = new Uint16Array(total);
    cols.categories!.shape = { codes: shpCodes, labels: shpLabels, elems: shpElems };
  }
  const perf = { t0: performance.now(), layoutMs: 0, calls: 0, bytes: 0, parseMs: 0, retries: 0 };

  const addCell = (text: string) => {
    const tp = performance.now();
    let start = 0;
    const len = text.length;
    while (start < len && cols.n < total) {
      let end = text.indexOf(RECORD_SEP, start);
      if (end < 0) end = len;
      // id ⇥ x ⇥ y [⇥ size] [⇥ value] [⇥ category] [⇥ shape]
      const a = text.indexOf(FIELD_SEP, start);
      if (a < 0 || a >= end) {
        start = end + 1;
        continue;
      }
      const b = text.indexOf(FIELD_SEP, a + 1);
      const bEnd = b < 0 || b > end ? end : b;
      const c = bEnd < end ? text.indexOf(FIELD_SEP, bEnd + 1) : -1;
      const cEnd = c < 0 || c > end ? end : c;
      const x = +text.slice(a + 1, bEnd);
      const y = +text.slice(bEnd + 1, cEnd);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        const i = cols.n;
        cols.x[i] = x;
        cols.y[i] = y;
        cols.labels[i] = text.slice(start, a);
        let p = cEnd;
        const nextField = () => {
          if (p >= end) return "";
          const q = text.indexOf(FIELD_SEP, p + 1);
          const qEnd = q < 0 || q > end ? end : q;
          const s = text.slice(p + 1, qEnd);
          p = qEnd;
          return s;
        };
        if (plan.size) {
          const s = nextField();
          cols.values!.size![i] = s ? +s : NaN;
        }
        if (plan.value) {
          const s = nextField();
          cols.values!.value![i] = s ? +s : NaN;
        }
        if (catCodes) {
          const s = nextField();
          let k = catIndex.get(s);
          if (k === undefined) {
            k = catLabels.length;
            catIndex.set(s, k);
            catLabels.push(s);
            catElems.push(elemMap?.get(s) ?? -1);
          }
          catCodes[i] = k;
        }
        if (shpCodes) {
          const s = nextField();
          let k = shpIndex.get(s);
          if (k === undefined) {
            k = shpLabels.length;
            shpIndex.set(s, k);
            shpLabels.push(s);
            shpElems.push(-1);
          }
          shpCodes[i] = k;
        }
        cols.n++;
      }
      start = end + 1;
    }
    perf.parseMs += performance.now() - tp;
  };

  const run = async () => {
    // The session object is kept while the plan is unchanged: its layout
    // invalidates with every selection like any other object.
    const key = JSON.stringify(plan.def);
    if (cache.obj && cache.key !== key) await disposePacked(app, cache);
    if (!cache.obj) {
      cache.obj = await app.createSessionObject(plan.def);
      cache.key = key;
    }
    const obj = cache.obj;
    if (cancelled) return;
    onProgress(cols);
    const lay = await withRetry(() => obj.getLayout(), () => cancelled);
    if (cancelled) return;
    perf.layoutMs = performance.now() - perf.t0;
    const hcb = lay?.qHyperCube;
    if (hcb?.qError) throw new Error(hcb.qError.qErrorCode ? `engine error ${hcb.qError.qErrorCode}` : "engine error");
    const rows: number = hcb?.qSize?.qcy ?? 0;
    cols.phase = "transfer";
    if (rows === 0 || total === 0) {
      cols.done = true;
      onProgress(cols);
      return;
    }
    // Page size from the expected bytes per bucket (≈ 40 bytes per point).
    const perBucket = Math.max(1, total / rows);
    let per = Math.max(1, Math.min(2000, Math.floor(PACKED_RESPONSE_BYTES / (perBucket * 40))));
    const queue: Array<{ top: number; h: number }> = [];
    for (let top = 0; top < rows; top += per) queue.push({ top, h: Math.min(per, rows - top) });
    const fetchPage = async (pg: { top: number; h: number }): Promise<void> => {
      try {
        const res = await withRetry(() => obj.getHyperCubeData("/qHyperCubeDef", [{ qTop: pg.top, qLeft: 0, qWidth: 2, qHeight: pg.h }]), () => cancelled);
        if (cancelled) return;
        perf.calls++;
        for (const row of res?.[0]?.qMatrix ?? []) {
          const t: string = row?.[1]?.qText ?? "";
          perf.bytes += t.length;
          if (t) addCell(t);
        }
        onProgress(cols);
      } catch (e) {
        // "Size of response is too large" (6001): split the page and try again.
        if (!cancelled && (e as any)?.code === 6001 && pg.h > 1) {
          perf.retries++;
          const h1 = Math.ceil(pg.h / 2);
          queue.unshift({ top: pg.top, h: h1 }, { top: pg.top + h1, h: pg.h - h1 });
          return;
        }
        throw e;
      }
    };
    const worker = async () => {
      while (!cancelled && queue.length) await fetchPage(queue.shift()!);
    };
    await Promise.all(Array.from({ length: Math.min(PACKED_CONCURRENCY, queue.length) }, worker));
    if (cancelled) return;
    cols.done = true;
    const totalMs = performance.now() - perf.t0;
    const w = window as any;
    (w.__qhdsPerf ??= {}).load = { mode: "packed", ...perf, totalMs, points: cols.n, total };
    // eslint-disable-next-line no-console
    console.info(`[qixHighDScatter] loaded ${cols.n.toLocaleString()} points packed (${plan.info}) in ${(totalMs / 1000).toFixed(1)}s — engine ${(perf.layoutMs / 1000).toFixed(1)}s, transfer ${((totalMs - perf.layoutMs) / 1000).toFixed(1)}s in ${perf.calls} calls, ${(perf.bytes / 1e6).toFixed(1)} MB, parse ${Math.round(perf.parseMs)} ms${perf.retries ? `, ${perf.retries} page splits` : ""}`);
    onProgress(cols);
  };

  run().catch((e) => {
    if (!cancelled) onError(e);
  });
  return {
    cancel() {
      cancelled = true;
    },
  };
}

/** Element numbers of the 2nd dimension's values (legend clicks select by element). */
export async function categoryElems(app: any, catField: string): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const obj = await app.createSessionObject({
    qInfo: { qType: "qhds-cat" },
    qListObjectDef: { qDef: { qFieldDefs: [catField] }, qInitialDataFetch: [{ qTop: 0, qLeft: 0, qWidth: 1, qHeight: 10000 }] },
  });
  try {
    const lay = await obj.getLayout();
    for (const row of lay?.qListObject?.qDataPages?.[0]?.qMatrix ?? []) {
      const c = row?.[0];
      if (c && typeof c.qElemNumber === "number") out.set(String(c.qText ?? ""), c.qElemNumber);
    }
  } finally {
    void app.destroySessionObject(obj.id).catch(() => undefined);
  }
  return out;
}


/**
 * The ids of the points currently possible, through the same buckets as the
 * packed cube (ids only: ~7 bytes per point, so a quarter of the cost). Used
 * to cut a cached full load down to a selection without re-reading x/y.
 */
export function fetchPackedIds(
  app: any,
  plan: PackedPlan,
  cache: PackedCache,
  onPhase: (phase: "calc" | "transfer") => void,
): { promise: Promise<string[]>; cancel(): void } {
  let cancelled = false;
  const promise = (async () => {
    const key = JSON.stringify(plan.idDef);
    if (cache.obj && cache.key !== key) await disposePacked(app, cache);
    if (!cache.obj) {
      cache.obj = await app.createSessionObject(plan.idDef);
      cache.key = key;
    }
    const obj = cache.obj;
    onPhase("calc");
    const lay = await withRetry(() => obj.getLayout(), () => cancelled);
    if (cancelled) return [];
    const hcb = lay?.qHyperCube;
    if (hcb?.qError) throw new Error("engine error");
    const rows: number = hcb?.qSize?.qcy ?? 0;
    onPhase("transfer");
    const ids: string[] = [];
    if (!rows) return ids;
    const per = 200;
    const queue: Array<{ top: number; h: number }> = [];
    for (let top = 0; top < rows; top += per) queue.push({ top, h: Math.min(per, rows - top) });
    const worker = async () => {
      while (!cancelled && queue.length) {
        const pg = queue.shift()!;
        try {
          const res = await withRetry(() => obj.getHyperCubeData("/qHyperCubeDef", [{ qTop: pg.top, qLeft: 0, qWidth: 2, qHeight: pg.h }]), () => cancelled);
          if (cancelled) return;
          for (const row of res?.[0]?.qMatrix ?? []) {
            const t: string = row?.[1]?.qText ?? "";
            if (!t) continue;
            let start = 0;
            while (start < t.length) {
              let end = t.indexOf(RECORD_SEP, start);
              if (end < 0) end = t.length;
              ids.push(t.slice(start, end));
              start = end + 1;
            }
          }
        } catch (e) {
          if (!cancelled && (e as any)?.code === 6001 && pg.h > 1) {
            const h1 = Math.ceil(pg.h / 2);
            queue.unshift({ top: pg.top, h: h1 }, { top: pg.top + h1, h: pg.h - h1 });
            continue;
          }
          throw e;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PACKED_CONCURRENCY, queue.length) }, worker));
    return ids;
  })();
  return {
    promise,
    cancel() {
      cancelled = true;
    },
  };
}

/**
 * A full load, kept to answer later selections locally: the subset of its
 * points whose ids the engine lists. Only valid for row-level plans (x/y per
 * point never change) and while the app has not been reloaded.
 */
export interface FullCache {
  planKey: string;
  reloadTime: string;
  cols: QhdsColumns;
  index: Map<string, number> | null;
}

export function subsetFromCache(full: FullCache, ids: string[], hasSelection: boolean): QhdsColumns {
  const src = full.cols;
  if (!full.index) {
    const m = new Map<string, number>();
    for (let i = 0; i < src.n; i++) m.set(src.labels[i]!, i);
    full.index = m;
  }
  const idx = full.index;
  const n = ids.length;
  const pick = new Int32Array(n);
  let k = 0;
  for (let i = 0; i < n; i++) {
    const j = idx.get(ids[i]!);
    if (j !== undefined) pick[k++] = j;
  }
  const out: QhdsColumns = {
    x: new Float32Array(k),
    y: new Float32Array(k),
    elems: new Int32Array(0),
    labels: new Array<string>(k),
    selected: new Uint8Array(k),
    n: k,
    total: k,
    done: true,
    phase: "transfer",
  };
  if (hasSelection) out.selected.fill(1);
  const sz = src.values?.size;
  const vl = src.values?.value;
  if (sz || vl) out.values = {};
  if (sz) out.values!.size = new Float32Array(k);
  if (vl) out.values!.value = new Float32Array(k);
  const cats = Object.entries(src.categories ?? {}).map(([name, c]) => {
    const codes = new Uint16Array(k);
    return { name, src: c.codes, codes, labels: c.labels.slice(), elems: c.elems.slice() };
  });
  if (cats.length) {
    out.categories = {};
    for (const c of cats) out.categories[c.name] = { codes: c.codes, labels: c.labels, elems: c.elems };
  }
  for (let i = 0; i < k; i++) {
    const j = pick[i]!;
    out.x[i] = src.x[j]!;
    out.y[i] = src.y[j]!;
    out.labels[i] = src.labels[j]!;
    if (sz) out.values!.size![i] = sz[j]!;
    if (vl) out.values!.value![i] = vl[j]!;
    for (const c of cats) c.codes[i] = c.src[j]!;
  }
  return out;
}

/** The app's last reload time — a cache of points is void once the data changed. */
export async function appReloadTime(app: any): Promise<string> {
  try {
    const lay = await app.getAppLayout();
    return String(lay?.qLastReloadTime ?? "");
  } catch {
    return "";
  }
}
