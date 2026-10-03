// Circle + quadrant zones straight from layout: legend entries, classification, stats, legend click.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8767", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const zones = [
  { cId: "c1", kind: "circle", label: "Core", cx: 0, cy: 0, rx: 800, ry: 120, color: { index: -1, color: "#d62728" } },
  { cId: "q1", kind: "quadrant", label: "Quads", xSplit: 500, ySplit: "", q0Label: "Stars", q1Label: "Cows", q2Label: "Dogs", q3Label: "Puzzles",
    q0Color: { index: -1, color: "#1f77b4" }, q1Color: { index: -1, color: "#2ca02c" }, q2Color: { index: -1, color: "#9467bd" }, q3Color: { index: -1, color: "#ff7f0e" } },
];
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
const logs = [];
page.on("console", (m) => m.type() === "error" && logs.push(m.text()));
await page.goto(`http://127.0.0.1:8767/test/harness/index.html?n=20000&props=${encodeURIComponent(JSON.stringify({ showStats: true }))}&zones=${encodeURIComponent(JSON.stringify(zones))}`);
await page.waitForTimeout(4500);
const legend = await page.evaluate(() => [...document.querySelectorAll('[data-slot="density-scatter-chart-legend"] button, [data-slot$="legend-item"]')].map((b) => b.textContent.trim()));
const stats = await page.evaluate(() => document.querySelector(".qhds-stats")?.textContent);
await page.screenshot({ path: "build/render-shapes.png" });
// click the "Stars" legend entry
const btn = page.locator("button", { hasText: "Stars" }).first();
let clicked = null;
if (await btn.count()) { await btn.click(); await page.waitForTimeout(600); clicked = { pressed: await btn.getAttribute("aria-pressed"), calls: await page.evaluate(() => (window.__calls || []).slice(-3)) }; }
await page.screenshot({ path: "build/render-shapes-click.png" });
console.log(JSON.stringify({ legend, stats, clicked, logs: logs.slice(0, 5) }, null, 1));
await browser.close();
server.kill();
