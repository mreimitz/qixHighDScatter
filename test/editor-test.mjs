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

await step("noEditButtonOnChart", async () => (await page.getByTestId("qhds-edit-zones").count()) === 0);
await step("open", async () => { await page.evaluate(() => window.__qhdsOpenEditor("qhds1")); await page.getByTestId("zone-editor").waitFor(); await page.getByTestId("ze-item-0").waitFor(); return await page.locator('[data-testid^="ze-item-"]').count() + " zones listed"; });
await page.waitForTimeout(900);
await shot("1-open");
await step("expressionLoaded", async () => {
  await page.getByTestId("ze-item-1").click();
  const v = await page.getByTestId("ze-upper-1-x").inputValue();
  const ev = await page.locator('[data-testid="ze-upper-1-x"] ~ .qhds-ze-eval').textContent();
  return `${v} ${ev}`;
});
await step("lockedHandleForExpression", async () => await page.locator('[data-handle="upper-1"]').getAttribute("class"));

// drag upper point 0 of "Expanded" up by 40px
await step("dragVertex", async () => {
  const before = await page.getByTestId("ze-upper-0-y").inputValue();
  const h = page.locator('[data-handle="upper-0"]');
  const b = await h.boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 10, b.y + b.height / 2 - 40, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(200);
  const after = await page.getByTestId("ze-upper-0-y").inputValue();
  return `${before} -> ${after}`;
});
// add a point at a midpoint
await step("addMidpoint", async () => {
  const n0 = await page.locator('[data-testid^="ze-upper-"][data-testid$="-x"]').count();
  await page.locator('[data-mid="upper-m1"]').click();
  const n1 = await page.locator('[data-testid^="ze-upper-"][data-testid$="-x"]').count();
  return `${n0} -> ${n1} upper points`;
});
// undo the midpoint
await step("undo", async () => {
  await page.getByRole("button", { name: "Undo" }).click();
  return (await page.locator('[data-testid^="ze-upper-"][data-testid$="-x"]').count()) + " upper points after undo";
});
await shot("2-edited");

