// Color scheme (Appearance › Colors and legend › Color scheme, and the editor's
// Colors tab): `props.colors.scheme` = "12" (default) keeps twelve values on the
// twelve series tokens and puts the rest in "Other"; "100" gives up to a hundred
// values a colour of their own from the theme's 100-colour palette.
// Run: node test/color-scheme-test.mjs
//   On a dev machine: PW_BROWSERS=<playwright cache> (or CHROMIUM=<binary>).
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = process.env.PW_BROWSERS || "/opt/pw-browsers";
const exe =
  process.env.CHROMIUM ||
  (existsSync(dir) ? readdirSync(dir) : [])
    .filter((d) => d.startsWith("chromium"))
    .flatMap((d) => [
      `${dir}/${d}/chrome-linux/chrome`,
      `${dir}/${d}/chrome-linux64/chrome`,
      `${dir}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${dir}/${d}/chrome-mac/Chromium.app/Contents/MacOS/Chromium`,
    ])
    .find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8776", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log("FAIL:", msg); } };

const CATS = 40;
const load = async (colors) => {
  const props = { colors, pointRadius: 2, legendPosition: "right" };
  await page.goto(`http://127.0.0.1:8776/test/harness/index.html?n=20000&cat=1&cats=${CATS}&edit=1&colorBy=category&props=${encodeURIComponent(JSON.stringify(props))}`);
  await page.waitForFunction(() => window.__qhdsPerf?.load, null, { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(900);
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-slot="chart-legend-row"]')].map((row) => [
      row.querySelector("span")?.textContent?.trim(),
      row.querySelector('div[style*="background-color"]')?.style.backgroundColor,
    ]),
  );
};
const distinct = (rows) => new Set(rows.filter(([l]) => l !== "Other").map(([, c]) => c)).size;
// What the WebGL canvas actually painted: distinct opaque colours in the plot.
const painted = () =>
  page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find((x) => x.getContext("webgl"));
    const g = document.createElement("canvas");
    g.width = c.width;
    g.height = c.height;
    const ctx = g.getContext("2d");
    ctx.drawImage(c, 0, 0);
    const d = ctx.getImageData(0, 0, g.width, g.height).data;
    const seen = new Set();
    // Dots are translucent: count the hue of solid-enough pixels, quantised.
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 3] > 200) seen.add(((d[i] >> 4) << 8) | ((d[i + 1] >> 4) << 4) | (d[i + 2] >> 4));
    return seen.size;
  });

// 1. Default (12): twelve classes and "Other".
const twelve = await load({ persistent: false, map: [] });
check(twelve.some(([l]) => l === "Other"), `12 colors → an "Other" class: ${twelve.length} rows`);
check(twelve.filter(([l]) => l !== "Other").length === 12, `12 colors → twelve values of their own: ${twelve.length}`);
const paint12 = await painted();

// 2. 100: every value its own class and colour, no "Other".
const hundred = await load({ scheme: "100", persistent: false, map: [] });
check(!hundred.some(([l]) => l === "Other"), `100 colors → no "Other"`);
check(hundred.length === CATS, `100 colors → a class per value: ${hundred.length}`);
check(distinct(hundred) === CATS, `100 colors → ${CATS} distinct colours: ${distinct(hundred)}`);
await page.screenshot({ path: "build/color-scheme-100.png" });
const paint100 = await painted();
check(paint100 > paint12, `the GPU paints more colours with 100 (${paint100}) than 12 (${paint12})`);

// 3. 100 + persistent: the colour follows the name.
const p1 = Object.fromEntries(await load({ scheme: "100", persistent: true, map: [] }));
check(Object.keys(p1).length === CATS && new Set(Object.values(p1)).size > 30, `100 persistent → names spread over the palette: ${new Set(Object.values(p1)).size}`);

// 4. Editor: the scheme picker reflects and writes the property.
await page.evaluate(() => window.__qhdsOpenEditor("qhds1", "colors"));
await page.waitForSelector('[data-testid="ze-colors-scheme-100"]', { timeout: 10000 });
await page.waitForSelector('[data-testid^="ze-colorrow-"]', { timeout: 10000 });
check((await page.getAttribute('[data-testid="ze-colors-scheme-100"]', "aria-checked")) === "true", "the 100 button is checked");
const previewOther100 = await page.evaluate(() => [...document.querySelectorAll("[data-testid=\"ze-colors\"] [data-slot=\"chart-legend-row\"]")].some((r) => /Other/.test(r.textContent)));
check(!previewOther100, "the editor preview keeps every value with 100 colors");
await page.click('[data-testid="ze-colors-scheme-12"]');
await page.waitForTimeout(300);
const sub = await page.evaluate(() => document.querySelector('[data-testid="ze-colorrow-Airline 030"] .qhds-ze-item-sub')?.textContent ?? "");
check(/Other/.test(sub), `with 12, a 30th value says it falls in Other: ${sub}`);
await page.screenshot({ path: "build/color-scheme-editor.png" });
await page.click('[data-testid="ze-apply"]');
await page.waitForTimeout(500);
const patch = await page.evaluate(() => {
  const call = window.__calls.filter((c) => c.name === "applyPatches").pop();
  const p = call?.args?.[0]?.find((x) => x.qPath === "/props/colors");
  return p ? JSON.parse(p.qValue) : null;
});
check(patch?.scheme === "12" && patch?.persistent === true, `Apply writes the scheme: ${JSON.stringify(patch)}`);
check(errors.length === 0, "page errors: " + errors.join(" | "));
console.log(JSON.stringify({ twelve: twelve.length, hundred: hundred.length, paint12, paint100 }));
console.log(fail ? `color-scheme: ${fail} FAILED` : "color-scheme: ok");
await browser.close();
server.kill();
process.exit(fail ? 1 : 0);
