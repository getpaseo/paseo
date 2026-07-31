import { describe, expect, test } from "vitest";

import { mapOmpModel } from "./map-omp-model.js";
import type { OmpModel } from "./rpc-types.js";

function baseModel(overrides: Partial<OmpModel> = {}): OmpModel {
  return {
    provider: "pioneer",
    id: "canada-quant/glm-5.2",
    name: "GLM-5.2",
    ...overrides,
  };
}

describe("mapOmpModel thinking options", () => {
  test("limits thinking options to the model's reported efforts", () => {
    const model = baseModel({
      reasoning: true,
      thinking: {
        mode: "effort",
        efforts: ["high", "xhigh"],
        defaultLevel: "xhigh",
        effortMap: { high: "high", xhigh: "max" },
      },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual(["high", "xhigh"]);
    expect(result.defaultThinkingOptionId).toBe("xhigh");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("xhigh");
  });

  test("exposes the full set when reasoning is true but no thinking config is reported", () => {
    const model = baseModel({ reasoning: true });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(result.defaultThinkingOptionId).toBe("medium");
  });

  test("exposes the full set when efforts is empty", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: [], defaultLevel: "high" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
  });

  test("omits thinking options entirely when reasoning is false", () => {
    const model = baseModel({ reasoning: false });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions).toBeUndefined();
    expect(result.defaultThinkingOptionId).toBeUndefined();
  });

  test("omits thinking options when reasoning is absent", () => {
    const model = baseModel({});

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions).toBeUndefined();
    expect(result.defaultThinkingOptionId).toBeUndefined();
  });

  test("falls back to the first available option when defaultLevel is not in efforts", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "xhigh" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual(["low", "high"]);
    expect(result.defaultThinkingOptionId).toBe("low");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("low");
  });

  test("uses the first option as default when defaultLevel is absent", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual(["low", "medium", "high"]);
    expect(result.defaultThinkingOptionId).toBe("low");
  });

  test("falls back to the full set when every reported effort is unknown", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["ultra", "turbo"], defaultLevel: "turbo" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(result.defaultThinkingOptionId).toBe("medium");
  });

  test("preserves provider and model id in the mapped definition", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["high", "xhigh"], defaultLevel: "xhigh" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.provider).toBe("omp");
    expect(result.id).toBe("pioneer/canada-quant/glm-5.2");
    expect(result.label).toBe("pioneer/GLM-5.2");
    expect(result.metadata).toEqual({ provider: "pioneer", modelId: "canada-quant/glm-5.2" });
  });
});
