import { classifyZones } from "../../../lib/charts/src/charts/density-scatter/zones";
import { resolveSelection } from "../../../lib/charts/src/charts/density-scatter/selection";
import { planSelection } from "../../src/selection";
const zones: any[] = [
  { id: "core", label: "Core", color: "#000", bounds: { upper: [[-2200, 42], [-650, 42], [-200, 15], [3500, 15]], lower: [[-2200, -42], [-650, -42], [-200, -15], [3500, -15]] } },
  { id: "box", label: "Box", color: "#000", bounds: { x: [800, 1600], y: [-120, -60] } },
  { id: "poly", label: "Poly", color: "#000", bounds: { polygon: [[-1500, 100], [-800, 250], [-300, 120], [-900, 60]] } },
  { id: "beyond", label: "Beyond", color: "#000", invert: true, bounds: { y: [-200, 200] } },
  { id: "floor", label: "Floor", color: "#000", bounds: { line: [[-1000, -150], [0, -60], [1500, -90]], side: "below", extend: { start: true, end: false } } },
  { id: "tube", label: "Tube", color: "#000", bounds: { upper: [[0, 180], [1000, 170]], lower: [[0, 140], [1000, 150]], extend: { end: true } } },
];
let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
const n = 200000; const x = new Float32Array(n); const y = new Float32Array(n);
for (let i = 0; i < n; i++) { x[i] = -2400 + rnd() * 6100; y[i] = (rnd() - 0.5) * 600; }
const pts = { x, y, n, values: {}, categories: {} } as any;
const cls = classifyZones(pts, zones);
const order = zones.map((z) => z.id);
const domain = { x0: -2400, x1: 3700, y0: -300, y1: 300 };
const cases: [string, any][] = [
  ["box zone", { zones: ["box"] }],
  ["core (envelope)", { zones: ["core"] }],
  ["poly", { zones: ["poly"] }],
  ["beyond (inverted band)", { zones: ["beyond"] }],
  ["outside class", { zones: ["__outside"] }],
  ["x range ∧ y range", { x: [-500, 1200], y: [-100, 80] }],
  ["lasso ∧ core", { lasso: [[-1000, -100], [500, -150], [800, 100], [-600, 150]], zones: ["core"] }],
  ["box + outside", { zones: ["box", "__outside"] }],
  ["line below, open left", { zones: ["floor"] }],
  ["envelope open right", { zones: ["tube"] }],
];
for (const [name, sel] of cases) {
  const want = new Uint8Array(n);
  resolveSelection(pts, cls, order, sel, want);
  const plan = planSelection(sel, zones, domain);
  const rects = plan.rects!;
  let fn = 0, fp = 0, sel1 = 0; const fpBy: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const inR = rects.some((r) => x[i]! >= r.x0 && x[i]! <= r.x1 && y[i]! >= r.y0 && y[i]! <= r.y1);
    if (want[i]) sel1++;
    if (want[i] && !inR) fn++;
    if (!want[i] && inR) { fp++; const k = zones[cls[i]!]?.id ?? "outside"; fpBy[k] = (fpBy[k] || 0) + 1; }
  }
  console.log(`${name.padEnd(26)} rects=${String(rects.length).padStart(4)} selected=${String(sel1).padStart(6)} missed=${fn} extra=${fp} (${((fp / Math.max(1, sel1)) * 100).toFixed(2)}%) ${fp > 100 ? JSON.stringify(fpBy) : ""}`);
}
