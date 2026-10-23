import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { writeFileSync } from "node:fs";
import { setImmediate as nextTurn } from "node:timers/promises";

// Run in a fresh process: node --expose-gc jsonl-benchmark.mjs <decoder-module-url>
const { JsonlFrameDecoder } = await import(process.argv[2]);
const size = Number(process.env.FRAME_CHARS ?? 26151450);
const chunk = Number(process.env.CHUNK_CHARS ?? 65536);
const wide = process.env.WIDE_TEXT !== "0";
const payload = `${JSON.stringify({
  type: "agent_end",
  note: wide ? "中文🚀" : "image",
  messages: [{ content: [{ type: "image", mimeType: "image/png", data: "A".repeat(size) }] }],
})}\n`;
let frames = 0;
const decoder = new JsonlFrameDecoder({
  frame(frame) {
    assert.equal(frame.messages[0].content[0].data.length, size);
    assert.equal(frame.note, wide ? "中文🚀" : "image");
    frames++;
  },
  problem(problem) {
    throw new Error(problem);
  },
});
const session = new Session();
session.connect();
global.gc();
const baseline = process.memoryUsage().heapUsed;
await session.post("HeapProfiler.startSampling", {
  samplingInterval: 32768,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
let peak = baseline;
const start = performance.now();
for (let offset = 0; offset < payload.length; offset += chunk) {
  decoder.write(payload.slice(offset, offset + chunk));
  peak = Math.max(peak, process.memoryUsage().heapUsed);
  await nextTurn();
}
const elapsedMs = performance.now() - start;
const { profile } = await session.post("HeapProfiler.stopSampling");
session.disconnect();
const byFunction = new Map();
let total = 0;
function visit(node) {
  const key = node.callFrame.functionName;
  total += node.selfSize;
  byFunction.set(key, (byFunction.get(key) ?? 0) + node.selfSize);
  for (const child of node.children ?? []) visit(child);
}
visit(profile.head);
assert.equal(frames, 1);
const result = {
  node: process.version,
  v8: process.versions.v8,
  inputChars: payload.length,
  inputBytes: Buffer.byteLength(payload),
  imageChars: size,
  chunk,
  wide,
  frames,
  elapsedMs,
  sampledAllocationsMiB: total / 1048576,
  peakHeapIncreaseMiB: (peak - baseline) / 1048576,
  top: [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 5),
};
if (process.env.PROFILE_OUT) writeFileSync(process.env.PROFILE_OUT, JSON.stringify(profile));
console.log(JSON.stringify(result));
