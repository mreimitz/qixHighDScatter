import { planSelection, toEngineSelect } from "../../src/selection";
const dom = { x0: 5, x1: 45, y0: 55000, y1: 100000 };
const cases: any[] = [
  ["x only", { x: [37, 42] }, []],
  ["x + y", { x: [37, 42], y: [60000, 90000] }, []],
  ["x + empty points", { x: [37, 42], points: [] }, []],
  ["x + empty zones", { x: [37, 42], zones: [] }, []],
  ["x + empty lasso", { x: [37, 42], lasso: [] }, []],
  ["x outside domain", { x: [50, 60] }, []],
  ["x no domain", { x: [37, 42] }, [], undefined],
];
for (const [name, sel, zones, d] of cases) {
  const plan = planSelection(sel, zones, d === undefined && cases.length ? (name === "x no domain" ? undefined : dom) : dom);
  console.log(name, JSON.stringify(plan.rects?.slice(0, 3)), JSON.stringify(toEngineSelect(plan)).slice(0, 160));
}
