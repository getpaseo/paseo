export interface SampleSummary {
  p50: number;
  p95: number;
  samples: number[];
}

function percentile(sortedSamples: number[], percentileValue: number): number {
  const index = Math.ceil((percentileValue / 100) * sortedSamples.length) - 1;
  return sortedSamples[Math.max(0, index)] ?? 0;
}

export function summarizeSamples(samples: number[]): SampleSummary {
  if (samples.length === 0) {
    throw new Error("benchmark samples must not be empty");
  }
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("benchmark samples must contain finite numbers");
  }
  const sortedSamples = [...samples].sort((left, right) => left - right);
  return {
    p50: percentile(sortedSamples, 50),
    p95: percentile(sortedSamples, 95),
    samples: sortedSamples,
  };
}
