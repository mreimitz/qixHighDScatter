// Build: Tailwind (brand-ui) CSS → scoped → inlined; esbuild TSX bundle (React +
// brand-ui charts); AMD wrapper with @nebula.js/stardust as the only external.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { build } from "esbuild";
import path from "node:path";
import scopeCss from "./scope-css.mjs";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const NAME = "qixHighDScatter";
const VERSION = pkg.version;
const dev = process.argv.includes("--dev");
// BRAND_UI_SRC=<elabs-components>/packages builds against the brand-ui SOURCE
// (needed until the density-scatter changes are released to npm); unset = npm.
const SRC_ROOT = process.env.BRAND_UI_SRC ? path.resolve(process.env.BRAND_UI_SRC) + "/" : null;
const LIB = SRC_ROOT ? "src" : "npm";
mkdirSync("build", { recursive: true });
mkdirSync(`extension/${NAME}`, { recursive: true });

let cssEntry = "src/styles.css";
if (LIB === "src") {
  // Same stylesheet, pointed at the brand-ui source instead of the npm dists.
  const rel = path.relative(path.resolve("build"), SRC_ROOT).split(path.sep).join("/");
  const srcCss = readFileSync("src/styles.css", "utf8")
    .replace('@import "@elabs-ai/components-tokens/styles.css";', `@import "${rel}/tokens/src/themes.css";`)
    .replace('@import "@elabs-ai/components-tokens/themes/dark.css";', `@import "${rel}/tokens/src/themes/dark.css";`)
    .replace(/@source "\.\.\/node_modules\/@elabs-ai\/components-(charts|ui|tokens)\/dist";/g, `@source "${rel}/$1/src";`)
    .replace('@source "./";', '@source "../src";');
  writeFileSync("build/styles.src.css", srcCss);
  cssEntry = "build/styles.src.css";
}
execFileSync("node", ["node_modules/@tailwindcss/cli/dist/index.mjs", "-i", cssEntry, "-o", "build/tw.css", ...(dev ? [] : ["--minify"])], { stdio: "inherit" });
const scoped = scopeCss(readFileSync("build/tw.css", "utf8"));
writeFileSync("src/styles.generated.css", scoped);

// LIB=src builds against the brand-ui SOURCE in ../lib (the elabs-components worktree),
// LIB=npm (default) against the published packages.
const libRoot = SRC_ROOT;
const aliasPlugin = {
  name: "brand-ui-source",
  setup(b) {
    if (LIB !== "src") return;
    const map = {
      "@elabs-ai/components-charts": "charts/src/index.ts",
      "@elabs-ai/components-ui": "ui/src/index.ts",
      "@elabs-ai/components-ui/definition": "ui/src/lib/definition/index.ts",
      "@elabs-ai/components-ui/lib/cn": "ui/src/lib/cn.ts",
      "@elabs-ai/components-tokens": "tokens/src/index.ts",
    };
    // One React: everything under the brand-ui source must resolve `react`,
    // `react-dom` and the JSX runtime to THIS project's copy, or the chart's
    // hooks run against a second React instance (hooks dispatcher = null).
    const here = path.resolve("node_modules");
    b.onResolve({ filter: /^(react|react-dom)(\/.*)?$/ }, (args) => {
      if (args.resolveDir.startsWith(here)) return undefined;
      return b.resolve(args.path, { kind: args.kind, resolveDir: here });
    });
    b.onResolve({ filter: /^@elabs-ai\/components-(charts|ui|tokens)(\/.*)?$/ }, (args) => {
      const target = map[args.path];
      if (!target) return { errors: [{ text: `no source mapping for ${args.path}` }] };
      return { path: libRoot + target };
    });
  },
};
const res = await build({
  plugins: [aliasPlugin],
  entryPoints: ["src/index.tsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: ["es2020"],
  jsx: "automatic",
  minify: !dev,
  sourcemap: false,
  external: ["@nebula.js/stardust"],
  loader: { ".css": "text", ".svg": "text" },
  define: { "process.env.NODE_ENV": dev ? '"development"' : '"production"', __QHDS_VERSION__: JSON.stringify(VERSION) },
  write: false,
  legalComments: "none",
  metafile: true,
});
let code = res.outputFiles[0].text.replace(/__QHDS_VERSION__/g, VERSION);
// String concatenation (not a template literal): minified libs contain backticks and ${.
const amd =
  "/* " + NAME + " v" + VERSION + " */\n" +
  "define(['@nebula.js/stardust'], function (__stardust) {\n" +
  "var module = { exports: {} }, exports = module.exports;\n" +
  "var require = function (n) { if (n === '@nebula.js/stardust') return __stardust; throw new Error('qixHighDScatter: unexpected require ' + n); };\n" +
  code +
  "\nvar __m = module.exports; return __m && __m.default ? __m.default : __m;\n});\n";
const out = `extension/${NAME}`;
writeFileSync(`${out}/${NAME}.js`, amd);
writeFileSync(
  `${out}/${NAME}.qext`,
  JSON.stringify(
    {
      name: "High Density Scatter",
      description: "Scatter plot for 100k–1M points: every point drawn, coloured by density, classified by zones on the axes.",
      type: "visualization",
      version: VERSION,
      author: "Manuel Reimitz",
      icon: "scatter-chart", // one of Qlik's built-in qext icon names ("scatterChart" is not one → puzzle piece)
      preview: "",
      supernova: true,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(`${out}/${NAME}.html`, "<!DOCTYPE html><html><head></head><body></body></html>\n");
writeFileSync(`${out}/${NAME}.css`, "/* styles are injected by the extension (scoped to .qhds) */\n");
writeFileSync("build/meta.json", JSON.stringify(res.metafile));
console.log(`built ${out}/${NAME}.js  ${(amd.length / 1024).toFixed(0)} KB  (css ${(scoped.length / 1024).toFixed(0)} KB)`);
