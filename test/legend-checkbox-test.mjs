// Legend: no flicker crossing gaps, hover-revealed checkbox hides a zone, title, entry click selects.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8771", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: "/home/claude/qhds" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
const props = { legendPosition: "right", statLines: [{ stat: "mean", axis: "y", by: "class" }] };
await page.goto(`http://127.0.0.1:8771/test/harness/index.html?n=50000&props=${encodeURIComponent(JSON.stringify(props))}`);
await page.waitForTimeout(4000);
const legend = page.locator('[data-slot="chart-legend"]');
console.log("title:", await legend.locator("h3").textContent().catch(() => "(none)"));
const rows = legend.locator('[data-slot="chart-legend-row"]');
const n = await rows.count();
console.log("rows", n);
const op = (i) => rows.nth(i).locator('[data-slot="chart-legend-toggle"]').evaluate((e) => getComputedStyle(e).opacity);
await page.mouse.move(5, 5); await page.waitForTimeout(300);
console.log("checkbox opacity at rest:", await op(0));
// Flicker: record every hovered-index change while sweeping slowly top→bottom.
await page.evaluate(() => {
  window.__hov = [];
  new MutationObserver(() => {
    const h = [...document.querySelectorAll('[data-slot="chart-legend"] [data-hovered]')].map((e) => e.textContent).join("|") || "-";
    if (window.__hov.at(-1) !== h) window.__hov.push(h);
  }).observe(document.querySelector('[data-slot="chart-legend"]'), { subtree: true, attributes: true, attributeFilter: ["data-hovered"] });
});
const b0 = await rows.nth(0).boundingBox();
const bl = await rows.nth(n - 1).boundingBox();
await page.mouse.move(b0.x + 30, b0.y + 2);
await page.mouse.move(bl.x + 30, bl.y + bl.height - 2, { steps: 60 });
await page.waitForTimeout(300);
const hov = await page.evaluate(() => window.__hov);
console.log("hover sequence:", hov.length, hov.includes("-") ? "CLEARED MID-SWEEP (flicker)" : "no clear mid-sweep");
await rows.nth(0).hover(); await page.waitForTimeout(250);
console.log("checkbox opacity on hover:", await op(0));
const lines0 = await page.locator('[data-slot="density-scatter-chart-stat-line"]').count();
const name0 = await rows.nth(0).locator("button").first().textContent();
await rows.nth(0).locator('[data-slot="chart-legend-toggle"]').click();
await page.waitForTimeout(600);
const lab = rows.nth(0).locator("span.line-through");
console.log("hid", name0, "struck:", await lab.count(), "checked:", await rows.nth(0).locator('[role="checkbox"]').getAttribute("aria-checked"),
  "stat lines", lines0, "->", await page.locator('[data-slot="density-scatter-chart-stat-line"]').count());
await page.screenshot({ path: "/tmp/claude-0/legend-cb-1.png" });
await rows.nth(0).locator('[data-slot="chart-legend-toggle"]').click();
await page.waitForTimeout(500);
console.log("re-shown checked:", await rows.nth(0).locator('[role="checkbox"]').getAttribute("aria-checked"));
// Entry click → selection in the harness
await rows.nth(1).locator("button").first().click();
await page.waitForTimeout(800);
console.log("after entry click, engine calls:", await page.evaluate(() => window.__calls.map((c) => c.name).slice(-4)), "hidden rows:", await legend.locator("span.line-through").count());
await rows.nth(1).hover(); await page.waitForTimeout(200);
await page.screenshot({ path: "/tmp/claude-0/legend-cb-2.png" });
// Title off
await page.goto(`http://127.0.0.1:8771/test/harness/index.html?n=20000&props=${encodeURIComponent(JSON.stringify({ legendPosition: "bottom", legendTitleShow: false }))}`);
await page.waitForTimeout(3000);
console.log("title off → h3 count:", await page.locator('[data-slot="chart-legend"] h3').count());
await page.goto(`http://127.0.0.1:8771/test/harness/index.html?n=20000&props=${encodeURIComponent(JSON.stringify({ legendPosition: "bottom", legendTitle: "Lanes" }))}`);
await page.waitForTimeout(3000);
console.log("custom title:", await page.locator('[data-slot="chart-legend"] h3').textContent());
await page.screenshot({ path: "/tmp/claude-0/legend-cb-3.png" });
console.log("page errors:", errors);
await browser.close(); server.kill();