// draw a rectangle via Add zone menu
await step("drawRect", async () => {
  await page.getByTestId("ze-add").click();
  await page.getByTestId("ze-add-rect").click();
  const s = await page.locator('[data-surface="draw"]').boundingBox();
  await page.mouse.move(s.x + s.width * 0.6, s.y + s.height * 0.62);
  await page.mouse.down();
  await page.mouse.move(s.x + s.width * 0.75, s.y + s.height * 0.8, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const n = await page.locator('[data-testid^="ze-item-"]').count();
  const vals = await Promise.all(["ze-xMin", "ze-xMax", "ze-yMin", "ze-yMax"].map((t) => page.getByTestId(t).inputValue()));
  return `${n} zones; new rect ${vals.join(" / ")}`;
});
// type an expression into X min
await step("typeExpression", async () => {
  const i = page.getByTestId("ze-xMin");
  await i.fill("=vBoxLeft");
  await i.press("Enter");
  await page.waitForTimeout(700);
  const ev = await page.locator('[data-testid="ze-xMin"] ~ .qhds-ze-eval').textContent();
  return ev;
});
// draw a polygon
await step("drawPolygon", async () => {
  await page.getByTestId("ze-add").click(); await page.getByTestId("ze-add-polygon").click();
  const s = await page.locator('[data-surface="draw"]').boundingBox();
  const pts = [[0.2, 0.15], [0.35, 0.1], [0.4, 0.3], [0.22, 0.35]];
  for (const [fx, fy] of pts) await page.mouse.click(s.x + s.width * fx, s.y + s.height * fy);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  const n = await page.locator('[data-testid^="ze-points-"][data-testid$="-x"]').count();
  return `${await page.locator('[data-testid^="ze-item-"]').count()} zones; polygon with ${n} points`;
});
// draw a line, cover below, left end endless
await step("drawLine", async () => {
  await page.getByTestId("ze-add").click(); await page.getByTestId("ze-add-line").click();
  const s = await page.locator('[data-surface="draw"]').boundingBox();
  for (const [fx, fy] of [[0.1, 0.9], [0.5, 0.82], [0.8, 0.88]]) await page.mouse.click(s.x + s.width * fx, s.y + s.height * fy);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(300);
  await page.getByTestId("ze-side-below").click();
  await page.getByTestId("ze-extendEnd-closed").click();
  const n = await page.locator('[data-testid^="ze-line-"][data-testid$="-x"]').count();
  return `line with ${n} points; list: ${await page.locator('[data-testid^="ze-item-"]').last().locator(".qhds-ze-item-sub").textContent()}`;
});
// draw an envelope as an outline around a region (top edge left→right, back along the bottom), close on the first point
await step("drawEnvelope", async () => {
  await page.getByTestId("ze-add").click(); await page.getByTestId("ze-add-envelope").click();
  const s = await page.locator('[data-surface="draw"]').boundingBox();
  const ring = [[0.15, 0.45], [0.4, 0.4], [0.7, 0.42], [0.72, 0.6], [0.45, 0.62], [0.18, 0.58]];
  for (const [fx, fy] of ring) await page.mouse.click(s.x + s.width * fx, s.y + s.height * fy);
  const pill = await page.getByTestId("qhds-ze-finish").count();
  await page.mouse.click(s.x + s.width * ring[0][0], s.y + s.height * ring[0][1]);
  await page.waitForTimeout(300);
  const up = await page.locator('[data-testid^="ze-upper-"][data-testid$="-x"]').count();
  const lo = await page.locator('[data-testid^="ze-lower-"][data-testid$="-x"]').count();
  const sub = await page.locator(".qhds-ze-item[aria-selected=true] .qhds-ze-item-sub").textContent();
  return `finish pill shown: ${pill}; upper ${up} / lower ${lo} points; ${sub}`;
});
// a line finished with the ✓ Finish control (no keyboard)
await step("finishPill", async () => {
  await page.getByTestId("ze-add").click(); await page.getByTestId("ze-add-line").click();
  const s = await page.locator('[data-surface="draw"]').boundingBox();
  for (const [fx, fy] of [[0.1, 0.2], [0.5, 0.25]]) await page.mouse.click(s.x + s.width * fx, s.y + s.height * fy);
  await page.getByTestId("qhds-ze-finish").click();
  await page.waitForTimeout(300);
  return await page.locator(".qhds-ze-item[aria-selected=true] .qhds-ze-item-sub").textContent();
});
// colour by expression on the selected zone (Zone 8, the envelope): ƒx → RGB()
await step("colorExpression", async () => {
  await page.getByTestId("ze-color-expr").click();
  const input = page.getByTestId("ze-color-expr-input");
  await input.fill("=RGB(200, 40, 40)");
  await input.press("Enter");
  await page.waitForTimeout(700);
  const shown = await page.locator(".qhds-ze-colorexpr .qhds-ze-muted").innerText();
  const outline = await page.evaluate(() => [...document.querySelectorAll('[data-slot="density-scatter-chart-overlay"] g[stroke]')].map((g) => g.getAttribute("stroke")).filter((c) => /rgb\(200/i.test(c)).length);
  return `${shown.trim()} · outlines in that colour: ${outline}`;
});
// type and covers are icons with tooltips
await step("iconSelectors", async () => {
  const kinds = await page.locator('[aria-label="Zone type"] button').evaluateAll((bs) => bs.map((b) => `${b.getAttribute("aria-label")}|${b.textContent.trim() === "" ? "icon" : "text"}`));
  await page.getByTestId("ze-cover-outside").hover();
  const tip = await page.getByTestId("ze-cover-outside").evaluate((b) => getComputedStyle(b, "::after").content);
  return `${kinds.join(", ")} · cover tooltip: ${tip}`;
});
await step("noTopToolbar", async () => (await page.locator(".qhds-ze-toolbar").count()) === 0);
await shot("5-envelope");
// cover outside on the Box-like new rectangle (Zone 5)
await step("coverOutside", async () => {
  const items = page.locator('[data-testid^="ze-item-"]');
  const n = await items.count();
  for (let i = 0; i < n; i++) if ((await items.nth(i).locator(".qhds-ze-item-name").textContent()) === "Zone 5") { await items.nth(i).click(); break; }
  await page.getByTestId("ze-cover-outside").click();
  await page.getByTestId("ze-extendStart-open").click();
  return await page.locator(".qhds-ze-item[aria-selected=true] .qhds-ze-item-sub").textContent();
});
await shot("4-line");
// reorder: move last zone up
await step("reorder", async () => {
  const last = (await page.locator('[data-testid^="ze-item-"]').count()) - 1;
  await page.getByTestId(`ze-item-${last}`).getByRole("button", { name: /up$/ }).click();
  return await page.getByTestId(`ze-item-${last - 1}`).locator(".qhds-ze-item-name").textContent();
});
// switch the type of the selected zone to envelope
await step("convertToEnvelope", async () => {
  await page.getByTestId("ze-item-0").click();
  await page.getByTestId("ze-kind-envelope").click();
  return (await page.locator('[data-testid^="ze-upper-"][data-testid$="-x"]').count()) + " upper points";
});
await shot("3-drawn");
await step("footer", async () => await page.locator(".qhds-ze-footer").innerText());
// Apply
await step("apply", async () => {
  await page.getByTestId("ze-apply").click();
  await page.waitForTimeout(400);
  const calls = await page.evaluate(() => window.__calls.filter((c) => c.name === "applyPatches"));
  const p = calls[0]?.args?.[0];
  const zones = JSON.parse(p.find((x) => x.qPath === "/props/zones").qValue);
  return {
    patches: p.map((x) => x.qPath),
    softPatch: calls[0].args[1],
    zones: zones.map((z) => `${z.label}:${z.kind}`),
    exprKept: JSON.stringify(zones.find((z) => z.label === "Expanded")?.upper?.[1]?.x),
    rectXMin: JSON.stringify(zones.find((z) => z.kind === "rect" && z.label.startsWith("Zone"))?.xMin),
    rect: JSON.stringify(zones.find((z) => z.label === "Zone 5") ? (({ cover, extendStart, extendEnd }) => ({ cover, extendStart, extendEnd }))(zones.find((z) => z.label === "Zone 5")) : null),
    line: JSON.stringify(zones.find((z) => z.kind === "line") ? (({ side, extendStart, extendEnd, line }) => ({ side, extendStart, extendEnd, n: line.length }))(zones.find((z) => z.kind === "line")) : null),
    closed: !(await page.getByTestId("zone-editor").isVisible().catch(() => false)),
  };
});
await step("evalObjectsDestroyed", async () => await page.evaluate(() => window.__destroyed));
R.logs = logs.filter((l) => !l.includes("404")).slice(0, 12);
console.log(JSON.stringify(R, null, 1));
await browser.close(); server.kill();
