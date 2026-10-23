import assert from "node:assert/strict";
import { Session } from "node:inspector/promises";
import { JsonlFrameDecoder } from "../jsonl-frame-decoder.js";

// Measure allocations, including collected strings: retained heap alone misses the peak.
const image = "A".repeat(4 * 1024 * 1024);
const payload = `${JSON.stringify({
  type: "agent_end",
  messages: [{ text: "中文🚀", content: [{ type: "image", data: image }] }],
})}\n`;
let frames = 0;
const decoder = new JsonlFrameDecoder({
  frame(message) {
    assert.deepEqual(message, JSON.parse(payload));
    frames++;
  },
  problem(problem) {
    throw new Error(problem);
  },
});
const session = new Session();
session.connect();
global.gc!();
await session.post("HeapProfiler.startSampling", {
  samplingInterval: 32 * 1024,
  includeObjectsCollectedByMajorGC: true,
  includeObjectsCollectedByMinorGC: true,
});
try {
  for (let offset = 0; offset < payload.length; offset += 16 * 1024) {
    decoder.write(payload.slice(offset, offset + 16 * 1024));
  }
  const { profile } = await session.post("HeapProfiler.stopSampling");
  function allocated(node: typeof profile.head): number {
    return node.selfSize + (node.children ?? []).reduce((sum, child) => sum + allocated(child), 0);
  }
  console.log(
    JSON.stringify({ allocated: allocated(profile.head), inputChars: payload.length, frames }),
  );
} finally {
  session.disconnect();
}
