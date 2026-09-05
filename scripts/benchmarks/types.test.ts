import { describe, expect, it } from "vitest";
import { summarizeSamples } from "./stats";
import { parseBenchmarkTaskResult } from "./types";

describe("benchmark result contract", () => {
  it("parses task cases into the shared result type", () => {
    expect(
      parseBenchmarkTaskResult({
        schemaVersion: 1,
        taskId: "example",
        generatedAt: "2026-07-18T00:00:00.000Z",
        metadata: { repetitions: 3 },
        cases: [
          {
            id: "small",
            dimensions: { bytes: 64 },
            metrics: {
              duration: {
                unit: "ms",
                values: { p50: 1, p95: 2 },
                samples: [1, 2, 3],
              },
            },
          },
        ],
      }),
    ).toMatchObject({
      taskId: "example",
      cases: [{ id: "small", metrics: { duration: { values: { p50: 1, p95: 2 } } } }],
    });
  });

  it("rejects malformed metric values at the runner boundary", () => {
    expect(() =>
      parseBenchmarkTaskResult({
        schemaVersion: 1,
        taskId: "example",
        generatedAt: "2026-07-18T00:00:00.000Z",
        cases: [
          {
            id: "small",
            dimensions: {},
            metrics: { duration: { unit: "ms", values: { p50: "fast" } } },
          },
        ],
      }),
    ).toThrow("cases[0].metrics.duration.values.p50 must be a finite number");
  });
});

describe("summarizeSamples", () => {
  it("sorts samples without mutating the input and reports p50/p95", () => {
    const samples = [4, 1, 3, 2];
    expect(summarizeSamples(samples)).toEqual({ p50: 2, p95: 4, samples: [1, 2, 3, 4] });
    expect(samples).toEqual([4, 1, 3, 2]);
  });
});
