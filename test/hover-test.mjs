import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8767", "--bind", "127.0.0.1"], { stdio: "ignore", cwd: process.cwd() });
await new Promise((r) => setTimeout(r, 800));
for (const args of [["--use-angle=swiftshader","--enable-unsafe-swiftshader"], ["--disable-3d-apis","--disable-webgl"]]) {
const browser = await chromium.launch({ executablePath: exe, args });
const page = await browser.newPage({ viewport: { width: 960, height: 620 } });
await page.goto(`http://127.0.0.1:8767/test/harness/index.html?n=3000`);
await page.waitForTimeout(4000);
const plot = await page.locator('[data-slot="density-scatter-chart-plot"]').boundingBox();
let found = 0;
for (let i = 0; i < 40 && !found; i++) {
  await page.mouse.move(plot.x + plot.width * (0.3 + (i % 8) * 0.05), plot.y + plot.height * (0.3 + Math.floor(i / 8) * 0.08), { steps: 3 });
  await page.waitForTimeout(80);
  found = await page.evaluate(() => document.querySelectorAll('[data-slot="chart-tooltip-box"]').length);
}
console.log(args[0], "tooltip:", found, await page.evaluate(() => document.querySelector('[data-slot="chart-tooltip-box"]')?.textContent?.slice(0, 100)));
await browser.close();
}
server.kill();
