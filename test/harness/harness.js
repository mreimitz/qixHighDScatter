// Real nebula.js runtime + EnigmaMocker. Generates N synthetic points (funnel
// traffic like the brand-ui story) and records every engine call.
const params = new URLSearchParams(location.search);
const N = Number(params.get('n') || 300000);
const DARK = params.get('dark') === '1';
window.__calls = [];
if (params.get('noremount')) window.__qhdsNoRemount = true;
if (params.get('nogpu') === '1') window.__qhdsForceNoGpu = true;
window.__dbg = [];
if (DARK) document.getElementById('obj').style.background = '#1e1e1e';
if (params.get('w')) document.getElementById('obj').style.width = params.get('w') + 'px';
if (params.get('h')) document.getElementById('obj').style.height = params.get('h') + 'px';
const SCALE = Number(params.get('scale') || 1);
function lcg(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
const rnd = lcg(20260925);
const gauss = () => { let u = 0, v = 0; while (!u) u = rnd(); while (!v) v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
const X = new Float64Array(N), Y = new Float64Array(N), V = new Float64Array(N);
for (let i = 0; i < N; i++) {
  const r = rnd(); let px = -2200 + rnd() * 5700, py;
  if (r < 0.75) { const sd = px < -650 ? 16 : px < -200 ? 16 - (11 * (px + 650)) / 450 : 5; py = gauss() * sd; }
  else if (r < 0.95) { py = gauss() * (px < -200 ? 60 : 14); }
  else py = gauss() * 140;
  X[i] = px * SCALE; Y[i] = py * SCALE; V[i] = 80 + 80 * Math.min(1, Math.max(0, (px + 2200) / 5700)) + gauss() * 8;
}
// `&cat=1`: a 2nd dimension (Airline, 6 values) — colour / shape by dimension tests.
const CAT = params.get('cat') === '1';
// `&shape=1` (with cat=1): a 3rd dimension (AircraftType, 4 values) — shape by a different dimension than colour.
const SHP = CAT && params.get('shape') === '1';
const SHAPES = ['A320', 'A321', 'A350', 'B38M'];
const CATS = ['Aurora Air', 'Blue Heron', 'Coastline', 'Meridian', 'Northwind', 'Zephyr'];
const cell = (n, t) => ({ qNum: n, qText: t ?? String(n), qElemNumber: 0, qState: 'L' });
const zones = JSON.parse(params.get('zones') || 'null') || [
  { label: 'Core', show: true, kind: 'envelope', mirror: true, extendStart: !!params.get('endless'), extendEnd: !!params.get('endless'), upper: [{ x: -2200, y: 42 }, { x: -650, y: 42 }, { x: -200, y: 15 }, { x: 3500, y: 15 }], color: { index: -1, color: '#4477aa' } },
  { label: 'Expanded', show: true, kind: 'envelope', mirror: false, upper: [{ x: -1450, y: 215 }, { x: -200, y: 30 }, { x: 3500, y: 30 }], lower: [{ x: -1300, y: -215 }, { x: -200, y: -30 }, { x: 3500, y: -30 }], color: { index: 3 } },
  { label: 'High band', show: true, kind: 'band', yMin: 200, yMax: 400, color: { index: -1, color: '#f93f17' } },
  ...(params.get('endless') ? [{ label: 'Floor line', show: true, kind: 'line', side: 'below', extendStart: true, extendEnd: false, line: [{ x: -1000, y: -260 }, { x: 0, y: -170 }, { x: 1500, y: -200 }], color: { index: -1, color: '#276e27' } }] : []),
  ...(params.get('beyond') ? [{ label: 'Beyond limits', show: true, kind: 'band', cover: 'outside', yMin: -300, yMax: 300, color: { index: -1, color: '#8e477d' } }] : []),
  { label: 'Broken', show: true, kind: 'rect', yMin: 0, yMax: 1 },
];
const layout = {
  qInfo: { qId: 'qhds1', qType: 'qixHighDScatter' },
  visualization: 'qixHighDScatter',
  title: 'Harness', showTitles: false,
  qSelectionInfo: {},
  qHyperCube: {
    qSize: { qcx: (CAT ? 5 : 4) + (SHP ? 1 : 0), qcy: N },
    qDimensionInfo: [{ cId: 'd1', qFallbackTitle: 'PointID', qCardinal: N, qStateCounts: { qOption: N } }, ...(CAT ? [{ cId: 'd2', qFallbackTitle: 'Airline', qCardinal: CATS.length, qStateCounts: { qOption: CATS.length } }] : []), ...(SHP ? [{ cId: 'd3', qFallbackTitle: 'AircraftType', qCardinal: SHAPES.length, qStateCounts: { qOption: SHAPES.length } }] : [])],
    qMeasureInfo: [{ cId: 'm1', qFallbackTitle: 'Along-track (m)', qMin: -2200 * SCALE, qMax: 3500 * SCALE, qNumFormat: { qType: 'U' } }, { cId: 'm2', qFallbackTitle: 'Cross-track (m)', qMin: -500 * SCALE, qMax: 500 * SCALE, qNumFormat: { qType: 'U' } }, { cId: 'm3', qFallbackTitle: 'Speed', qMin: 60, qMax: 190 }],
    qDataPages: [],
  },
  props: { zones, outsideInteractive: params.get('outside') !== '0', outsideLabel: 'Outside', outsideColor: { index: -1, color: '#a6a6a6' }, colorBy: params.get('colorBy') || 'zone', pointRadius: 1.35, cellSize: 5, underlay: 4, maxPoints: 1000000, zoom: true, toolbar: true, legend: true, ...JSON.parse(params.get('props') || '{}') },
};
let pagesServed = 0;
const rec = (name) => (...args) => { window.__calls.push({ name, args: JSON.parse(JSON.stringify(args)) }); return ['rangeSelectHyperCubeValues', 'multiRangeSelectHyperCubeValues', 'selectHyperCubeValues'].includes(name) ? true : undefined; };
const genericObject = {
  getLayout: () => layout,
  getProperties: () => {
    // raw properties: one coordinate is an expression (the layout holds its value)
    const raw = JSON.parse(JSON.stringify(layout.props));
    if (raw.zones[1] && raw.zones[1].upper) raw.zones[1].upper[1].x = { qValueExpression: { qExpr: '=vThroatX' } };
    return { qInfo: layout.qInfo, props: raw };
  },
  applyPatches: rec('applyPatches'),
  getEffectiveProperties: () => ({ qInfo: layout.qInfo, props: layout.props }),
  // `&delay=ms` slows every page down (loading-indicator tests).
  getHyperCubeData: (path, pages) => (params.get('delay') ? new Promise((r) => setTimeout(r, Number(params.get('delay')))) : Promise.resolve()).then(() => pages.map((p) => {
    pagesServed++;
    const qMatrix = [];
    for (let r = p.qTop; r < Math.min(N, p.qTop + p.qHeight); r++) {
      const row = [{ ...cell(r, 'P' + r), qElemNumber: r }];
      if (CAT) row.push({ qText: CATS[r % CATS.length], qNum: NaN, qElemNumber: r % CATS.length, qState: 'O' });
      if (SHP) row.push({ qText: SHAPES[(r >> 3) % SHAPES.length], qNum: NaN, qElemNumber: (r >> 3) % SHAPES.length, qState: 'O' });
      row.push(cell(X[r]), cell(Y[r]), cell(V[r]));
      qMatrix.push(row);
    }
    return { qArea: p, qMatrix };
  })),
  beginSelections: rec('beginSelections'),
  endSelections: rec('endSelections'),
  resetMadeSelections: rec('resetMadeSelections'),
  clearSelections: rec('clearSelections'),
  rangeSelectHyperCubeValues: rec('rangeSelectHyperCubeValues'),
  multiRangeSelectHyperCubeValues: rec('multiRangeSelectHyperCubeValues'),
  selectHyperCubeValues: rec('selectHyperCubeValues'),
};
window.__pages = () => pagesServed;
(async () => {
  const t0 = performance.now();
  const app = await stardust.EnigmaMocker.fromGenericObjects([genericObject], { delay: 5 });
  const VARS = { vThroatX: -200, vCoreHalfWidth: 15, vBoxLeft: 800 };
  const baseCreate = app.createSessionObject;
  app.createSessionObject = async (def) => {
    if (def?.qInfo?.qType === 'qixHighDScatter-eval') {
      let props = def;
      // Colour functions come back as their dual text, like the engine's.
      const evalText = (x) => { const k = String(x).replace(/^=/, '').trim(); const m = /^RGB\((\d+),(\d+),(\d+)\)$/i.exec(k.replace(/\s/g, '')); return m ? `RGB(${m[1]},${m[2]},${m[3]})` : k.replace(/^'|'$/g, ''); };
      const evalExpr = (x) => { const k = String(x).replace(/^=/, '').trim(); if (k in VARS) return VARS[k]; const n = Number(k); return Number.isFinite(n) ? n : null; };
      return {
        id: 'eval-so',
        setProperties: async (p) => { props = p; window.__evalCalls = (window.__evalCalls || 0) + 1; },
        getLayout: async () => ({ e: Object.fromEntries(Object.entries(props.e || {}).map(([k, v]) => [k, v.qStringExpression ? evalText(v.qStringExpression.qExpr) : evalExpr(v.qValueExpression.qExpr)])) }),
      };
    }
    return baseCreate(def);
  };
  app.destroySessionObject = async (id) => { (window.__destroyed ||= []).push(id); };
  if (params.get('zsrc') === 'data') {
    layout.props.zoneSource = 'data';
    // zone table: one row per vertex (ZoneID, Label, Color, Edge, Seq, X, Y)
    const t = (v) => (v === null ? { qText: '-', qNum: NaN, qIsNull: true } : typeof v === 'number' ? { qText: String(v), qNum: v } : { qText: v, qNum: NaN });
    const rows = [
      ['core', 'Core (table)', '#2e7d32', 'upper', 1, -2200, 42], ['core', 'Core (table)', '#2e7d32', 'upper', 2, -650, 42], ['core', 'Core (table)', '#2e7d32', 'upper', 3, -200, 15], ['core', 'Core (table)', '#2e7d32', 'upper', 4, 3500, 15],
      ['box', 'Box (table)', 4, 'min', 1, 500, -150], ['box', 'Box (table)', 4, 'max', 2, 1500, -60],
      ['band', 'Band (table)', '#8e44ad', 'min', 1, null, 250], ['band', 'Band (table)', '#8e44ad', 'max', 2, null, 450],
    ].map((r) => r.map(t));
    window.__sessionObjects = [];
    app.createSessionObject = async (def) => {
      window.__sessionObjects.push(def);
      return { id: 'zones-so', on() {}, removeListener() {}, getLayout: async () => ({ qHyperCube: { qDataPages: [{ qMatrix: rows }] } }) };
    };
    app.destroySessionObject = async (id) => { window.__destroyed = id; };
  }
  const nebbie = stardust.embed(app, {
    context: { theme: DARK ? 'dark' : 'light', constraints: {}, interactions: params.get('edit') ? { select: false, active: true, passive: true, edit: true } : { select: true, active: true, passive: false } },
    types: [{ name: 'qixHighDScatter', load: () => Promise.resolve(window.__qhds) }],
  });
  window.__viz = await nebbie.render({ element: document.getElementById('obj'), id: 'qhds1' });
  window.__rendered = performance.now() - t0;
})().catch((e) => { window.__error = String(e && e.stack || e); console.error(e); });
