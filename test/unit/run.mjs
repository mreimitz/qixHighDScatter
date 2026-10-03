// Runs test/unit/<name>.check.ts in node: bundled with esbuild (brand-ui from
// BRAND_UI_SRC or node_modules), with a minimal `window`/`performance` shim.
// Usage: node test/unit/run.mjs packed   (or: node test/unit/run.mjs  → every check)
import { build } from "esbuild";
import { readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../..");
const names = process.argv.slice(2).length ? process.argv.slice(2) : readdirSync(here).filter((f) => f.endsWith(".check.ts")).map((f) => f.replace(/\.check\.ts$/, ""));
const out = path.join(root, "build", "unit");
mkdirSync(out, { recursive: true });
const SRC = process.env.BRAND_UI_SRC ? path.resolve(process.env.BRAND_UI_SRC) + "/" : null;
let failed = 0;
for (const name of names) {
  const entry = path.join(here, `${name}.check.ts`);
  const file = path.join(out, `${name}.mjs`);
  await build({
    entryPoints: [entry],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: file,
    logLevel: "silent",
    plugins: SRC
      ? [{ name: "brand-ui-src", setup(b) { b.onResolve({ filter: /^@elabs-ai\/components-(\w+)$/ }, (a) => ({ path: path.join(SRC, a.path.replace("@elabs-ai/components-", ""), "src/index.ts") })); } }]
      : [],
    external: ["react", "react-dom"],
  });
  const shim = path.join(out, `${name}.run.mjs`);
  writeFileSync(shim, `globalThis.window = globalThis; globalThis.performance ??= { now: () => Number(process.hrtime.bigint() / 1000000n) };\nawait import(${JSON.stringify(pathToFileURL(file).href)});\n`);
  try {
    await import(pathToFileURL(shim).href);
  } catch (e) {
    console.error(`${name}: ${e?.message ?? e}`);
    failed++;
  }
}
if (failed) process.exitCode = 1; // async checks finish on their own; a failing one exits 1 itself
