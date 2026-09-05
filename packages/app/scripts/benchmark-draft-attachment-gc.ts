import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { summarizeSamples, type BenchmarkTaskResult } from "./benchmark-support";
import { collectStreamUserImageIds } from "../src/stores/draft-store/state";
import type { StreamItem } from "../src/types/stream";

const SESSION_COUNTS = [0, 100, 500] as const;
const ITEMS_PER_SESSION = 176;
const KEYSTROKES = 60;
const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;

interface PolicyMeasurement {
  durationMs: number;
  scannedItems: number;
  scans: number;
}

function haveImageReferencesChanged(previousIds: readonly string[], nextIds: readonly string[]) {
  if (previousIds.length !== nextIds.length) return true;
  const nextIdSet = new Set(nextIds);
  return previousIds.some((id) => !nextIdSet.has(id));
}

function buildStreams(sessionCount: number): Map<string, StreamItem[]> {
  const streams = new Map<string, StreamItem[]>();
  for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
    const items = Array.from({ length: ITEMS_PER_SESSION }, (_, itemIndex): StreamItem => {
      if (itemIndex % 2 === 0) {
        return {
          kind: "user_message",
          id: `user-${sessionIndex}-${itemIndex}`,
          text: "benchmark prompt",
          images: [],
          timestamp: new Date(0),
        };
      }
      return {
        kind: "assistant_message",
        id: `assistant-${sessionIndex}-${itemIndex}`,
        text: "benchmark response",
        timestamp: new Date(0),
      };
    });
    streams.set(`agent-${sessionIndex}`, items);
  }
  return streams;
}

function measureAlwaysScan(streams: Map<string, StreamItem[]>): PolicyMeasurement {
  const startedAt = performance.now();
  for (let index = 0; index < KEYSTROKES; index += 1) {
    collectStreamUserImageIds(streams, new Set());
  }
  return {
    durationMs: performance.now() - startedAt,
    scannedItems: streams.size * ITEMS_PER_SESSION * KEYSTROKES,
    scans: KEYSTROKES,
  };
}

function measureImageReferencePolicy(streams: Map<string, StreamItem[]>): PolicyMeasurement {
  let scans = 0;
  const startedAt = performance.now();
  for (let index = 0; index < KEYSTROKES; index += 1) {
    if (haveImageReferencesChanged([], [])) {
      collectStreamUserImageIds(streams, new Set());
      scans += 1;
    }
  }
  return {
    durationMs: performance.now() - startedAt,
    scannedItems: streams.size * ITEMS_PER_SESSION * scans,
    scans,
  };
}

function measurePolicy(
  streams: Map<string, StreamItem[]>,
  policy: (streams: Map<string, StreamItem[]>) => PolicyMeasurement,
): PolicyMeasurement[] {
  for (let index = 0; index < WARMUP_RUNS; index += 1) {
    policy(streams);
  }
  return Array.from({ length: MEASURED_RUNS }, () => policy(streams));
}

const cases = SESSION_COUNTS.map((sessionCount) => {
  const streams = buildStreams(sessionCount);
  const baseline = measurePolicy(streams, measureAlwaysScan);
  const candidate = measurePolicy(streams, measureImageReferencePolicy);
  const expectedScannedItems = sessionCount * ITEMS_PER_SESSION * KEYSTROKES;
  if (
    baseline.some(
      (sample) => sample.scans !== KEYSTROKES || sample.scannedItems !== expectedScannedItems,
    )
  ) {
    throw new Error(
      `baseline GC scan did not cover every stream item for ${sessionCount} sessions`,
    );
  }
  if (candidate.some((sample) => sample.scans !== 0 || sample.scannedItems !== 0)) {
    throw new Error(
      `text-only draft changes unexpectedly triggered GC for ${sessionCount} sessions`,
    );
  }
  const baselineDuration = summarizeSamples(baseline.map((sample) => sample.durationMs));
  const candidateDuration = summarizeSamples(candidate.map((sample) => sample.durationMs));
  return {
    id: `${sessionCount}-sessions`,
    dimensions: {
      sessionCount,
      itemsPerSession: ITEMS_PER_SESSION,
      keystrokes: KEYSTROKES,
      candidatePolicy: "skip GC when draft image ids are unchanged",
    },
    metrics: {
      baselineDuration: {
        unit: "ms",
        values: { p50: baselineDuration.p50, p95: baselineDuration.p95 },
        samples: baselineDuration.samples,
      },
      candidateDuration: {
        unit: "ms",
        values: { p50: candidateDuration.p50, p95: candidateDuration.p95 },
        samples: candidateDuration.samples,
      },
      baselineScans: {
        unit: "count",
        values: { total: baseline[0]?.scans ?? 0 },
      },
      candidateScans: {
        unit: "count",
        values: { total: candidate[0]?.scans ?? 0 },
      },
      baselineItemsScanned: {
        unit: "count",
        values: { total: baseline[0]?.scannedItems ?? 0 },
      },
      candidateItemsScanned: {
        unit: "count",
        values: { total: candidate[0]?.scannedItems ?? 0 },
      },
    },
  };
});

const output = {
  schemaVersion: 1,
  taskId: "draft-attachment-gc",
  generatedAt: new Date().toISOString(),
  metadata: {
    warmupRuns: WARMUP_RUNS,
    measuredRuns: MEASURED_RUNS,
  },
  cases,
} satisfies BenchmarkTaskResult;

const serialized = `${JSON.stringify(output, null, 2)}\n`;
const outputPath = process.env.PASEO_BENCHMARK_OUTPUT;
if (outputPath) {
  writeFileSync(outputPath, serialized);
}
if (process.env.PASEO_BENCHMARK_QUIET !== "1") {
  process.stdout.write(serialized);
}
