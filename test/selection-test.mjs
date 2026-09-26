import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8766", "--bind", "127.0.0.1"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 960, height: 620 } });
const logs = [];
page.on("console", (m) => { if (m.type() !== "log") logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:8766/test/harness/index.html?n=100000`);
await page.waitForFunction(() => { const f = document.querySelector('[role="figure"]'); const d = f && document.getElementById(f.getAttribute("aria-describedby") || ""); return d && d.textContent.startsWith("100,000 points"); }, null, { timeout: 60000 });
await page.waitForTimeout(500);
const calls = () => page.evaluate(() => { const c = window.__calls; window.__calls = []; return c; });
const summarize = (c) => c.map((x) => x.name === "selectHyperCubeValues" ? `${x.name}(dim ${x.args[1]}, ${x.args[2].length} values, toggle=${x.args[3]})` : x.name === "multiRangeSelectHyperCubeValues" ? `${x.name}(${x.args[1].length} rects)` : x.name === "rangeSelectHyperCubeValues" ? `${x.name}(${x.args[1].map((r) => `m${r.qMeasureIx}:[${Math.round(r.qRange.qMin)}..${Math.round(r.qRange.qMax)}]`).join(" ")})` : x.name);
const results = {};
const plot = await page.locator('[data-slot="density-scatter-chart"] canvas').first().boundingBox();
results.plot = plot;
const cx = plot.x + plot.width / 2, cy = plot.y + plot.height / 2;

// 1) Axis range: drag along the x axis (under the plot) → rangeSelect on the x measure
const plotBox = await page.locator('[data-slot="density-scatter-chart-plot"]').boundingBox();
const axisY = plotBox.y + plotBox.height + 10;
await page.mouse.move(cx - 150, axisY); await page.mouse.down(); await page.mouse.move(cx - 20, axisY, { steps: 8 }); await page.mouse.move(cx + 100, axisY, { steps: 8 });
results.rangeLive = await page.evaluate(() => ({ bubbles: [...document.querySelectorAll('[data-slot="density-scatter-chart-range-bubble"]')].map((b) => b.textContent), strip: !!document.querySelector('[data-slot="density-scatter-chart-x-range"]') }));
await page.mouse.up();
await page.waitForTimeout(600);
results.range = summarize(await calls());
results.readout1 = await page.evaluate(() => document.querySelector('[data-slot="density-scatter-chart-status"]')?.textContent);
await page.screenshot({ path: "build/range.png" });

// 2) Lasso armed (as Qlik's toolbar action would) → freehand polygon → multiRange rects
await page.evaluate(() => document.getElementById("obj").querySelector(".qhds")?.parentElement?.__qhdsLasso?.(true));
await page.waitForTimeout(200);
const pts = [[-200, -80], [-60, -120], [80, -60], [120, 60], [-40, 100], [-180, 40]];
await page.mouse.move(cx + pts[0][0], cy + pts[0][1]); await page.mouse.down();
for (const p of [...pts.slice(1), pts[0]]) await page.mouse.move(cx + p[0], cy + p[1], { steps: 6 });
await page.mouse.up();
await page.waitForTimeout(600);
results.lasso = summarize(await calls());
await page.evaluate(() => document.getElementById("obj").querySelector(".qhds")?.parentElement?.__qhdsLasso?.(false));

// 2b) Click a dot → selectHyperCubeValues toggle on the point dimension
await page.mouse.click(cx, cy);
await page.waitForTimeout(500);
results.pointClick = summarize(await calls());

// 3) Legend plain click a zone → zone selection (native Qlik behaviour)
await page.getByRole("button", { name: /^Core$/ }).first().click();
await page.waitForTimeout(600);
results.zone = summarize(await calls());

// 4) second legend click adds Expanded (toggle, like Qlik)
await page.getByRole("button", { name: /^Expanded$/ }).first().click();
await page.waitForTimeout(600);
results.legendAdd = summarize(await calls());
results.pointsStillDrawn = await page.evaluate(() => document.querySelector('[data-slot="density-scatter-chart-status"]')?.textContent);
await page.screenshot({ path: "build/selection.png" });
results.logs = logs.slice(0, 15);
console.log(JSON.stringify(results, null, 1));
await browser.close(); server.kill();
