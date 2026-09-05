export { summarizeSamples } from "../../../scripts/benchmarks/stats";
export type {
  BenchmarkCaseResult,
  BenchmarkMetricResult,
  BenchmarkProperty,
  BenchmarkTaskResult,
} from "../../../scripts/benchmarks/types";

export const BENCHMARK_FRAME_INTERVAL_MS = 1000 / 60;

export interface BenchmarkFrameGapSummary {
  delayedFrameIntervals: number;
  estimatedDroppedFrames: number;
  maxFrameGapMs: number;
}

export function summarizeFrameGaps(
  frameGapsMs: number[],
  frameIntervalMs = BENCHMARK_FRAME_INTERVAL_MS,
): BenchmarkFrameGapSummary {
  if (!Number.isFinite(frameIntervalMs) || frameIntervalMs <= 0) {
    throw new Error("frameIntervalMs must be a positive finite number");
  }
  if (frameGapsMs.some((gap) => !Number.isFinite(gap) || gap < 0)) {
    throw new Error("frame gaps must be finite non-negative numbers");
  }

  const delayedFrameThresholdMs = frameIntervalMs * 1.2;
  return {
    delayedFrameIntervals: frameGapsMs.filter((gap) => gap > delayedFrameThresholdMs).length,
    estimatedDroppedFrames: frameGapsMs.reduce(
      (total, gap) => total + Math.max(0, Math.round(gap / frameIntervalMs) - 1),
      0,
    ),
    maxFrameGapMs: Math.max(0, ...frameGapsMs),
  };
}
