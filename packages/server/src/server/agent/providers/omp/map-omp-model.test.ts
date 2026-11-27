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

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual(["auto", "high", "xhigh"]);
    expect(result.defaultThinkingOptionId).toBe("xhigh");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("xhigh");
  });

  test("exposes the full set when reasoning is true but no thinking config is reported", () => {
    const model = baseModel({ reasoning: true });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "auto",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(result.defaultThinkingOptionId).toBe("high");
  });

  test("exposes the full set when efforts is empty", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: [], defaultLevel: "high" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "auto",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(result.defaultThinkingOptionId).toBe("high");
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

  test("clamps a reported default the model does not support to the nearest effort", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "xhigh" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual(["auto", "low", "high"]);
    expect(result.defaultThinkingOptionId).toBe("high");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("high");
  });

  test("uses OMP's high default when the model reports no default level", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "medium", "high"] },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "auto",
      "low",
      "medium",
      "high",
    ]);
    expect(result.defaultThinkingOptionId).toBe("high");
  });

  test("clamps OMP's high default to the efforts a model reports", () => {
    const single = mapOmpModel(
      baseModel({ reasoning: true, thinking: { mode: "effort", efforts: ["low"] } }),
      "omp",
    );
    expect(single.defaultThinkingOptionId).toBe("low");

    const belowHigh = mapOmpModel(
      baseModel({
        reasoning: true,
        thinking: { mode: "effort", efforts: ["minimal", "low", "medium"] },
      }),
      "omp",
    );
    expect(belowHigh.defaultThinkingOptionId).toBe("medium");

    // Ties go to the lower effort, matching how OMP clamps.
    const tie = mapOmpModel(
      baseModel({
        reasoning: true,
        thinking: { mode: "effort", efforts: ["low", "medium", "xhigh"] },
      }),
      "omp",
    );
    expect(tie.defaultThinkingOptionId).toBe("medium");
  });

  test("keeps high as the default for a GLM 5.4 shape effort list", () => {
    const model = baseModel({
      provider: "glm",
      id: "glm-5.4",
      name: "GLM-5.4",
      reasoning: true,
      thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high", "xhigh"] },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.defaultThinkingOptionId).toBe("high");
    expect(result.thinkingOptions?.find((option) => option.isDefault)?.id).toBe("high");
  });

  test("falls back to the full set when every reported effort is unknown", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["ultra", "turbo"], defaultLevel: "turbo" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.map((option) => option.id)).toEqual([
      "auto",
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(result.defaultThinkingOptionId).toBe("high");
  });

  test("offers auto alongside reported efforts without making it the default", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["low", "high"], defaultLevel: "high" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.thinkingOptions?.at(0)).toEqual({
      id: "auto",
      label: "Auto",
      description: "OMP picks the effort each turn",
    });
    expect(result.defaultThinkingOptionId).toBe("high");
  });

  test("preserves provider and model id in the mapped definition", () => {
    const model = baseModel({
      reasoning: true,
      thinking: { mode: "effort", efforts: ["high", "xhigh"], defaultLevel: "xhigh" },
    });

    const result = mapOmpModel(model, "omp");

    expect(result.provider).toBe("omp");
    expect(result.id).toBe("pioneer/canada-quant/glm-5.2");
    expect(result.label).toBe("GLM-5.2");
    expect(result.metadata).toEqual({ provider: "pioneer", modelId: "canada-quant/glm-5.2" });
  });
});
