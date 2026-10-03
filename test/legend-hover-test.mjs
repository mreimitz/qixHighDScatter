// Hovering the legend must not make the plot flicker.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8770", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const pos = process.argv[2] || "right";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
await page.addInitScript(() => {
  window.__draws = 0; window.__clears = 0; window.__c2d = 0;
  for (const P of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const d = P.drawArrays; P.drawArrays = function (...a) { window.__draws++; return d.apply(this, a); };
    const c = P.clear; P.clear = function (...a) { window.__clears++; return c.apply(this, a); };
  }
  const cr = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function (...a) { window.__c2d++; return cr.apply(this, a); };
});
await page.goto(`http://127.0.0.1:8770/test/harness/index.html?n=50000&props=${encodeURIComponent(JSON.stringify({ legendPosition: pos }))}`);
await page.waitForTimeout(4000);
await page.evaluate(() => {
  window.__mut = [];
  const root = document.querySelector('[data-slot="density-scatter-chart"]');
  new MutationObserver((ms) => { for (const m of ms) window.__mut.push(m.type + ":" + (m.target.getAttribute?.("data-slot") || m.target.nodeName) + ":" + (m.attributeName || [...m.addedNodes, ...m.removedNodes].map((n) => n.getAttribute?.("data-slot") || n.nodeName).join(","))); }).observe(document.body, { subtree: true, childList: true, attributes: true });
  window.__canvases = () => [...document.querySelectorAll("canvas")].length;
});
await page.mouse.move(5, 5);
await page.waitForTimeout(500);
await page.evaluate(() => { window.__draws = 0; window.__clears = 0; window.__c2d = 0; });
const items = page.locator('[data-slot="chart-legend"] button, [data-slot="chart-legend"] [data-slot="chart-legend-item"]');
console.log("legend items", await items.count());
const sizes = [];
for (let r = 0; r < 2; r++) for (let i = 0; i < (await items.count()); i++) {
  const b = await items.nth(i).boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 3 });
  await page.waitForTimeout(150);
  sizes.push(await page.evaluate(() => { const p = document.querySelector('[data-slot="density-scatter-chart-plot"]').getBoundingClientRect(); const l = document.querySelector('[data-slot="chart-legend"]').getBoundingClientRect(); return `${Math.round(p.width)}x${Math.round(p.height)} L${Math.round(l.x)},${Math.round(l.y)},${Math.round(l.width)}`; }));
}
const muts = await page.evaluate(() => window.__mut);
const counts = {};
for (const m of muts) counts[m] = (counts[m] || 0) + 1;
console.log(JSON.stringify(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 25), null, 0));
console.log([...new Set(sizes)]);
console.log("draws", await page.evaluate(() => [window.__draws, window.__clears, window.__c2d]));
await browser.close(); server.kill();
