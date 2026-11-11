import { describe, expect, it } from "vitest";
import { JsonlFrameDecoder, type JsonlFrameProblem } from "./jsonl-frame-decoder.js";

function decoderHarness() {
  const frames: Record<string, unknown>[] = [];
  const problems: JsonlFrameProblem[] = [];
  return {
    frames,
    problems,
    decoder: new JsonlFrameDecoder({
      frame: (frame) => frames.push(frame),
      problem: (problem) => problems.push(problem),
    }),
  };
}

function chunkFrames(frame: Record<string, unknown>, chunkSize: number) {
  const payload = Buffer.from(JSON.stringify(frame));
  const count = Math.ceil(payload.byteLength / chunkSize);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId: "catalog",
    index,
    count,
    byteLength: payload.byteLength,
    data: payload.subarray(index * chunkSize, (index + 1) * chunkSize).toString("base64"),
  }));
}

describe("JsonlFrameDecoder", () => {
  it("publishes ordinary frames across arbitrary stream chunks", () => {
    const { decoder, frames, problems } = decoderHarness();
    decoder.write('{"type":"ready"');
    decoder.write('}\r\n{"type":"notice","value":2}\n');
    expect(frames).toEqual([{ type: "ready" }, { type: "notice", value: 2 }]);
    expect(problems).toEqual([]);
  });

  it("reassembles a large ordered v2 frame", () => {
    const { decoder, frames, problems } = decoderHarness();
    const frame = { type: "models", value: "x".repeat(1024 * 1024) };
    for (const chunk of chunkFrames(frame, 256 * 1024)) {
      decoder.write(`${JSON.stringify(chunk)}\n`);
    }
    expect(frames).toEqual([frame]);
    expect(problems).toEqual([]);
  });

  it("drops an out-of-order sequence before accepting the next frame", () => {
    const { decoder, frames, problems } = decoderHarness();
    const chunks = chunkFrames({ type: "models", value: "x".repeat(1024 * 1024) }, 256 * 1024);
    decoder.write(`${JSON.stringify(chunks[1])}\n`);
    decoder.write('{"type":"ready"}\n');
    expect(frames).toEqual([{ type: "ready" }]);
    expect(problems).toEqual(["out-of-order-chunk"]);
  });
});
