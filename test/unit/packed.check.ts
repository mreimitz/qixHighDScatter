/**
 * Packed transport, engine-free: the plan built from a cube definition, the
 * parser (fetchPacked against a fake engine) and the selection cut from a
 * cached full load. Run: node test/unit/run.mjs packed
 */
import { fetchPacked, fetchPackedIds, planPacked, subsetFromCache, type FullCache } from "../../src/data";

const assert = (cond: unknown, msg: string) => {
  if (!cond) throw new Error("FAIL: " + msg);
};

// ---- a fake engine: session objects answer getLayout / getHyperCubeData from a table ----
type Row = { id: string; x: number; y: number; s: number | null; cat: string };
const rows: Row[] = [];
let seed = 3;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
for (let i = 0; i < 5000; i++) rows.push({ id: `P${i}`, x: -100 + rnd() * 200, y: rnd() * 10, s: i % 7 === 0 ? null : rnd(), cat: ["A", "B", "C"][i % 3]! });

const fmt = (v: number, decimals: number) => {
  const t = v.toFixed(decimals);
  return t.includes(".") ? t.replace(/0+$/, "").replace(/\.$/, "") : t;
};
let possible = new Set(rows.map((r) => r.id));
let created = 0;
let destroyed = 0;
const fakeApp = {
  id: "app",
  getAppLayout: async () => ({ qLastReloadTime: "2026-10-04T00:00:00Z" }),
  destroySessionObject: async () => void destroyed++,
  createSessionObject: async (def: any) => {
    created++;
    const measure: string = def.qHyperCubeDef?.qMeasures?.[0]?.qDef?.qDef ?? "";
    const list = def.qListObjectDef;
    const idsOnly = /^Concat\(\[PointID\], Chr\(10\)\)$/.test(measure);
    const withCat = /\[Airline\]/.test(measure);
    const withSize = /Coalesce/.test(measure);
    // bucket by a cheap hash, like the engine would by Hash128
    const buckets = new Map<string, Row[]>();
    for (const r of rows) {
      if (!possible.has(r.id)) continue;
      const b = String(Number(r.id.slice(1)) % 37);
      (buckets.get(b) ?? buckets.set(b, []).get(b)!).push(r);
    }
    const keys = [...buckets.keys()].sort();
    const cell = (b: string) =>
      buckets
        .get(b)!
        .map((r) => (idsOnly ? r.id : [r.id, fmt(r.x, 4), fmt(r.y, 5), ...(withSize ? [r.s === null ? "" : fmt(r.s, 6)] : []), ...(withCat ? [r.cat] : [])].join("\t")))
        .join("\n");
    return {
      id: `obj${created}`,
      getLayout: async () =>
        list
          ? { qListObject: { qDataPages: [{ qMatrix: ["A", "B", "C"].map((c, i) => [{ qText: c, qElemNumber: i }]) }] } }
          : { qHyperCube: { qSize: { qcy: keys.length, qcx: 2 } } },
      getHyperCubeData: async (_p: string, pages: any[]) => {
        const pg = pages[0];
        if (pg.qHeight > 3) throw Object.assign(new Error("Size of response is too large"), { code: 6001 }); // exercise the split
        return [{ qMatrix: keys.slice(pg.qTop, pg.qTop + pg.qHeight).map((b) => [{ qText: b }, { qText: cell(b) }]) }];
      },
    };
  },
  getDimension: async () => ({ getLayout: async () => ({ qDim: { qFieldDefs: ["Airline"] } }) }),
  getMeasure: async () => ({ getLayout: async () => ({ qMeasure: { qDef: "Avg(Size_m)" } }) }),
};
const model = {
  id: "m1",
  getProperties: async () => ({
    qHyperCubeDef: {
      qDimensions: [{ qDef: { qFieldDefs: ["PointID"] } }, { qLibraryId: "libdim" }],
      qMeasures: [{ qDef: { qDef: "Avg(AlongTrack_m)" } }, { qDef: { qDef: "=Avg(CrossTrack_m)" } }, { qLibraryId: "libmeas" }],
    },
  }),
};
const hc = { qDimensionInfo: [{}, {}], qMeasureInfo: [{ qMin: -100, qMax: 100 }, { qMin: 0, qMax: 10 }, { qMin: 0, qMax: 1 }], qSize: { qcy: rows.length } };

