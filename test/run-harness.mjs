import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
const dir = "/opt/pw-browsers";
const exe = readdirSync(dir).filter((d) => d.startsWith("chromium")).map((d) => [`${dir}/${d}/chrome-linux/chrome`, `${dir}/${d}/chrome-linux64/chrome`]).flat().find(existsSync);
const server = spawn("python3", ["-m", "http.server", "8765", "--bind", "127.0.0.1"], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 960, height: 620 } });
const logs = [];
page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e.message}`));
const qs = process.argv[2] || "";
await page.goto(`http://127.0.0.1:8765/test/harness/index.html${qs}`);
await page.evaluate((n) => { window.__expect = Number(n).toLocaleString("en-US"); }, new URLSearchParams(qs).get("n") || "300000");
const out = { qs };
try {
  const t0 = Date.now();
  await page.waitForFunction(() => { const f = document.querySelector('[role="figure"]'); const d = f && document.getElementById(f.getAttribute("aria-describedby") || ""); return d && /^[\d,]+ points/.test(d.textContent) && d.textContent.startsWith(window.__expect); }, null, { timeout: 90000 });
  out.loadMs = Date.now() - t0;
} catch (e) { out.waitError = String(e).slice(0, 200); }
await page.waitForTimeout(Number(process.env.WAIT || 1500));
out.state = await page.evaluate(() => ({
  error: window.__error, pages: window.__pages?.(), renderedMs: Math.round(window.__rendered || 0),
  renderer: document.querySelector('[data-renderer]')?.getAttribute("data-renderer"),
  desc: document.querySelector('[role="figure"]')?.getAttribute("aria-label"),
  status: [...document.querySelectorAll(".qhds-status span")].map((s) => s.textContent),
  legend: [...document.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent?.trim()).slice(0, 8),
  hostVars: (() => { const h = document.querySelector(".qhds"); return h ? ["--chart-1","--chart-4","--font-sans","--background","--foreground","--muted-foreground","--border","--chart-axis"].map((k) => k + "=" + h.style.getPropertyValue(k)) : null; })(),
  frame: (() => { const f = document.querySelector(".qhds-frame"); const o = document.getElementById("obj"); return f && { frameH: f.scrollHeight, objH: o.clientHeight }; })(),
  a11yDesc: document.querySelector('[role="figure"]')?.getAttribute("aria-describedby") ? document.getElementById(document.querySelector('[role="figure"]').getAttribute("aria-describedby"))?.textContent : null,
}));
await page.screenshot({ path: `build/harness${qs.replace(/[^a-z0-9]/gi, "_")}.png` });
out.logs = logs.slice(0, 20); out.dbg = await page.evaluate(() => (window.__dbg || []).slice(-8));
console.log(JSON.stringify(out, null, 1));
globalThis.__page = page;
if (!process.argv.includes("--keep")) { await browser.close(); server.kill(); }
