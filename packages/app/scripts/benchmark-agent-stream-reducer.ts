import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { isDeepStrictEqual } from "node:util";
import type { AgentStreamEventPayload } from "@getpaseo/protocol/messages";
import { summarizeSamples } from "../../../scripts/benchmarks/stats";
import type { BenchmarkTaskResult } from "../../../scripts/benchmarks/types";
import {
  processAgentStreamEvent,
  processAgentStreamEvents,
  type AgentStreamReducerEvent,
  type TimelineCursor,
} from "../src/timeline/session-stream-reducers";
import type { StreamItem } from "../src/types/stream";

const CHUNK_BYTES = 512;
const WARMUP_PAIRS = 5;
const MEASURED_PAIRS = 30;

type BenchmarkVariant = "baseline" | "coalesced";

interface BenchmarkCase {
  messageBytes: number;
  chunksPerFlush: number;
  repetitionsPerSample: number;
}

const BENCHMARK_CASES: BenchmarkCase[] = [
  { messageBytes: 64 * 1024, chunksPerFlush: 8, repetitionsPerSample: 64 },
  { messageBytes: 256 * 1024, chunksPerFlush: 8, repetitionsPerSample: 8 },
  { messageBytes: 1024 * 1024, chunksPerFlush: 8, repetitionsPerSample: 1 },
  { messageBytes: 256 * 1024, chunksPerFlush: 1, repetitionsPerSample: 8 },
  { messageBytes: 256 * 1024, chunksPerFlush: 2, repetitionsPerSample: 8 },
  { messageBytes: 256 * 1024, chunksPerFlush: 4, repetitionsPerSample: 8 },
];

interface VariantSummary {
  p50Ms: number;
  p95Ms: number;
  samplesMs: number[];
}

interface PairedReductionSummary {
  p05Percent: number;
  p50Percent: number;
  p95Percent: number;
  samplesPercent: number[];
}

interface BenchmarkResult extends BenchmarkCase {
  chunkBytes: number;
  chunkCount: number;
  baseline: VariantSummary;
  coalesced: VariantSummary;
  pairedReduction: PairedReductionSummary;
}

interface Workload {
  batches: AgentStreamReducerEvent[][];
  expectedText: string;
}

interface ReducerState {
  tail: StreamItem[];
  head: StreamItem[];
  cursor: TimelineCursor | undefined;
}

interface WorkloadResult extends ReducerState {
  changedTail: boolean;
  changedHead: boolean;
  cursorChanged: boolean;
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  const index = Math.ceil((percentileValue / 100) * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, index)] ?? 0;
}

function summarizeDurations(samples: number[]): VariantSummary {
  const summary = summarizeSamples(samples);
  return {
    p50Ms: summary.p50,
    p95Ms: summary.p95,
    samplesMs: summary.samples,
  };
}

function buildWorkload(input: BenchmarkCase): Workload {
  if (input.messageBytes % CHUNK_BYTES !== 0) {
    throw new Error(`messageBytes must be divisible by ${CHUNK_BYTES}`);
  }

  const chunkCount = input.messageBytes / CHUNK_BYTES;
  const events = Array.from({ length: chunkCount }, (_, index): AgentStreamReducerEvent => {
    const seq = index + 1;
    const marker = `${index.toString(36).padStart(8, "0")}:`;
    const text = `${marker}${"x".repeat(CHUNK_BYTES - marker.length)}`;
    return {
      event: {
        type: "timeline",
        provider: "claude",
        item: {
          type: "assistant_message",
          messageId: "benchmark-message",
          text,
        },
      } satisfies AgentStreamEventPayload,
      seq,
      epoch: "benchmark-epoch",
      timestamp: new Date(seq),
    };
  });

  const batches: AgentStreamReducerEvent[][] = [];
  for (let index = 0; index < events.length; index += input.chunksPerFlush) {
    batches.push(events.slice(index, index + input.chunksPerFlush));
  }
  return {
    batches,
    expectedText: events
      .map((entry) => {
        if (entry.event.type !== "timeline" || entry.event.item.type !== "assistant_message") {
          throw new Error("benchmark built a non-assistant event");
        }
        return entry.event.item.text;
      })
      .join(""),
  };
}

