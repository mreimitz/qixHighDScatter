// Drives the zone editor in the real nebula runtime: open, select, drag a vertex,
// draw a new rectangle and a polygon, type an expression, reorder, undo, Apply.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8767", "--bind", "127.0.0.1"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const logs = [];
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") logs.push(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
await page.goto(`http://127.0.0.1:8767/test/harness/index.html?n=60000&edit=1`);
await page.waitForFunction(() => { const f = document.querySelector('[role="figure"]'); const d = f && document.getElementById(f.getAttribute("aria-describedby") || ""); return d && d.textContent.startsWith("60,000 points"); }, null, { timeout: 60000 });
const R = {};
const shot = (n) => page.screenshot({ path: `build/editor-${n}.png` });
const step = async (name, fn) => { try { R[name] = (await fn()) ?? "ok"; } catch (e) { R[name] = "FAIL: " + String(e.message || e).split("\n")[0]; } };

await step("open", async () => { await page.evaluate(() => window.__qhdsOpenEditor("qhds1")); await page.getByTestId("zone-editor").waitFor(); await page.getByTestId("ze-item-0").waitFor(); return "ok"; });
await page.waitForTimeout(800);
await step("typeTooltip", async () => {
  await page.getByTestId("ze-item-0").click();
  await page.getByTestId("ze-kind-circle").hover();
  await page.waitForTimeout(150);
  const t = await page.getByTestId("ze-tip").textContent();
  const b = await page.getByTestId("ze-tip").boundingBox();
  const vis = await page.getByTestId("ze-tip").evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return getComputedStyle(el).position; });
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);
  const gone = (await page.getByTestId("ze-tip").count()) === 0;
  return { t, box: b && [Math.round(b.x), Math.round(b.y), Math.round(b.width)], vis, gone };
});
await step("coverTooltip", async () => { await page.getByTestId("ze-cover-outside").hover(); await page.waitForTimeout(100); return await page.getByTestId("ze-tip").textContent(); });
const n0 = await page.locator('[data-testid^="ze-item-"]').count();
await step("drawCircle", async () => {
  await page.getByTestId("ze-add").click();
  await page.getByTestId("ze-add-circle").click();
  const s = await page.locator('[data-surface="draw"]').boundingBox();
  await page.mouse.move(s.x + s.width * 0.3, s.y + s.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width * 0.3 + 60, s.y + s.height * 0.3, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const vals = await Promise.all(["ze-cx", "ze-cy", "ze-rx", "ze-ry"].map((t) => page.getByTestId(t).inputValue()));
  const handles = await page.locator('[data-handle="c"],[data-handle="rx"],[data-handle="ry"]').count();
  const item = await page.getByTestId(`ze-item-${n0}`).textContent();
  return { vals, handles, item };
});
await page.screenshot({ path: "build/editor-circle.png" });
await step("dragCircleRadius", async () => {
  const before = await page.getByTestId("ze-rx").inputValue();
  const h = await page.locator('[data-handle="rx"]').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 + 40, h.y + h.height / 2, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(200);
  return `${before} → ${await page.getByTestId("ze-rx").inputValue()} / ry ${await page.getByTestId("ze-ry").inputValue()}`;
});
await step("drawQuadrant", async () => {
  await page.getByTestId("ze-add").click();
  await page.getByTestId("ze-add-quadrant").click();
  const s = await page.locator('[data-surface="draw"]').boundingBox();
  await page.mouse.click(s.x + s.width * 0.55, s.y + s.height * 0.45);
  await page.waitForTimeout(400);
  const vals = await Promise.all(["ze-xSplit", "ze-ySplit"].map((t) => page.getByTestId(t).inputValue()));
  const item = await page.getByTestId(`ze-item-${n0 + 1}`).textContent();
  const hasCover = await page.getByTestId("ze-cover-inside").count();
  return { vals, item, hasCover, handles: await page.locator('[data-handle^="q"]').count() };
});
await step("nameQuadrants", async () => {
  await page.getByTestId("ze-quad-0-label").fill("Stars"); await page.getByTestId("ze-quad-0-label").press("Enter");
  await page.getByTestId("ze-quad-3-label").fill("Dogs"); await page.getByTestId("ze-quad-3-label").press("Enter");
  await page.getByTestId("ze-quad-1-color").evaluate((el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set; set.call(el, "#11aa22"); el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); el.focus(); el.blur(); });
  await page.waitForTimeout(200);
  return await page.getByTestId("ze-quad-1-color").inputValue();
});
await step("dragQuadLine", async () => {
  const before = await page.getByTestId("ze-xSplit").inputValue();
  const h = await page.locator('[data-handle="qx"]').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + h.height / 2); await page.mouse.down();
  await page.mouse.move(h.x + h.width / 2 - 80, h.y + h.height / 2 + 30, { steps: 6 }); await page.mouse.up();
  await page.waitForTimeout(200);
  return `x ${before} → ${await page.getByTestId("ze-xSplit").inputValue()}; y ${await page.getByTestId("ze-ySplit").inputValue()}`;
});
await step("emptySplitMeansMiddle", async () => {
  await page.getByTestId("ze-ySplit").fill(""); await page.getByTestId("ze-ySplit").press("Enter"); await page.waitForTimeout(200); const ph = await page.getByTestId("ze-ySplit").getAttribute("placeholder"); const hy = await page.locator(`[data-handle="qc"]`).getAttribute("cy");
  return { value: await page.getByTestId("ze-ySplit").inputValue(), ph, handleCy: hy };
});
await page.screenshot({ path: "build/editor-quadrant.png" });
await step("apply", async () => {
  await page.getByTestId("ze-apply").click();
  await page.waitForTimeout(400);
  const calls = await page.evaluate(() => window.__calls.filter((c) => c.name === "applyPatches"));
  const zones = JSON.parse(calls[0].args[0].find((x) => x.qPath === "/props/zones").qValue);
  const c = zones.find((z) => z.kind === "circle");
  const q = zones.find((z) => z.kind === "quadrant");
  return { circle: c && [c.cx, c.cy, c.rx, c.ry].map((v) => typeof v === "number" ? +v.toPrecision(4) : v), quad: q && { xSplit: q.xSplit, ySplit: q.ySplit, labels: [0, 1, 2, 3].map((i) => q[`q${i}Label`]), c1: q.q1Color } };
});
await page.waitForTimeout(1200);
await page.screenshot({ path: "build/editor-applied.png" });
R.legend = await page.evaluate(() => [...document.querySelectorAll('[data-slot="density-scatter-chart"] button')].map((b) => b.textContent.trim()).filter((t) => t && t.length < 40).slice(0, 20));
R.logs = logs.filter((l) => !l.includes("404")).slice(0, 12);
console.log(JSON.stringify(R, null, 1));
await browser.close(); server.kill();
