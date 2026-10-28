import { measureMainThreadWork } from "../../../test-utils/main-thread-work.js";
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

  it("preserves UTF-8 characters split across raw stdout buffers", () => {
    const { decoder, frames, problems } = decoderHarness();
    const bytes = Buffer.from('{"type":"notice","text":"é🙂"}\n');
    const split = bytes.indexOf(Buffer.from("🙂")) + 1;
    decoder.write(bytes.subarray(0, split));
    decoder.write(bytes.subarray(split));
    expect(frames).toEqual([{ type: "notice", text: "é🙂" }]);
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

describe("provider line admission", () => {
  it("keeps the loop responsive while accumulating a fragmented provider response", async () => {
    const { decoder, frames, problems } = decoderHarness();
    const part = "x".repeat(512);
    const { blockingMs } = await measureMainThreadWork("fragmented JSONL main-thread work", () => {
      decoder.write('{"type":"notice","text":"');
      // 1 MiB exposes the former rescan of every accumulated prefix.
      for (let index = 0; index < 2048; index++) decoder.write(part);
      decoder.write('"}\n');
    });
    expect(frames).toEqual([{ type: "notice", text: part.repeat(2048) }]);
    expect(problems).toEqual([]);
    expect(blockingMs).toBeLessThan(50);
  });

  it("rejects an unterminated over-cap UTF-8 line and stops accepting frames", () => {
    const frames: Record<string, unknown>[] = [];
    const failures: Array<{ problem: string; detail: unknown }> = [];
    const decoder = new JsonlFrameDecoder({
      frame: (frame) => frames.push(frame),
      problem: (problem, detail) => failures.push({ problem, detail }),
    });
    // 64 MiB of UTF-8, only 32 Mi UTF-16 code units. No newline or JSON parse needed.
    const chunk = "é".repeat(32 * 1024);
    for (let index = 0; index < 1024; index++) decoder.write(chunk);
    expect(failures).toEqual([]);
    decoder.write("é");
    expect(failures).toEqual([
      {
        problem: "line-too-large",
        detail: expect.objectContaining({
          name: "ProviderStreamLimitError",
          code: "PROVIDER_STREAM_LINE_TOO_LARGE",
          limitBytes: 64 * 1024 * 1024,
        }),
      },
    ]);
    decoder.write('\n{"type":"ready"}\n');
    expect(frames).toEqual([]);
    expect(failures).toHaveLength(1);
  });
});
