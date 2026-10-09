// props.colors → colorBy.colors: what a value is painted with, and the promise
// that makes it "persistent" — the colour of a value depends on its NAME alone,
// never on the order the values arrive in or on which others are present.
// Run: node test/unit/run.mjs colors
import { categoryColors, readColors, schemeClasses, stableSlot } from "../../src/colors";
import { extendPalette } from "../../src/theme";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL:", msg);
  }
};
const CATS = ["Aurora Air", "Blue Heron", "Coastline", "Meridian", "Northwind", "Zephyr"];
const hexes = (n: number, tag: number) =>
  Array.from({ length: n }, (_, i) => `#${tag.toString(16).padStart(2, "0")}${i.toString(16).padStart(4, "0")}`);
const P = (size = 12) => ({ palette: hexes(size, 0x12), palette100: hexes(100, 0x64) });
const slotOf = (c: string | undefined) => Number(/--chart-(\d+)/.exec(c ?? "")?.[1] ?? NaN);

// Nothing asked for, nothing sent: the chart keeps its own ramp.
check(categoryColors(CATS, undefined, P()) === undefined, "no property → no colours");
check(categoryColors(CATS, { persistent: false, map: [] }, P()) === undefined, "off and nothing pinned → no colours");

// Persistent: every value gets a slot, and the slot is a function of the name.
const all = categoryColors(CATS, { persistent: true }, P())!;
check(CATS.every((c) => Number.isFinite(slotOf(all[c]))), `every value gets a slot: ${JSON.stringify(all)}`);
const reordered = categoryColors([...CATS].reverse(), { persistent: true }, P())!;
check(CATS.every((c) => all[c] === reordered[c]), "a different data order gives the same colours");
const subset = categoryColors(["Meridian", "Zephyr"], { persistent: true }, P())!;
check(
  subset["Meridian"] === all["Meridian"] && subset["Zephyr"] === all["Zephyr"],
  "a selection that drops values leaves the rest where they were",
);

// Only the slots the theme actually fills (`--chart-1` … `--chart-12`).
for (const size of [1, 3, 5, 12, 20]) {
  const got = categoryColors(CATS, { persistent: true }, P(size))!;
  const lim = Math.min(size, 12);
  const slots = CATS.map((c) => slotOf(got[c]));
  check(slots.every((k) => k >= 1 && k <= lim), `a ${size}-colour palette uses slots 1..${lim}: ${slots.join(",")}`);
}

// A pinned colour wins over the persistent slot; pinned alone leaves the others
// to the chart's ramp.
const pinned = categoryColors(CATS, { persistent: true, map: [{ value: "Meridian", color: "#c00000" }] }, P())!;
check(pinned["Meridian"] === "#c00000", "pinned beats persistent");
check(pinned["Zephyr"] === all["Zephyr"], "pinning one value leaves the others on their slot");
const onlyPinned = categoryColors(CATS, { persistent: false, map: [{ value: "Meridian", color: "#c00000" }] }, P())!;
check(JSON.stringify(onlyPinned) === JSON.stringify({ Meridian: "#c00000" }), `pinned alone: ${JSON.stringify(onlyPinned)}`);

// Scheme 100: every value gets its own colour from the 100-colour palette —
// by position, or by name when persistent — and the chart is told to keep 100 classes.
const MANY = Array.from({ length: 40 }, (_, i) => `Value ${i}`);
const by100 = categoryColors(MANY, { scheme: "100" }, P())!;
check(MANY.every((v, k) => by100[v] === P().palette100[k]), "scheme 100, not persistent: slot = position");
check(new Set(Object.values(by100)).size === 40, "scheme 100: forty values, forty colours");
const by100p = categoryColors(MANY, { scheme: "100", persistent: true }, P())!;
const by100pRev = categoryColors([...MANY].reverse(), { scheme: "100", persistent: true }, P())!;
check(MANY.every((v) => by100p[v] === P().palette100[stableSlot(v, 100)]), "scheme 100, persistent: slot = name hash over 100");
check(MANY.every((v) => by100p[v] === by100pRev[v]), "scheme 100, persistent: order does not matter");
const by100pin = categoryColors(MANY, { scheme: "100", map: [{ value: "Value 3", color: "#c00000" }] }, P())!;
check(by100pin["Value 3"] === "#c00000", "pinned beats scheme 100");
check(schemeClasses({ scheme: "100" }) === 100 && schemeClasses({}) === 12 && schemeClasses({ scheme: "7" }) === 12, "classes per scheme");
check(readColors({ scheme: "nope" }).scheme === "12", "unknown scheme → 12");
const ext = extendPalette(["#4477aa", "#7db8da", "#b6d7ea", "#46c646", "#f93f17", "#ffcf02", "#276e27", "#b0afae", "#7b7a78", "#545352", "#8e477d", "#d6a6c3"], 100);
check(ext.length === 100 && new Set(ext).size === 100, `a 12-colour theme still gives 100 distinct colours: ${new Set(ext).size}`);

// The property is cleaned, never trusted: no colour, no entry.
const dirty = readColors({
  persistent: "yes",
  map: [
    { value: "A", color: "javascript:alert(1)" },
    { value: "", color: "#fff" },
    { value: "B" },
    { value: "C", color: "#0a0" },
    { value: "C", color: "#f00" },
  ],
});
check(dirty.persistent === false, "only a real `true` turns persistent on");
check(JSON.stringify(dirty.map) === JSON.stringify([{ value: "C", color: "#0a0" }]), `cleaned: ${JSON.stringify(dirty.map)}`);

// The hash spreads: a palette slot per value, not everything on one.
const counts = new Array(12).fill(0);
for (let i = 0; i < 600; i++) counts[stableSlot(`Value ${i}`, 12)]++;
check(counts.every((c) => c > 20), `the hash spreads over the twelve slots: ${counts.join(",")}`);

console.log("colors:", failed ? `${failed} FAILED` : "ok", JSON.stringify(CATS.map((c) => `${c}=${slotOf(all[c])}`)));
if (failed) process.exit(1);
