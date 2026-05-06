#!/usr/bin/env node
// Scale the amplitude of the thinking-tone PCM16 base64 in-place.
// Usage: node scripts/lower-thinking-tone.mjs <gain>
// Example: node scripts/lower-thinking-tone.mjs 0.3   (≈ -10 dB)

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "../src/utils/thinking-tone.native-pcm.ts");

const gainArg = process.argv[2];
if (!gainArg) {
  console.error("Usage: node scripts/lower-thinking-tone.mjs <gain>");
  process.exit(1);
}
const gain = Number(gainArg);
if (!Number.isFinite(gain) || gain < 0) {
  console.error(`Invalid gain: ${gainArg}`);
  process.exit(1);
}

const source = readFileSync(target, "utf8");
const match = source.match(/"([A-Za-z0-9+/=]+)"/);
if (!match) {
  console.error("Could not find base64 string in target file.");
  process.exit(1);
}
const originalBase64 = match[1];

const buf = Buffer.from(originalBase64, "base64");
if (buf.byteLength % 2 !== 0) {
  console.error(`PCM16 buffer has odd length ${buf.byteLength}`);
  process.exit(1);
}

let peakBefore = 0;
let peakAfter = 0;
const out = Buffer.alloc(buf.byteLength);
for (let i = 0; i < buf.byteLength; i += 2) {
  const sample = buf.readInt16LE(i);
  peakBefore = Math.max(peakBefore, Math.abs(sample));
  const scaled = Math.max(-32768, Math.min(32767, Math.round(sample * gain)));
  peakAfter = Math.max(peakAfter, Math.abs(scaled));
  out.writeInt16LE(scaled, i);
}

const newBase64 = out.toString("base64");
const updated = source.replace(originalBase64, newBase64);
writeFileSync(target, updated);

console.log(`Scaled thinking tone by ${gain}.`);
console.log(`  samples:   ${buf.byteLength / 2}`);
console.log(`  peak abs:  ${peakBefore} -> ${peakAfter}`);
console.log(`  base64 len ${originalBase64.length} -> ${newBase64.length}`);
console.log(`  wrote ${target}`);
