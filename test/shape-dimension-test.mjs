// Colour by the 2nd dimension (Airline) and shape by the 3rd (AircraftType):
// the shape key under the plot lists the 3rd dimension's values with glyphs,
// the legend keeps plain colour swatches, the dots are drawn with four glyphs.
// Run: node test/shape-dimension-test.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8768", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1200, height: 760 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log("FAIL:", msg); } };

const open = async (qs) => {
  await page.goto(`http://127.0.0.1:8768/test/harness/index.html${qs}`);
  await page.waitForFunction(() => window.__qhdsPerf?.load, null, { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  return page.evaluate(() => ({
    legend: [...document.querySelectorAll('[data-slot="chart-legend"] button')].map((b) => b.textContent.trim()).filter(Boolean),
    legendGlyphs: document.querySelectorAll('[data-slot="chart-legend"] [data-slot="density-shape-glyph"]').length,
    shapeKey: document.querySelector(".qhds-shapekey")?.textContent ?? null,
    shapeKeyGlyphs: [...document.querySelectorAll('.qhds-shapekey [data-slot="density-shape-glyph"]')].map((g) => g.getAttribute("data-shape")),
    stats: document.querySelector(".qhds-stats")?.textContent ?? null,
    load: window.__qhdsPerf?.load,
  }));
};

// 1. colour by Airline (2nd), shape by AircraftType (3rd)
const a = await open(`?n=30000&cat=1&shape=1&colorBy=category&props=${encodeURIComponent(JSON.stringify({ shapes: { enabled: true, map: [{ value: "A350", shape: "star" }] }, showStats: true, pointRadius: 2.2 }))}`);
await page.screenshot({ path: "build/shape-dimension.png" });
check(a.legend.length === 6 && a.legend.some((t) => /Aurora Air/.test(t)), `legend shows the six airlines: ${JSON.stringify(a.legend)}`);
check(a.legendGlyphs === 0, `legend keeps colour swatches (no glyphs), got ${a.legendGlyphs}`);
check(a.shapeKey && /AircraftType/.test(a.shapeKey) && /A320/.test(a.shapeKey) && /B38M/.test(a.shapeKey), `shape key lists the 3rd dimension: ${a.shapeKey}`);
check(a.shapeKeyGlyphs.length === 4 && a.shapeKeyGlyphs.includes("star"), `four glyphs incl. the pinned star: ${JSON.stringify(a.shapeKeyGlyphs)}`);
check(a.load?.totalMs !== undefined, "loaded");

// 2. no 3rd dimension: shapes fall back to the 2nd (legend swatches become glyphs, no key strip)
const b = await open(`?n=30000&cat=1&colorBy=category&props=${encodeURIComponent(JSON.stringify({ shapes: { enabled: true, map: [] }, pointRadius: 2.2 }))}`);
check(b.legendGlyphs >= 5, `without a 3rd dimension the legend swatches are the glyphs (circle may stay a dot), got ${b.legendGlyphs}`);
check(b.shapeKey === null, "no shape key strip when colour and shape share the 2nd dimension");

// 3. colour by zone, shape by the 3rd dimension: key strip lists AircraftType
const c = await open(`?n=30000&cat=1&shape=1&props=${encodeURIComponent(JSON.stringify({ shapes: { enabled: true, map: [] }, pointRadius: 2.2 }))}`);
check(c.shapeKey && /AircraftType/.test(c.shapeKey), `zone colour + 3rd-dimension shapes: key strip ${c.shapeKey}`);

check(errors.length === 0, "page errors: " + errors.join(" | "));
console.log(JSON.stringify({ a: { legend: a.legend, shapeKey: a.shapeKey, glyphs: a.shapeKeyGlyphs }, b: { legendGlyphs: b.legendGlyphs }, c: { shapeKey: c.shapeKey } }, null, 1));
console.log(fail ? `shape-dimension: ${fail} FAILED` : "shape-dimension: ok");
await browser.close();
server.kill();
process.exit(fail ? 1 : 0);
