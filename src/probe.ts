/**
 * Transport probes (window.__qhdsFetch.mode = "probe"): measured on the live
 * engine after a normal load, logged as `[qixHighDScatter] probe …`. Diagnostics
 * only — never runs for users.
 */

const log = (msg: string, extra?: unknown) => {
  const w = window as any;
  (w.__qhdsProbe ??= []).push({ t: Date.now(), msg, extra });
  // eslint-disable-next-line no-console
  console.info(`[qixHighDScatter] probe ${msg} ${extra === undefined ? "" : JSON.stringify(extra)}`);
};

const now = () => performance.now();

function fieldDef(d: any): string | null {
  const f = d?.qDef?.qFieldDefs?.[0];
  return typeof f === "string" && f && !f.startsWith("=") ? f : null;
}

export async function runProbes(app: any, model: any, hc: any): Promise<void> {
  try {
    const props = await model.getProperties();
    const def = props.qHyperCubeDef;
    const dims = def.qDimensions.map((d: any) => d.qLibraryId || d.qDef?.qFieldDefs);
    const meas = def.qMeasures.map((m: any) => m.qLibraryId || m.qDef?.qDef);
    const width = hc.qDimensionInfo.length + hc.qMeasureInfo.length;
    const qcy = hc.qSize.qcy;
    log("cube", { dims, meas, width, qcy, sort: def.qInterColumnSortOrder, sz: def.qSuppressZero, sm: def.qSuppressMissing });

    const page = (top: number, w: number, h: number) => ({ qTop: top, qLeft: 0, qWidth: w, qHeight: h });
    const timeCalls = async (m: any, pages: Array<{ qTop: number; qLeft: number; qWidth: number; qHeight: number }>) => {
      const t0 = now();
      let cells = 0;
      let chars = 0;
      for (const p of pages) {
        const r = await m.getHyperCubeData("/qHyperCubeDef", [p]);
        const mat = r[0].qMatrix;
        cells += mat.length * p.qWidth;
        chars += JSON.stringify(mat).length;
      }
      const ms = now() - t0;
      return { ms: Math.round(ms), perCall: Math.round(ms / pages.length), cells, chars, bytesPerCell: Math.round(chars / cells) };
    };

    // P1: serial, full width.
    const h = Math.floor(10000 / width);
    log("P1 serial full width", await timeCalls(model, [0, 1, 2, 3, 4].map((i) => page(i * h, width, h))));
    // P2: dimension column only, 10k rows per call.
    log("P2 serial dim only", await timeCalls(model, [0, 1, 2, 3, 4].map((i) => page(i * 10000, 1, 10000))));
    // P2b: one measure column only.
    log("P2b serial measure only", await (async () => {
      const t0 = now();
      for (let i = 0; i < 5; i++) await model.getHyperCubeData("/qHyperCubeDef", [{ qTop: i * 10000, qLeft: hc.qDimensionInfo.length, qWidth: 1, qHeight: 10000 }]);
      return Math.round((now() - t0) / 5);
    })());

    // P3: the same cube in N session objects, paged in parallel — does the engine
    // run requests of different objects concurrently?
    const cloneDef = { qInfo: { qType: "qhds-probe-clone" }, qHyperCubeDef: { ...def, qInitialDataFetch: [] } };
    const clones: any[] = [];
    for (let i = 0; i < 4; i++) clones.push(await app.createSessionObject(cloneDef));
    await Promise.all(clones.map((c) => c.getLayout()));
    {
      const t0 = now();
      await timeCalls(clones[0], [0, 1, 2, 3, 4, 5, 6, 7].map((i) => page(i * h, width, h)));
      const one = now() - t0;
      const t1 = now();
      await Promise.all(clones.map((c, k) => timeCalls(c, [0, 1].map((i) => page((k * 2 + i) * h, width, h)))));
      const four = now() - t1;
      const t2 = now();
      await Promise.all([0, 1, 2, 3, 4, 5, 6, 7].map((i) => clones[0].getHyperCubeData("/qHyperCubeDef", [page(i * h, width, h)])));
      const oneParallel = now() - t2;
      log("P3 8 pages: one object serial / 4 objects × 2 parallel / one object 8 in flight (ms)", { one: Math.round(one), four: Math.round(four), oneParallel: Math.round(oneParallel) });
    }
    for (const c of clones) await app.destroySessionObject(c.id);

    // P4: packed rows — one text measure carrying id|x|y per point, bucketed so
    // one cell holds a few hundred points; element numbers are not needed for ranges.
    const idField = fieldDef(def.qDimensions[0]);
    const mx = def.qMeasures[0]?.qDef?.qDef;
    const my = def.qMeasures[1]?.qDef?.qDef;
    const want: string[] = (window as any).__qhdsFetch?.buckets ?? ["hash2", "mod", "rowlevel", "hash3"];
    if (idField && mx && my) {
      const n = (e: string) => `Num(${e},'0.######','.','')`;
      const inner = `[${idField}] & '|' & ${n(mx)} & '|' & ${n(my)}`;
      const buckets: Record<string, string> = {
        hash2: `=Right(Hash128([${idField}]),2)`,
        hash3: `=Right(Hash128([${idField}]),3)`,
        rand: `=Floor(Rand()*4096)`,
        mod: `=Mod(Floor([${idField}]),4096)`,
        rowlevel: `=Mod(Floor([${idField}]),4096)`,
      };
      // Row-level variant: measures of the form Agg(Field) on a one-row-per-id model
      // need no Aggr — Concat runs over the rows of the bucket directly.
      const plain = (e: string) => /^\s*(Avg|Sum|Only|Min|Max)\(\s*\[?([^\]()]+?)\]?\s*\)\s*$/i.exec(e)?.[2];
      const fx = plain(mx);
      const fy = plain(my);
      const rowInner = fx && fy ? `[${idField}] & '|' & ${n(`[${fx}]`)} & '|' & ${n(`[${fy}]`)}` : null;
      for (const name of want) {
        const packedDef = {
          qInfo: { qType: "qhds-probe-packed" },
          qHyperCubeDef: {
            qDimensions: [{ qDef: { qFieldDefs: [buckets[name]] } }],
            qMeasures: [{ qDef: { qDef: name === "rowlevel" ? `Concat(${rowInner ?? inner}, ';')` : `Concat(Aggr(${inner}, [${idField}]), ';')` } }],
            qInitialDataFetch: [],
            qSuppressMissing: true,
          },
        };
        const t0 = now();
        const pm = await app.createSessionObject(packedDef);
        const lay = await pm.getLayout();
        const t1 = now();
        const rows = lay.qHyperCube.qSize.qcy;
        log(`P4 packed cube layout (${name})`, { ms: Math.round(t1 - t0), buckets: rows, err: lay.qHyperCube.qError, calc: lay.qHyperCube.qCalcCondMsg });
        const perBucket = Math.max(1, qcy / Math.max(1, rows));
        let per = Number((window as any).__qhdsFetch?.per) || Math.max(1, Math.min(500, Math.floor(1.5e6 / (perBucket * 30))));
        while (rows > 0 && per >= 4) {
          const reqs = [];
          for (let top = 0; top < rows; top += per) reqs.push(page(top, 2, Math.min(per, rows - top)));
          try {
            let points = 0;
            let chars = 0;
            let parseMs = 0;
            const t2 = now();
            const res = await Promise.all(reqs.map((p) => pm.getHyperCubeData("/qHyperCubeDef", [p])));
            const t3 = now();
            let sample = "";
            for (const r of res) {
              for (const row of r[0].qMatrix) {
                const s: string = row[1].qText ?? "";
                if (!sample) sample = s.slice(0, 80);
                chars += s.length;
                const tp = now();
                const parts = s.split(";");
                for (const part of parts) {
                  const a = part.indexOf("|");
                  const b = part.indexOf("|", a + 1);
                  const x = +part.slice(a + 1, b);
                  const y = +part.slice(b + 1);
                  if (x === x && y === y) points++;
                }
                parseMs += now() - tp;
              }
            }
            log(`P4 packed fetch (${name})`, { per, calls: reqs.length, fetchMs: Math.round(t3 - t2), points, mb: +(chars / 1e6).toFixed(1), parseMs: Math.round(parseMs), sample });
            break;
          } catch (e) {
            log(`P4 packed fetch (${name}) per=${per} failed`, String((e as any)?.parameter ?? (e as any)?.message ?? e));
            per = Math.floor(per / 2);
          }
        }
        await app.destroySessionObject(pm.id);
      }
    } else {
      log("P4 skipped (calculated/library dimension or measure)", { idField, mx, my });
    }

    // P4b: split the packing over 4 session objects (does the engine parallelise?)
    if (idField && mx && my && ((window as any).__qhdsFetch?.split ?? true)) {
      const n = (e: string) => `Num(${e},'0.######','.','')`;
      const plain = (e: string) => /^\s*(Avg|Sum|Only|Min|Max)\(\s*\[?([^\]()]+?)\]?\s*\)\s*$/i.exec(e)?.[2];
      const fx = plain(mx);
      const fy = plain(my);
      const variants: Array<[string, (k: number, parts: number) => string]> = [
        ["rownonum", () => `Concat([${idField}] & '|' & [${fx}] & '|' & [${fy}], ';')`],
        ["split4-row", (k, parts) => `Concat(If(Mod(Floor([${idField}]),${parts})=${k}, [${idField}] & '|' & ${n(`[${fx}]`)} & '|' & ${n(`[${fy}]`)}), ';')`],
        ["split4-aggr", (k, parts) => `Concat(Aggr(If(Mod(Floor([${idField}]),${parts})=${k}, [${idField}] & '|' & ${n(mx)} & '|' & ${n(my)}), [${idField}]), ';')`],
      ];
      for (const [name, measure] of variants) {
        const parts = name.startsWith("split4") ? 4 : 1;
        const objs: any[] = [];
        const t0 = now();
        for (let k = 0; k < parts; k++) {
          objs.push(
            await app.createSessionObject({
              qInfo: { qType: "qhds-probe-split" },
              qHyperCubeDef: {
                qDimensions: [{ qDef: { qFieldDefs: [`=Mod(Floor([${idField}]),1024)`] } }],
                qMeasures: [{ qDef: { qDef: measure(k, parts) } }],
                qInitialDataFetch: [],
                qSuppressMissing: true,
              },
            }),
          );
        }
        const lays = await Promise.all(objs.map((o) => o.getLayout()));
        const t1 = now();
        const rows = lays.map((l) => l.qHyperCube.qSize.qcy);
        let chars = 0;
        let points = 0;
        const t2 = now();
        await Promise.all(
          objs.map(async (o, k) => {
            const reqs = [];
            const per = 50;
            for (let top = 0; top < rows[k]; top += per) reqs.push(page(top, 2, Math.min(per, rows[k] - top)));
            const res = await Promise.all(reqs.map((p) => o.getHyperCubeData("/qHyperCubeDef", [p])));
            for (const r of res) for (const row of r[0].qMatrix) { const t: string = row[1].qText ?? ""; chars += t.length; points += t ? t.split(";").length : 0; }
          }),
        );
        const t3 = now();
        log(`P4b ${name}`, { layoutMs: Math.round(t1 - t0), fetchMs: Math.round(t3 - t2), rows, points, mb: +(chars / 1e6).toFixed(1), sample: lays[0].qHyperCube.qError ? JSON.stringify(lays[0].qHyperCube.qError) : "" });
        for (const o of objs) await app.destroySessionObject(o.id);
      }
    }

    // P4c: custom variants from window.__qhdsFetch.custom = [{ name, dim, measure }] (one object each).
    for (const v of ((window as any).__qhdsFetch?.custom ?? []) as Array<{ name: string; dim: string; measure: string }>) {
      const t0 = now();
      const o = await app.createSessionObject({
        qInfo: { qType: "qhds-probe-custom" },
        qHyperCubeDef: { qDimensions: [{ qDef: { qFieldDefs: [v.dim] } }], qMeasures: [{ qDef: { qDef: v.measure } }], qInitialDataFetch: [], qSuppressMissing: true },
      });
      const lay = await o.getLayout();
      const t1 = now();
      const rows = lay.qHyperCube.qSize.qcy;
      let chars = 0;
      const per = Math.max(1, Math.min(500, Math.floor(1.5e6 / ((qcy / Math.max(1, rows)) * 30))));
      const reqs = [];
      for (let top = 0; top < rows; top += per) reqs.push(page(top, 2, Math.min(per, rows - top)));
      const t2 = now();
      try {
        const res = await Promise.all(reqs.map((p) => o.getHyperCubeData("/qHyperCubeDef", [p])));
        for (const r of res) for (const row of r[0].qMatrix) chars += (row[1].qText ?? "").length;
      } catch (e) {
        log(`P4c ${v.name} fetch failed`, String((e as any)?.parameter ?? e));
      }
      log(`P4c ${v.name}`, { layoutMs: Math.round(t1 - t0), fetchMs: Math.round(now() - t2), rows, mb: +(chars / 1e6).toFixed(1), err: lay.qHyperCube.qError ? JSON.stringify(lay.qHyperCube.qError) : "" });
      await app.destroySessionObject(o.id);
    }

    // P5: the engine's own binning — one call for a first picture.
    try {
      const mx0 = hc.qMeasureInfo[0];
      const my0 = hc.qMeasureInfo[1];
      const bm = await app.createSessionObject({ qInfo: { qType: "qhds-probe-bin" }, qHyperCubeDef: { ...def, qDimensions: [def.qDimensions[0]], qMeasures: def.qMeasures.slice(0, 2), qInitialDataFetch: [] } });
      await bm.getLayout();
      const t0 = now();
      const r = await bm.getHyperCubeBinnedData(
        "/qHyperCubeDef",
        [page(0, 3, qcy)],
        { qWidth: 1000, qHeight: 600, qZoomLevel: 1 },
        [{ qLeft: mx0.qMin, qTop: my0.qMin, qWidth: mx0.qMax - mx0.qMin, qHeight: my0.qMax - my0.qMin }],
        10000,
        1,
        0,
      );
      const ms = now() - t0;
      const m = r?.[0]?.qMatrix ?? [];
      log("P5 binned", { ms: Math.round(ms), rows: m.length, area: r?.[0]?.qArea, first: JSON.stringify(m.slice(0, 3)).slice(0, 600), last: JSON.stringify(m[m.length - 1]).slice(0, 300), tails: JSON.stringify(r?.[0]?.qTails) });
    } catch (e) {
      log("P5 binned failed", String((e as any)?.message ?? e));
    }
    log("done");
  } catch (e) {
    log("FAILED", e);
  }
}
