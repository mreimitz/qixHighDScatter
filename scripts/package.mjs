// Zips extension/qixHighDScatter/* (files at the ZIP root) into release/qixHighDScatter-v<version>.zip.
// Pure JS (fflate) so it runs the same on macOS and Windows.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from "node:fs";
import { zipSync } from "fflate";
const NAME = "qixHighDScatter";
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const dir = `extension/${NAME}`;
const files = {};
for (const f of readdirSync(dir)) {
  if (f.startsWith(".") || statSync(`${dir}/${f}`).isDirectory()) continue;
  files[f] = readFileSync(`${dir}/${f}`);
}
for (const req of [`${NAME}.qext`, `${NAME}.js`]) if (!files[req]) throw new Error(`missing ${req} — run npm run build first`);
mkdirSync("release", { recursive: true });
const out = `release/${NAME}-v${version}.zip`;
writeFileSync(out, zipSync(files, { level: 9 }));
console.log(`${out}  ${(statSync(out).size / 1024).toFixed(0)} KB  [${Object.keys(files).join(", ")}]`);
