import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
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
  it("allocates linearly when a large image-bearing frame arrives in small chunks", () => {
    const fixture = fileURLToPath(new URL("./test-utils/jsonl-frame-memory.ts", import.meta.url));
    const output = execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", fixture], {
      encoding: "utf8",
      timeout: 20_000,
    });
    const memory = JSON.parse(output) as { allocated: number; inputChars: number; frames: number };
    expect(memory.frames).toBe(1);
    expect(memory.allocated).toBeLessThan(memory.inputChars * 12);
  });

  it("publishes ordinary frames across arbitrary stream chunks", () => {
    const { decoder, frames, problems } = decoderHarness();
    decoder.write('{"type":"ready"');
    decoder.write('}\r\n{"type":"notice","value":2}\n');
    expect(frames).toEqual([{ type: "ready" }, { type: "notice", value: 2 }]);
    expect(problems).toEqual([]);
  });

  it("keeps partial Unicode lines across empty writes and split CRLF boundaries", () => {
    const { decoder, frames, problems } = decoderHarness();
    decoder.write('\n \r\n{"text":"中文');
    decoder.write("");
    decoder.write("\ud83d");
    decoder.write('\ude80"}\r');
    expect(frames).toEqual([]);
    decoder.write('\n{"type":"next"}\n{"type":"last"');
    expect(frames).toEqual([{ text: "中文🚀" }, { type: "next" }]);
    decoder.write("}\n");
    expect(frames).toEqual([{ text: "中文🚀" }, { type: "next" }, { type: "last" }]);
    expect(problems).toEqual([]);
  });

  it("recovers from a fragmented invalid line without losing subsequent frames", () => {
    const { decoder, frames, problems } = decoderHarness();
    decoder.write('{"broken":');
    decoder.write('\nnull\n[]\n{"type":"ready"}\n');
    expect(frames).toEqual([{ type: "ready" }]);
    expect(problems).toEqual(["invalid-json"]);
  });

  it("reassembles a large ordered v2 frame", () => {
    const { decoder, frames, problems } = decoderHarness();
    const frame = { type: "models", value: "中文🚀".repeat(256 * 1024) };
    for (const chunk of chunkFrames(frame, 256 * 1024)) {
      const line = `${JSON.stringify(chunk)}\n`;
      for (let offset = 0; offset < line.length; offset += 8192) {
        decoder.write(line.slice(offset, offset + 8192));
      }
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
