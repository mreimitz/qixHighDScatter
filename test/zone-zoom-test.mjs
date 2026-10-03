// A slanted line zone must keep its DATA slope while zooming in.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8767", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const zones = [{ cId: "l1", kind: "line", label: "Slope", side: "above", extendStart: true, extendEnd: true,
  line: [{ x: -2000, y: 300 }, { x: 3000, y: -300 }], color: { index: -1, color: "#2ca02c" } }];
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
await page.goto(`http://127.0.0.1:8767/test/harness/index.html?n=20000&zones=${encodeURIComponent(JSON.stringify(zones))}`);
await page.waitForTimeout(4000);
const plot = await page.locator('[data-slot="density-scatter-chart-plot"]').boundingBox();
// data slope of the drawn edge, using tick labels to map px → data
const measure = () => page.evaluate(() => {
  const svg = document.querySelector('[data-slot="density-scatter-chart-overlay"]');
  const lines = [...svg.querySelectorAll('g[stroke] polyline')].filter((p) => p.closest("g").getAttribute("stroke") !== "var(--chart-grid)");
  const pts = lines[0].getAttribute("points").trim().split(" ").map((s) => s.split(",").map(Number));
  const parse = (t) => { const m = t.replace("−", "-").match(/^(-?[\d.]+)(k?)$/); return m ? Number(m[1]) * (m[2] ? 1000 : 1) : NaN; };
  const tickPos = (axis) => {
    const out = [];
    for (const el of document.querySelectorAll('[data-slot="density-scatter-chart"] *')) {
      if (el.children.length || !el.textContent.trim()) continue;
      const v = parse(el.textContent.trim());
      if (!Number.isFinite(v)) continue;
      const r = el.getBoundingClientRect();
      out.push({ v, x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width });
    }
    return out;
  };
  const all = tickPos();
  const svgR = svg.getBoundingClientRect();
  // x ticks share a y (lowest row); y ticks share an x (leftmost column)
  const maxY = Math.max(...all.map((t) => t.y));
  const xt = all.filter((t) => Math.abs(t.y - maxY) < 2);
  const minX = Math.min(...all.map((t) => t.x + t.w / 2));
  const yt = all.filter((t) => Math.abs(t.x + t.w / 2 - minX) < 3);
  const fit = (a, b) => { const k = (b[1] - a[1]) / (b[0] - a[0]); return (p) => a[1] + (p - a[0]) * k; };
  const xs = xt.sort((a, b) => a.x - b.x), ys = yt.sort((a, b) => a.y - b.y);
  const fx = fit([xs[0].x - svgR.x, xs[0].v], [xs.at(-1).x - svgR.x, xs.at(-1).v]);
  const fy = fit([ys[0].y - svgR.y, ys[0].v], [ys.at(-1).y - svgR.y, ys.at(-1).v]);
  const d = pts.map(([x, y]) => [fx(x), fy(y)]);
  // slope of the drawn slanted part: the two points nearest the middle of the polyline
  const seg = d.filter((p, i) => i > 0 && Math.abs(p[1] - d[i - 1][1]) > 1e-9);
  const a = d[d.indexOf(seg[0]) - 1], b = seg[0];
  return { slope: (b[1] - a[1]) / (b[0] - a[0]), xticks: xs.map((t) => t.v).join("|") };
});
const out = [await measure()];
for (let i = 0; i < 6; i++) {
  // zoom onto the middle of the drawn slanted segment, so it stays in view
  const anchor = await page.evaluate(() => {
    const svg = document.querySelector('[data-slot="density-scatter-chart-overlay"]');
    const pl = [...svg.querySelectorAll("polyline")].find((p) => p.parentElement.getAttribute("stroke")?.startsWith("rgb"));
    const pts = pl.getAttribute("points").trim().split(" ").map((s) => s.split(",").map(Number));
    const i = pts.findIndex((p, k) => k > 0 && p[1] !== pts[k - 1][1]);
    const r = svg.getBoundingClientRect();
    return [r.x + (pts[i - 1][0] + pts[i][0]) / 2, r.y + (pts[i - 1][1] + pts[i][1]) / 2];
  });
  await page.mouse.move(anchor[0], anchor[1]);
  await page.mouse.wheel(0, -400);
  await page.waitForTimeout(900);
  out.push(await measure());
  await page.screenshot({ path: `build/zone-zoom-${i}.png` });
}
console.log(JSON.stringify(out, null, 0), "expected slope", -600 / 5000);
await browser.close();
server.kill();