(async () => {
  const plan = await planPacked(fakeApp, model, hc, false, true);
  assert(plan, "plan built");
  assert(plan!.rowLevel && plan!.category && plan!.size && !plan!.value, "roles: " + plan!.info);
  const m: string = plan!.def.qHyperCubeDef.qMeasures[0].qDef.qDef;
  assert(m.startsWith("Concat([PointID] & Chr(9) & Num([AlongTrack_m],'0.####','.','')"), "row-level measure, 4 decimals for span 200: " + m);
  assert(m.includes("Num([CrossTrack_m],'0.#####','.','')"), "5 decimals for span 10");
  assert(m.includes("Coalesce(Num([Size_m],'0.######','.',''),'')") && m.includes("& Chr(9) & [Airline], Chr(10))"), "size + category appended: " + m);
  assert(plan!.def.qHyperCubeDef.qDimensions[0].qDef.qFieldDefs[0] === "=Right(Hash128([PointID]),2)", "bucket dimension");

  // full load through the fake engine (every page > 3 rows is "too large" → splits)
  const cache = {};
  const phases: string[] = [];
  const cols = await new Promise<any>((resolve, reject) => {
    fetchPacked(fakeApp, plan!, cache, rows.length, false, (c) => {
      if (!phases.includes(c.phase!)) phases.push(c.phase!);
      if (c.done) resolve(c);
    }, reject);
  });
  assert(phases.join(",") === "calc,transfer", "phases: " + phases.join(","));
  assert(cols.n === rows.length, `all points parsed: ${cols.n}`);
  const byId = new Map(rows.map((r) => [r.id, r]));
  let bad = 0;
  for (let i = 0; i < cols.n; i++) {
    const r = byId.get(cols.labels[i])!;
    if (Math.abs(cols.x[i] - r.x) > 1e-3 || Math.abs(cols.y[i] - r.y) > 1e-4) bad++;
    const s = cols.values.size[i];
    if (r.s === null ? !Number.isNaN(s) : Math.abs(s - r.s) > 1e-5) bad++;
    if (cols.categories.category.labels[cols.categories.category.codes[i]] !== r.cat) bad++;
  }
  assert(bad === 0, `values round-trip (${bad} mismatches)`);
  await new Promise((r) => setTimeout(r, 10));
  assert(cols.categories.category.elems.join() === "0,1,2" || cols.categories.category.elems.slice().sort().join() === "0,1,2", "category element numbers patched in: " + cols.categories.category.elems.join());
  assert((window as any).__qhdsPerf.load.retries > 0, "page splits exercised");

  // a selection: ids only, cut from the cache
  possible = new Set(rows.filter((r) => r.cat === "B").map((r) => r.id));
  const full: FullCache = { planKey: "k", reloadTime: "t", cols, index: null };
  const idc = {};
  const ids = await fetchPackedIds(fakeApp, plan!, idc, () => undefined).promise;
  assert(ids.length === possible.size, `id list: ${ids.length}`);
  const sub = subsetFromCache(full, ids, true);
  assert(sub.n === possible.size && sub.done && sub.selected[0] === 1, `subset: ${sub.n}`);
  let wrong = 0;
  for (let i = 0; i < sub.n; i++) {
    const r = byId.get(sub.labels[i])!;
    if (r.cat !== "B" || Math.abs(sub.x[i] - r.x) > 1e-3 || sub.categories!.category.labels[sub.categories!.category.codes[i]!] !== "B") wrong++;
  }
  assert(wrong === 0, "subset carries the right rows");
  // the session objects are reused while the plan is unchanged
  const before = created;
  await fetchPackedIds(fakeApp, plan!, idc, () => undefined).promise;
  assert(created === before, "id object reused");

  // not packable: calculated dimension
  const calcModel = { id: "m2", getProperties: async () => ({ qHyperCubeDef: { qDimensions: [{ qDef: { qFieldDefs: ["=Left(PointID,2)"] } }], qMeasures: [{ qDef: { qDef: "Sum(x)" } }, { qDef: { qDef: "Sum(y)" } }] } }) };
  assert((await planPacked(fakeApp, calcModel, hc, false, true)) === null, "calculated dimension → no plan");
  // aggr form when the id is not unique
  const p2 = await planPacked(fakeApp, model, hc, false, false);
  assert(p2!.def.qHyperCubeDef.qMeasures[0].qDef.qDef.startsWith("Concat(Aggr([PointID] & Chr(9) & Num(Avg(AlongTrack_m),"), "aggr form keeps the measure expressions");
  assert(p2!.def.qHyperCubeDef.qMeasures[0].qDef.qDef.endsWith(", [PointID], [Airline]), Chr(10))"), "aggr over id and category");
  console.log("packed.check: ok", { points: cols.n, subset: sub.n, created, destroyed });
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
