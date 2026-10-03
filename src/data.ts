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
  const catLabels: string[] = [];
  const catElems: number[] = [];
  const catIndex = new Map<string, number>();
  let catCodes: Uint16Array | null = null;
  if (cCol >= 0) {
    catCodes = new Uint16Array(total);
    cols.categories = { category: { codes: catCodes, labels: catLabels, elems: catElems } };
  }

  // Rows whose x/y are not numbers are dropped; we compact per page into a
  // staging area, then commit pages strictly in order.
  const staged: Array<
    | { rows: number; x: Float32Array; y: Float32Array; e: Int32Array; t: string[]; st: Uint8Array; v?: Float32Array; sz?: Float32Array; c?: Uint16Array }
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
      cols.n += s.rows;
      staged[committedPage] = undefined;
      committedPage++;
      changed = true;
    }
    if (committedPage === pages) cols.done = true;
    if (changed || cols.done) onProgress(cols);
  };

  const { pagesPerCall, concurrency } = fetchTuning();
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
        if (c) {
          const t = String(row[cCol]?.qText ?? "");
          let k = catIndex.get(t);
          if (k === undefined) {
            k = catLabels.length;
            catIndex.set(t, k);
            catLabels.push(t);
            catElems.push(Number(row[cCol]?.qElemNumber ?? -1));
          }
          c[rows] = k;
        }
        rows++;
      }
      staged[p] = { rows, x, y, e, t, st, v, sz, c };
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
