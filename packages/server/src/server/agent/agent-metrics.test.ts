import { describe, expect, it } from "vitest";
import { sanitizeAgentMetrics, withModelMetric } from "./agent-metrics.js";

describe("sanitizeAgentMetrics", () => {
  it("keeps well-formed metrics in the provider's order", () => {
    const metrics = [
      { label: "Model", value: "GPT-5.4" },
      { label: "Cache", value: "82%", tone: "ok" },
    ];
    expect(sanitizeAgentMetrics(metrics)).toEqual(metrics);
  });

  it("drops rows a client could not render and keeps the rest", () => {
    expect(
      sanitizeAgentMetrics([
        { label: "Cost", value: 1.23 },
        "junk",
        null,
        { label: "", value: "empty label" },
        { value: "no label" },
        { label: "Elapsed", value: "1.2s", extra: true },
      ]),
    ).toEqual([{ label: "Elapsed", value: "1.2s" }]);
  });

  it("drops a tone clients do not know and keeps the row", () => {
    expect(sanitizeAgentMetrics([{ label: "Cache", value: "82%", tone: "sparkly" }])).toEqual([
      { label: "Cache", value: "82%" },
    ]);
  });

  it("treats anything that is not a list as no metrics", () => {
    expect(sanitizeAgentMetrics(undefined)).toEqual([]);
    expect(sanitizeAgentMetrics({ label: "Model", value: "GPT-5.4" })).toEqual([]);
  });

  it("bounds what one provider can put on every snapshot", () => {
    const flood = Array.from({ length: 500 }, (_, index) => ({
      label: `Metric ${index}`,
      value: "x".repeat(10_000),
    }));
    const sanitized = sanitizeAgentMetrics(flood);
    expect(sanitized).toHaveLength(32);
    expect(sanitized[0].value).toHaveLength(256);
  });
});

describe("withModelMetric", () => {
  it("leads with the model when no row names one", () => {
    expect(withModelMetric([{ label: "Elapsed", value: "1.2s" }], "gpt-5.4")).toEqual([
      { label: "Model", value: "gpt-5.4" },
      { label: "Elapsed", value: "1.2s" },
    ]);
  });

  it("leaves a provider's own model row alone, whatever its case", () => {
    const metrics = [{ label: "model", value: "GPT-5.4 (fast)" }];
    expect(withModelMetric(metrics, "gpt-5.4")).toEqual(metrics);
  });

  it("adds nothing when the model is unknown", () => {
    expect(withModelMetric([], null)).toEqual([]);
    expect(withModelMetric([], undefined)).toEqual([]);
  });
});
