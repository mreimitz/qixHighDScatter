// The legend's tail (no-GPU warning + statistics box): never over the plot, hung
// off the legend (below a side legend / right end of a bottom legend / a strip
// without a legend), stats hidden first and warning second when room runs out,
// and the warning does not jump around when the object is resized.
// Run: node test/tail-layout-test.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8766", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));

const cases = [
  { name: "wide, side legend", w: 1100, h: 560, props: { showStats: true } },
  { name: "tall, bottom legend", w: 620, h: 720, props: { showStats: true } },
  { name: "legend left", w: 1100, h: 560, props: { showStats: true, legendPosition: "left" } },
  { name: "no legend (strip)", w: 900, h: 520, props: { showStats: true, legendShow: false } },
  { name: "small side legend: stats go first", w: 700, h: 260, props: { showStats: true, legendPosition: "right" } },
  { name: "narrow bottom legend: stats go first", w: 440, h: 500, props: { showStats: true } },
  { name: "wide bottom legend: row with stats", w: 1000, h: 520, props: { showStats: true, legendPosition: "bottom" } },
  { name: "tiny: nothing", w: 240, h: 180, props: { showStats: true } },
];
const results = [];
for (const c of cases) {
  const qs = `?n=20000&nogpu=1&w=${c.w}&h=${c.h}&props=${encodeURIComponent(JSON.stringify(c.props))}`;
  await page.goto(`http://127.0.0.1:8766/test/harness/index.html${qs}`);
  await page.waitForFunction(() => document.querySelector('[role="figure"]') && (window.__qhdsPerf?.load || document.querySelector(".qhds-tail") || performance.now() > 15000), null, { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(900);
  const r = await page.evaluate(() => {
    const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
    const frame = document.querySelector(".qhds-frame");
    const legendRoot = document.querySelector('[data-slot="container-legend-root"]');
    const legend = legendRoot?.querySelector('[data-slot="chart-legend"]');
    const plot = document.querySelector(".qhds-frame canvas");
    return {
      frame: rect(frame), legendPos: legendRoot?.getAttribute("data-container-legend-position") ?? "none",
      legend: rect(legend), plot: rect(plot), tailMode: document.querySelector(".qhds-tail")?.getAttribute("data-mode") ?? "none",
      warn: rect(document.querySelector(".qhds-gpu")), stats: rect(document.querySelector(".qhds-stats")),
    };
  });
  await page.screenshot({ path: `build/tail-${c.name.replace(/[^a-z0-9]+/gi, "_")}.png` });
  results.push({ ...c, ...r });
}

// Resize stability: same page, legend on the right, grow/shrink the object; the
// warning must stay below the legend and never land over the plot.
const stab = [];
await page.goto(`http://127.0.0.1:8766/test/harness/index.html?n=20000&nogpu=1&w=1000&h=560&props=${encodeURIComponent(JSON.stringify({ showStats: true, legendPosition: "right" }))}`);
await page.waitForTimeout(2500);
for (const [w, h] of [[1000, 560], [1100, 600], [900, 520], [1200, 640], [1000, 560]]) {
  await page.evaluate(([w, h]) => { const o = document.getElementById("obj"); o.style.width = w + "px"; o.style.height = h + "px"; window.dispatchEvent(new Event("resize")); }, [w, h]);
  await page.waitForTimeout(700);
  stab.push(await page.evaluate(([w, h]) => {
    const rect = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { l: Math.round(b.left), t: Math.round(b.top), r: Math.round(b.right), b: Math.round(b.bottom) }; };
    const legend = document.querySelector('[data-slot="container-legend-root"] [data-slot="chart-legend"]');
    return { w, h, legend: rect(legend), warn: rect(document.querySelector(".qhds-gpu")), plot: rect(document.querySelector(".qhds-frame canvas")), mode: document.querySelector(".qhds-tail")?.getAttribute("data-mode") };
  }, [w, h]));
}

const inside = (a, b) => a && b && a.l >= b.l - 1 && a.t >= b.t - 1 && a.r <= b.r + 1 && a.b <= b.b + 1;
const overlaps = (a, b) => a && b && a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log("FAIL:", msg); } };
for (const r of results) {
  for (const el of ["warn", "stats"]) {
    if (r[el]) {
      check(inside(r[el], r.frame), `${r.name}: ${el} outside the frame ${JSON.stringify(r[el])} vs ${JSON.stringify(r.frame)}`);
      check(!overlaps(r[el], r.plot), `${r.name}: ${el} over the plot ${JSON.stringify(r[el])} plot ${JSON.stringify(r.plot)}`);
      if (r.legend) check(!overlaps(r[el], r.legend), `${r.name}: ${el} over the legend`);
    }
  }
  if (r.legend && r.warn && (r.legendPos === "right" || r.legendPos === "left")) check(r.warn.t >= r.legend.b - 2 && Math.abs(r.warn.l - r.legend.l) < 12 && r.frame.b - (r.stats ? r.stats.b : r.warn.b) <= 12, `${r.name}: side tail not at the foot of the legend column`);
  if (r.legend && r.stats && r.warn && (r.legendPos === "right" || r.legendPos === "left")) check(r.stats.t >= r.warn.b - 2, `${r.name}: stats not below the warning`);
  if (r.legend && r.warn && (r.legendPos === "bottom" || r.legendPos === "top")) check(r.warn.l >= r.legend.r - 400 && r.warn.t >= r.legend.t - 4 && r.warn.b <= r.legend.b + 4, `${r.name}: warning not at the end of the legend row`);
}
check(results[4].stats === null && results[4].warn !== null, "small side legend keeps the warning but drops the stats");
check(results[5].stats === null && results[5].warn !== null, "narrow bottom legend keeps the warning but drops the stats");
check(results[7].stats === null && results[7].warn === null, "tiny object shows neither");
check(results[6].tailMode === "row" && results[6].stats && results[6].warn && results[6].stats.b - results[6].stats.t < 30, "wide bottom legend: one-line stats in the row");
check(results[3].tailMode === "strip" && results[3].stats && results[3].warn, "no legend → strip with both");
for (const s of stab) {
  check(s.warn && s.legend && s.warn.t >= s.legend.b - 2 && Math.abs(s.warn.l - s.legend.l) < 12 && !overlaps(s.warn, s.plot) && s.plot.b - s.warn.b < 90, `resize ${s.w}×${s.h}: warning left the foot of the legend column (${JSON.stringify(s.warn)} legend ${JSON.stringify(s.legend)} plot ${JSON.stringify(s.plot)})`);
}
check(errors.length === 0, "page errors: " + errors.join(" | "));
console.log(JSON.stringify({ results: results.map(({ name, legendPos, tailMode, warn, stats }) => ({ name, legendPos, tailMode, warn, stats })), stab }, null, 1));
console.log(fail ? `tail-layout: ${fail} FAILED` : "tail-layout: ok");
await browser.close();
server.kill();
process.exit(fail ? 1 : 0);
