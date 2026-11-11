import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { decodeDiffFrame } from "@getpaseo/protocol/binary-frames/index";
import { validateWSOutboundMessage } from "@getpaseo/protocol/validation/ws-outbound";
import { DiffStream } from "../src/diff/stream.js";
const artifacts = resolve(import.meta.dirname, "../../../.artifacts/diff-subscription");
const results = [];
for (const count of [1, 30]) {
  const corpus = JSON.parse(await readFile(resolve(artifacts, `corpus-${count}.json`), "utf8")) as {
    frames: string[];
    legacy: string;
  };
  const frames = corpus.frames.map((value) => Buffer.from(value, "base64"));
  const binary: number[] = [];
  const json: number[] = [];
  for (let iteration = 0; iteration < 15; iteration++) {
    let files = 0;
    const stream = new DiffStream((state) => {
      if (state.phase === "ready") files = state.files.length;
    });
    let start = performance.now();
    for (const frame of frames) stream.receive(decodeDiffFrame(frame));
    binary.push(performance.now() - start);
    start = performance.now();
    validateWSOutboundMessage(JSON.parse(corpus.legacy));
    json.push(performance.now() - start);
    if (!files) throw new Error("No materialized files");
  }
  const median = (values: number[]) =>
    values.slice(3).sort((a, b) => a - b)[Math.floor((values.length - 3) / 2)];
  const result = { count, materializationMs: median(binary), jsonParseValidationMs: median(json) };
  results.push(result);
  console.log(JSON.stringify(result));
}
await writeFile(resolve(artifacts, "client-metrics.json"), JSON.stringify(results, null, 2));
if (results.some((result) => result.materializationMs > result.jsonParseValidationMs))
  process.exitCode = 1;
