import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8767", "--bind", "127.0.0.1"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 960, height: 620 } });
await page.goto(`http://127.0.0.1:8767/test/harness/index.html?n=20000`);
await page.waitForSelector('[data-slot="density-scatter-chart-plot"]');
await page.waitForTimeout(1500);
const xticks = () => page.evaluate(() => [...document.querySelectorAll('[data-slot="density-scatter-chart"] span.absolute.-translate-x-1\\/2')].map((e) => e.textContent).filter(Boolean).join("|"));
const before = await xticks();
const res = await page.evaluate(() => { const p = document.querySelector('[data-slot="density-scatter-chart-plot"]'); const r = p.getBoundingClientRect(); const ev = new WheelEvent("wheel", { deltaY: -400, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }); p.dispatchEvent(ev); return ev.defaultPrevented; });
await page.waitForTimeout(800);
const after = await xticks();
// Shake check: sample the plot box and the zoom controls every frame through a wheel zoom.
const samples = await page.evaluate(async () => {
  const plot = document.querySelector('[data-slot="density-scatter-chart-plot"]');
  const r0 = plot.getBoundingClientRect();
  const out = [];
  let stop = false;
  const tick = () => {
    const p = document.querySelector('[data-slot="density-scatter-chart-plot"]').getBoundingClientRect();
    const c = document.querySelector('[data-slot="chart-zoom-controls"]')?.getBoundingClientRect();
    out.push([Math.round(p.left), Math.round(p.width), c ? Math.round(c.left) : null, c ? Math.round(c.top) : null]);
    if (!stop) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  for (let i = 0; i < 12; i++) {
    plot.dispatchEvent(new WheelEvent("wheel", { deltaY: i < 6 ? -120 : 120, bubbles: true, cancelable: true, clientX: r0.x + r0.width * 0.3, clientY: r0.y + r0.height * 0.6 }));
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 600));
  stop = true;
  return out;
});
const uniq = (k) => [...new Set(samples.map((s) => s[k]).filter((v) => v !== null))];
await page.evaluate(() => { const p = document.querySelector('[data-slot="density-scatter-chart-plot"]'); const r = p.getBoundingClientRect(); p.dispatchEvent(new WheelEvent("wheel", { deltaY: -400, bubbles: true, cancelable: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 })); });
await page.waitForTimeout(800);
console.log(JSON.stringify({ frames: samples.length, plotLeft: uniq(0), plotWidth: uniq(1), controlsLeft: uniq(2), controlsTop: uniq(3) }));
const controls = await page.locator('[data-slot="chart-zoom-controls"]').boundingBox();
const plot = await page.locator('[data-slot="density-scatter-chart-plot"]').boundingBox();
await page.mouse.move(plot.x + 50, plot.y + 50);
await page.waitForTimeout(300);
const tbOpacity = await page.locator('[data-slot="chart-selection-toolbar"]').count(); // 0: tools live in Qlik's toolbar
await page.screenshot({ path: "build/zoomed.png" });
await page.getByRole("button", { name: /reset/i }).click();
await page.waitForTimeout(2500);
const reset = await xticks();
const ctlAfter = await page.locator('[data-slot="chart-zoom-controls"]').count();
console.log(JSON.stringify({ prevented: res, changed: before !== after, before, after, controls, plot, tbOpacity, resetOk: reset === before, reset, ctlAfter }));
await browser.close(); server.kill();
