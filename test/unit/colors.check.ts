// props.colors → colorBy.colors: what a value is painted with, and the promise
// that makes it "persistent" — the colour of a value depends on its NAME alone,
// never on the order the values arrive in or on which others are present.
// Run: node test/unit/run.mjs colors
import { categoryColors, readColors, stableSlot } from "../../src/colors";

let failed = 0;
const check = (ok: boolean, msg: string) => {
  if (!ok) {
    failed++;
    console.log("FAIL:", msg);
  }
};
const CATS = ["Aurora Air", "Blue Heron", "Coastline", "Meridian", "Northwind", "Zephyr"];
const slotOf = (c: string | undefined) => Number(/--chart-(\d+)/.exec(c ?? "")?.[1] ?? NaN);

// Nothing asked for, nothing sent: the chart keeps its own ramp.
check(categoryColors(CATS, undefined, 12) === undefined, "no property → no colours");
check(categoryColors(CATS, { persistent: false, map: [] }, 12) === undefined, "off and nothing pinned → no colours");

// Persistent: every value gets a slot, and the slot is a function of the name.
const all = categoryColors(CATS, { persistent: true }, 12)!;
check(CATS.every((c) => Number.isFinite(slotOf(all[c]))), `every value gets a slot: ${JSON.stringify(all)}`);
const reordered = categoryColors([...CATS].reverse(), { persistent: true }, 12)!;
check(CATS.every((c) => all[c] === reordered[c]), "a different data order gives the same colours");
const subset = categoryColors(["Meridian", "Zephyr"], { persistent: true }, 12)!;
check(
  subset["Meridian"] === all["Meridian"] && subset["Zephyr"] === all["Zephyr"],
  "a selection that drops values leaves the rest where they were",
);

// Only the slots the theme actually fills (`--chart-1` … `--chart-12`).
for (const size of [1, 3, 5, 12, 20]) {
  const got = categoryColors(CATS, { persistent: true }, size)!;
  const lim = Math.min(size, 12);
  const slots = CATS.map((c) => slotOf(got[c]));
  check(slots.every((k) => k >= 1 && k <= lim), `a ${size}-colour palette uses slots 1..${lim}: ${slots.join(",")}`);
}

// A pinned colour wins over the persistent slot; pinned alone leaves the others
// to the chart's ramp.
const pinned = categoryColors(CATS, { persistent: true, map: [{ value: "Meridian", color: "#c00000" }] }, 12)!;
check(pinned["Meridian"] === "#c00000", "pinned beats persistent");
check(pinned["Zephyr"] === all["Zephyr"], "pinning one value leaves the others on their slot");
const onlyPinned = categoryColors(CATS, { persistent: false, map: [{ value: "Meridian", color: "#c00000" }] }, 12)!;
check(JSON.stringify(onlyPinned) === JSON.stringify({ Meridian: "#c00000" }), `pinned alone: ${JSON.stringify(onlyPinned)}`);

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