function runBaselineBatch(events: AgentStreamReducerEvent[], state: ReducerState): WorkloadResult {
  let { tail, head, cursor } = state;
  let changedTail = false;
  let changedHead = false;
  let cursorChanged = false;
  const sideEffects: unknown[] = [];
  for (const reducerEvent of events) {
    const result = processAgentStreamEvent({
      event: reducerEvent.event,
      seq: reducerEvent.seq,
      epoch: reducerEvent.epoch,
      currentTail: tail,
      currentHead: head,
      currentCursor: cursor,
      timestamp: reducerEvent.timestamp,
    });
    tail = result.tail;
    head = result.head;
    changedTail = changedTail || result.changedTail;
    changedHead = changedHead || result.changedHead;
    sideEffects.push(...result.sideEffects);
    if (result.cursorChanged) {
      cursor = result.cursor ?? undefined;
      cursorChanged = true;
    }
  }
  if (sideEffects.length > 0) {
    throw new Error("assistant-only baseline unexpectedly produced a side effect");
  }
  return { tail, head, cursor, changedTail, changedHead, cursorChanged };
}

function runWorkload(workload: Workload, variant: BenchmarkVariant): WorkloadResult {
  let state: ReducerState = { tail: [], head: [], cursor: undefined };
  let changedTail = false;
  let changedHead = false;
  let cursorChanged = false;
  for (const events of workload.batches) {
    let batchResult: WorkloadResult;
    if (variant === "baseline") {
      batchResult = runBaselineBatch(events, state);
    } else {
      const result = processAgentStreamEvents({
        events,
        currentTail: state.tail,
        currentHead: state.head,
        currentCursor: state.cursor,
      });
      if (result.sideEffects.length > 0) {
        throw new Error("assistant-only candidate unexpectedly produced a side effect");
      }
      batchResult = {
        tail: result.tail,
        head: result.head,
        cursor: result.cursor ?? undefined,
        changedTail: result.changedTail,
        changedHead: result.changedHead,
        cursorChanged: result.cursorChanged,
      };
    }
    state = {
      tail: batchResult.tail,
      head: batchResult.head,
      cursor: batchResult.cursor,
    };
    changedTail = changedTail || batchResult.changedTail;
    changedHead = changedHead || batchResult.changedHead;
    cursorChanged = cursorChanged || batchResult.cursorChanged;
  }
  return { ...state, changedTail, changedHead, cursorChanged };
}

function validateWorkload(input: BenchmarkCase, workload: Workload, result: WorkloadResult): void {
  const assistantItems = [...result.tail, ...result.head].filter(
    (item): item is Extract<StreamItem, { kind: "assistant_message" }> =>
      item.kind === "assistant_message",
  );
  const expectedEndSeq = input.messageBytes / CHUNK_BYTES;
  if (
    assistantItems.length !== 1 ||
    assistantItems[0]?.text.length !== input.messageBytes ||
    assistantItems[0]?.text !== workload.expectedText ||
    result.cursor?.epoch !== "benchmark-epoch" ||
    result.cursor.startSeq !== 1 ||
    result.cursor.endSeq !== expectedEndSeq ||
    result.changedTail ||
    !result.changedHead ||
    !result.cursorChanged
  ) {
    throw new Error("agent stream reducer benchmark produced an invalid result");
  }
}

function measureSample(workload: Workload, variant: BenchmarkVariant, repetitions: number): number {
  const start = performance.now();
  for (let index = 0; index < repetitions; index += 1) {
    runWorkload(workload, variant);
  }
  return (performance.now() - start) / repetitions;
}

