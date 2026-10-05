// Fixed colour per shape value: the Shapes tab's colour dot (grey = not set)
// opens a popover; a palette pick stores `color` on the value's map entry and
// the chart paints those points with it, overriding the zone colouring (its own
// legend class); the shape key strip shows the glyph in that colour.
// Run: node test/shape-color-test.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8771", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1300, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log("FAIL:", msg); } };

// 1. Stored fixed colour: zone colouring + shapes by AircraftType, A321 hard-set red.
const props = { shapes: { enabled: true, map: [{ value: "A321", color: "#cc0000" }] }, pointRadius: 2.2 };
await page.goto(`http://127.0.0.1:8771/test/harness/index.html?n=20000&cat=1&shape=1&edit=1&props=${encodeURIComponent(JSON.stringify(props))}`);
await page.waitForFunction(() => window.__qhdsPerf?.load, null, { timeout: 30000 }).catch(() => undefined);
await page.waitForTimeout(800);
const a = await page.evaluate(() => ({
  legend: [...document.querySelectorAll('[data-slot="chart-legend"] button')].map((b) => b.textContent.trim()).filter(Boolean),
  keyFill: document.querySelector('.qhds-shapekey [data-slot="density-shape-glyph"][data-shape] path')?.getAttribute("fill"),
  keyFills: [...document.querySelectorAll('.qhds-shapekey [data-slot="density-shape-glyph"] path')].map((p) => p.getAttribute("fill")),
}));
check(a.legend.some((t) => /^A321/.test(t)), `A321 is a legend class of its own beside the zones: ${JSON.stringify(a.legend)}`);
check(a.keyFills.includes("#cc0000") && a.keyFills.filter((f) => f === "#cc0000").length === 1, `shape key paints only A321's glyph red: ${JSON.stringify(a.keyFills)}`);

// 2. Editor: the dot is grey for A320, red for A321; pick a palette colour for A320, apply.
await page.evaluate(() => window.__qhdsOpenEditor("qhds1", "shapes"));
await page.waitForSelector('[data-testid="ze-color-A320"]', { timeout: 10000 });
const dots = await page.evaluate(() => ({
  a320: document.querySelector('[data-testid="ze-color-A320"]')?.getAttribute("data-set"),
  a321: document.querySelector('[data-testid="ze-color-A321"]')?.getAttribute("data-set"),
  a321bg: document.querySelector('[data-testid="ze-color-A321"]')?.style.background,
  popups: document.querySelectorAll(".qhds-ze-colorpop").length,
}));
check(dots.a320 === "false" && dots.a321 === "true" && /204, 0, 0|#cc0000/.test(dots.a321bg ?? ""), `dots: ${JSON.stringify(dots)}`);
check(dots.popups === 0, "no popover open at first");
await page.click('[data-testid="ze-color-A320"]');
await page.waitForTimeout(200);
const pop = await page.evaluate(() => {
  const p = document.querySelector(".qhds-ze-colorpop");
  return { open: !!p, swatches: p?.querySelectorAll(".qhds-ze-swatch").length ?? 0, first: p?.querySelector(".qhds-ze-swatch")?.getAttribute("aria-label") };
});
check(pop.open && pop.swatches >= 3, `popover with palette swatches: ${JSON.stringify(pop)}`);
await page.screenshot({ path: "build/shape-color-popover.png" });
await page.click(".qhds-ze-colorpop .qhds-ze-swatch");
await page.waitForTimeout(300);
const picked = await page.evaluate(() => ({
  popups: document.querySelectorAll(".qhds-ze-colorpop").length,
  a320: document.querySelector('[data-testid="ze-color-A320"]')?.getAttribute("data-set"),
  sub: document.querySelector('[data-testid="ze-shape-A320"] .qhds-ze-item-sub')?.textContent,
}));
check(picked.popups === 0 && picked.a320 === "true" && /fixed colour/.test(picked.sub ?? ""), `pick closes the popover and marks the row: ${JSON.stringify(picked)}`);
// Escape closes an open popover without a change.
await page.click('[data-testid="ze-color-A350"]');
await page.keyboard.press("Escape");
await page.waitForTimeout(200);
check((await page.evaluate(() => document.querySelectorAll(".qhds-ze-colorpop").length)) === 0, "Escape closes the popover");
check((await page.evaluate(() => document.querySelector('[data-testid="zone-editor"]') !== null)), "Escape in the popover does not close the editor");
await page.click('[data-testid="ze-apply"]');
await page.waitForTimeout(500);
const patch = await page.evaluate(() => {
  const call = window.__calls.filter((c) => c.name === "applyPatches").pop();
  const p = call?.args?.[0]?.find((x) => x.qPath === "/props/shapes");
  return p ? JSON.parse(p.qValue) : null;
});
const a320 = patch?.map?.find((e) => e.value === "A320");
const a321 = patch?.map?.find((e) => e.value === "A321");
check(a320 && typeof a320.color === "string" && a320.color.startsWith("#") && !a320.shape, `A320 saved with a colour and no glyph: ${JSON.stringify(a320)}`);
check(a321 && a321.color === "#cc0000", `A321 keeps its colour: ${JSON.stringify(a321)}`);
check(errors.length === 0, "page errors: " + errors.join(" | "));
console.log(JSON.stringify({ a, dots, pop, picked, patch }, null, 1));
console.log(fail ? `shape-color: ${fail} FAILED` : "shape-color: ok");
await browser.close();
server.kill();
process.exit(fail ? 1 : 0);
