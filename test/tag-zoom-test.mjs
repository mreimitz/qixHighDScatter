// Zone tags must not blink while zooming: record every tag over many small wheel steps.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8768", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: "/home/claude/qhds" });
await new Promise((r) => setTimeout(r, 800));
const zones = [
  { cId: "l1", kind: "line", label: "Slope", side: "above", extendStart: true, extendEnd: true, line: [{ x: -2000, y: 300 }, { x: 3000, y: -300 }], color: { index: -1, color: "#2ca02c" } },
  { cId: "e1", kind: "envelope", label: "Env", extendStart: true, extendEnd: false, mirror: true, upper: [{ x: -1500, y: 120 }, { x: 0, y: 40 }, { x: 2500, y: 40 }], color: { index: -1, color: "#d62728" } },
];
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 680 } });
await page.goto(`http://127.0.0.1:8768/test/harness/index.html?n=20000&zones=${encodeURIComponent(JSON.stringify(zones))}`);
await page.waitForTimeout(4000);
const plot = await page.locator('[data-slot="density-scatter-chart-plot"]').boundingBox();
const tags = () => page.evaluate(() => Object.fromEntries([...document.querySelectorAll('[data-slot="density-scatter-chart-zone-tag"]')].map((b) => [b.textContent, [Math.round(b.getBoundingClientRect().x), Math.round(b.getBoundingClientRect().y)]])));
const frames = [await tags()];
const anchors = [[0.3, 0.45], [0.5, 0.5], [0.7, 0.55]];
for (const [ax, ay] of anchors) {
  await page.mouse.move(plot.x + plot.width * ax, plot.y + plot.height * ay);
  for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, -60); await page.waitForTimeout(60); frames.push(await tags()); }
  for (let i = 0; i < 14; i++) { await page.mouse.wheel(0, 60); await page.waitForTimeout(60); frames.push(await tags()); }
}
// blink = a tag present, then absent, then present again within 3 frames
const names = [...new Set(frames.flatMap((f) => Object.keys(f)))];
const report = {};
for (const n of names) {
  const seq = frames.map((f) => (n in f ? 1 : 0)).join("");
  const blinks = (seq.match(/10{1,2}1/g) || []).length;
  let maxJump = 0;
  for (let i = 1; i < frames.length; i++) if (frames[i][n] && frames[i - 1][n]) maxJump = Math.max(maxJump, Math.hypot(frames[i][n][0] - frames[i - 1][n][0], frames[i][n][1] - frames[i - 1][n][1]));
  report[n] = { seq, blinks, maxJump: Math.round(maxJump) };
}
console.log(JSON.stringify(report, null, 1));
await browser.close(); server.kill();