function benchmark(input: BenchmarkCase): BenchmarkResult {
  const workload = buildWorkload(input);
  const baselineValidation = runWorkload(workload, "baseline");
  const coalescedValidation = runWorkload(workload, "coalesced");
  validateWorkload(input, workload, baselineValidation);
  validateWorkload(input, workload, coalescedValidation);
  if (!isDeepStrictEqual(baselineValidation, coalescedValidation)) {
    throw new Error("baseline and coalesced reducers produced different final state");
  }

  for (let pair = 0; pair < WARMUP_PAIRS; pair += 1) {
    const variants: BenchmarkVariant[] =
      pair % 2 === 0 ? ["baseline", "coalesced"] : ["coalesced", "baseline"];
    for (const variant of variants) {
      measureSample(workload, variant, input.repetitionsPerSample);
    }
  }

  const samples: Record<BenchmarkVariant, number[]> = { baseline: [], coalesced: [] };
  for (let pair = 0; pair < MEASURED_PAIRS; pair += 1) {
    const variants: BenchmarkVariant[] =
      pair % 2 === 0 ? ["baseline", "coalesced"] : ["coalesced", "baseline"];
    for (const variant of variants) {
      samples[variant].push(measureSample(workload, variant, input.repetitionsPerSample));
    }
  }

  const baseline = summarizeDurations(samples.baseline);
  const coalesced = summarizeDurations(samples.coalesced);
  const pairedReductionSamples = samples.baseline
    .map((duration, index) => {
      const coalescedDuration = samples.coalesced[index];
      if (coalescedDuration === undefined) {
        throw new Error("paired benchmark samples are misaligned");
      }
      return (1 - coalescedDuration / duration) * 100;
    })
    .sort((left, right) => left - right);
  return {
    ...input,
    chunkBytes: CHUNK_BYTES,
    chunkCount: input.messageBytes / CHUNK_BYTES,
    baseline,
    coalesced,
    pairedReduction: {
      p05Percent: percentile(pairedReductionSamples, 5),
      p50Percent: percentile(pairedReductionSamples, 50),
      p95Percent: percentile(pairedReductionSamples, 95),
      samplesPercent: pairedReductionSamples,
    },
  };
}

const output = {
  schemaVersion: 1,
  taskId: "agent-stream-reducer",
  generatedAt: new Date().toISOString(),
  metadata: {
    methodology: "paired-interleaved-ab",
    warmupPairs: WARMUP_PAIRS,
    measuredPairs: MEASURED_PAIRS,
  },
  cases: BENCHMARK_CASES.map(benchmark).map((result) => ({
    id: `${result.messageBytes}-bytes-${result.chunksPerFlush}-chunks-per-flush`,
    dimensions: {
      messageBytes: result.messageBytes,
      chunkBytes: result.chunkBytes,
      chunkCount: result.chunkCount,
      chunksPerFlush: result.chunksPerFlush,
      repetitionsPerSample: result.repetitionsPerSample,
    },
    metrics: {
      baselineDuration: {
        unit: "ms",
        values: { p50: result.baseline.p50Ms, p95: result.baseline.p95Ms },
        samples: result.baseline.samplesMs,
      },
      coalescedDuration: {
        unit: "ms",
        values: { p50: result.coalesced.p50Ms, p95: result.coalesced.p95Ms },
        samples: result.coalesced.samplesMs,
      },
      pairedReduction: {
        unit: "percent",
        values: {
          p05: result.pairedReduction.p05Percent,
          p50: result.pairedReduction.p50Percent,
          p95: result.pairedReduction.p95Percent,
        },
        samples: result.pairedReduction.samplesPercent,
      },
    },
  })),
} satisfies BenchmarkTaskResult;
const serialized = `${JSON.stringify(output, null, 2)}\n`;
const outputPath = process.env.PASEO_BENCHMARK_OUTPUT;
if (outputPath) {
  writeFileSync(outputPath, serialized);
}
if (process.env.PASEO_BENCHMARK_QUIET !== "1") {
  process.stdout.write(serialized);
}
