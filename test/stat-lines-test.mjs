// Reference lines per zone: render, tags, description, legend hide, zoom.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8769", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: "/home/claude/qhds" });
await new Promise((r) => setTimeout(r, 800));
const statLines = [
  { stat: "Average", axis: "y", by: "class", span: "class", labelMode: "computation", lineStyle: "auto" },
  { stat: "Std dev", k: 1, axis: "y", by: "class", span: "class", labelMode: "computation", lineStyle: "auto" },
  { stat: "Median", axis: "x", by: "all", labelMode: "computation", lineStyle: "auto" },
];
const out = process.argv[2] || "/tmp/claude-0/stat";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
await page.goto(`http://127.0.0.1:8769/test/harness/index.html?n=200000&props=${encodeURIComponent(JSON.stringify({ statLines }))}`);
await page.waitForTimeout(5000);
const snap = () => page.evaluate(() => ({
  lines: [...document.querySelectorAll('[data-slot="density-scatter-chart-stat-line"]')].map((l) => ({ stroke: l.getAttribute("stroke"), dash: l.getAttribute("stroke-dasharray"), x1: +l.getAttribute("x1"), x2: +l.getAttribute("x2"), y1: +l.getAttribute("y1"), y2: +l.getAttribute("y2") })),
  tags: [...document.querySelectorAll('[data-slot="density-scatter-chart-stat-tag"]')].map((t) => t.textContent),
  desc: document.getElementById(document.querySelector('[data-slot="density-scatter-chart"]').getAttribute("aria-describedby")?.split(" ")[0])?.textContent,
}));
const s0 = await snap();
console.log("initial", JSON.stringify({ n: s0.lines.length, tags: s0.tags, desc: s0.desc }, null, 1));
await page.screenshot({ path: `${out}-1.png` });
// Hide the first legend entry → its lines go.
const legendBtn = page.locator('[data-slot="chart-legend"] button').first();
if (await legendBtn.count()) {
  await legendBtn.click();
  await page.waitForTimeout(1500);
  const s1 = await snap();
  console.log("after hide", s1.lines.length, s1.tags);
  await legendBtn.click();
  await page.waitForTimeout(1500);
}
// Zoom in: lines stay, move.
const plot = await page.locator('[data-slot="density-scatter-chart-plot"]').boundingBox();
await page.mouse.move(plot.x + plot.width * 0.5, plot.y + plot.height * 0.5);
for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, -120); await page.waitForTimeout(120); }
await page.waitForTimeout(1500);
const s2 = await snap();
console.log("zoomed", s2.lines.length, s2.tags);
await page.screenshot({ path: `${out}-2.png` });
console.log("errors", errors);
await browser.close(); server.kill();
