// Persistent colours and pinned colours (Appearance › Colors and legend):
// `props.colors.persistent` makes a value's colour follow its NAME instead of
// its position in the data, `props.colors.map` pins one by hand, and the
// editor's Colors tab lists every value, flags two that share an ink, and
// writes /props/colors on Apply.
// Run: node test/color-persistent-test.mjs
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
const server = spawn("python3", ["-m", "http.server", "8775", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1300, height: 820 } });
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let fail = 0;
const check = (ok, msg) => { if (!ok) { fail++; console.log("FAIL:", msg); } };

// The 2nd dimension of the harness, in the order the rows deal it out.
const AIRLINES = ["Aurora Air", "Blue Heron", "Coastline", "Meridian", "Northwind", "Zephyr"];
// The palette slot each name hashes to (test/unit/colors.check.ts owns the rule).
const HASHED = { "Aurora Air": 2, "Blue Heron": 12, Coastline: 8, Meridian: 3, Northwind: 7, Zephyr: 12 };

const load = async (colors) => {
  const props = { colors, pointRadius: 2 };
  await page.goto(`http://127.0.0.1:8775/test/harness/index.html?n=20000&cat=1&edit=1&colorBy=category&props=${encodeURIComponent(JSON.stringify(props))}`);
  await page.waitForFunction(() => window.__qhdsPerf?.load, null, { timeout: 30000 }).catch(() => undefined);
  await page.waitForTimeout(900);
  return page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-slot="chart-legend-row"]')].map((row) => [
        row.querySelector("span")?.textContent?.trim(),
        row.querySelector('div[style*="background-color"]')?.style.backgroundColor,
      ]),
    ),
  );
};

// 1. Off (the 0.8.0 behaviour): the colour is the slot of the value's position.
const off = await load({ persistent: false, map: [] });
check(
  AIRLINES.every((a, i) => off[a] === `var(--chart-${i + 1})`),
  `off → slots follow the data order: ${JSON.stringify(off)}`,
);

// 2. On: the colour is the slot the NAME hashes to, whatever its position.
const on = await load({ persistent: true, map: [] });
check(
  AIRLINES.every((a) => on[a] === `var(--chart-${HASHED[a]})`),
  `on → slots follow the name: ${JSON.stringify(on)}`,
);
check(
  AIRLINES.some((a, i) => on[a] !== `var(--chart-${i + 1})`),
  "on actually moves values off their positional slot",
);

// 3. A pinned colour wins over both, and only for its own value.
const pinned = await load({ persistent: true, map: [{ value: "Meridian", color: "#cc0000" }] });
check(/rgb\(204, 0, 0\)|#cc0000/.test(pinned["Meridian"] ?? ""), `Meridian is pinned red: ${pinned["Meridian"]}`);
check(pinned["Zephyr"] === on["Zephyr"], `pinning one value leaves the others: ${pinned["Zephyr"]} vs ${on["Zephyr"]}`);

// 4. The editor's Colors tab: every value, the slot it sits on, the clash
// between the two names that hash to the same slot, and Apply.
await load({ persistent: true, map: [] });
await page.evaluate(() => window.__qhdsOpenEditor("qhds1", "colors"));
await page.waitForSelector('[data-testid="ze-colors"]', { timeout: 10000 });
// The rows come from the colour column's labels, which land with the data.
await page.waitForSelector('[data-testid^="ze-colorrow-"]', { timeout: 10000 });
await page.waitForTimeout(400);
const rows = await page.evaluate(() =>
  Object.fromEntries(
    [...document.querySelectorAll('[data-testid^="ze-colorrow-"]')].map((li) => [
      li.querySelector(".qhds-ze-item-name")?.textContent,
      li.querySelector(".qhds-ze-item-sub")?.textContent,
    ]),
  ),
);
check(Object.keys(rows).length === AIRLINES.length, `a row per value: ${JSON.stringify(Object.keys(rows))}`);
check(/persistent slot 3/.test(rows["Meridian"] ?? ""), `Meridian shows its persistent slot: ${rows["Meridian"]}`);
check(
  /same colour as Zephyr/.test(rows["Blue Heron"] ?? "") && /same colour as Blue Heron/.test(rows["Zephyr"] ?? ""),
  `the two names on slot 12 are flagged: ${rows["Blue Heron"]} | ${rows["Zephyr"]}`,
);
check((await page.evaluate(() => document.querySelector('[data-testid="ze-colors-persistent"]')?.checked)) === true, "the persistent switch reflects the property");
await page.screenshot({ path: "build/color-persistent-editor.png" });
await page.click('[data-testid="ze-color-Zephyr"]');
await page.waitForTimeout(200);
check((await page.evaluate(() => document.querySelectorAll(".qhds-ze-colorpop").length)) === 1, "the colour dot opens a palette popover");
// The dot is flush with the right edge of a column that scrolls, so a popover
// hanging off its LEFT edge would be clipped by the preview pane.
const pop = await page.evaluate(() => {
  const p = document.querySelector(".qhds-ze-colorpop").getBoundingClientRect();
  const col = document.querySelector(".qhds-ze-shapes-list").getBoundingClientRect();
  return { left: p.left, right: p.right, width: p.width, colLeft: col.left, colRight: col.right, swatches: document.querySelectorAll(".qhds-ze-colorpop .qhds-ze-swatch").length };
});
check(pop.right <= pop.colRight + 1 && pop.left >= pop.colLeft - 1, `the popover stays inside the list column: ${JSON.stringify(pop)}`);
check(pop.width >= 200 && pop.swatches >= 3, `the popover opens at its full width: ${JSON.stringify(pop)}`);
await page.screenshot({ path: "build/color-popover.png" });
await page.click(".qhds-ze-colorpop .qhds-ze-swatch");
await page.waitForTimeout(300);
check(/pinned/.test(await page.evaluate(() => document.querySelector('[data-testid="ze-colorrow-Zephyr"] .qhds-ze-item-sub')?.textContent ?? "")), "a pick marks the row pinned");
await page.click('[data-testid="ze-apply"]');
await page.waitForTimeout(500);
const patch = await page.evaluate(() => {
  const call = window.__calls.filter((c) => c.name === "applyPatches").pop();
  const p = call?.args?.[0]?.find((x) => x.qPath === "/props/colors");
  return p ? JSON.parse(p.qValue) : null;
});
check(patch?.persistent === true, `Apply keeps persistent on: ${JSON.stringify(patch)}`);
const z = patch?.map?.find((e) => e.value === "Zephyr");
check(z && typeof z.color === "string" && z.color.startsWith("#"), `Apply saves the pinned colour: ${JSON.stringify(patch?.map)}`);
check(errors.length === 0, "page errors: " + errors.join(" | "));
console.log(JSON.stringify({ off, on, pinned, rows, patch }, null, 1));
console.log(fail ? `color-persistent: ${fail} FAILED` : "color-persistent: ok");
await browser.close();
server.kill();
process.exit(fail ? 1 : 0);
