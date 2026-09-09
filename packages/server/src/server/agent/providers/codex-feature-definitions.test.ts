import { describe, expect, test } from "vitest";

import { buildCodexFeatures, codexModelSupportsFastMode } from "./codex-feature-definitions.js";

describe("codexModelSupportsFastMode", () => {
  test("supports the gpt-6 family (e.g. gpt-6-astra)", () => {
    expect(codexModelSupportsFastMode("gpt-6-astra")).toBe(true);
  });

  test("supports existing prefixes (e.g. gpt-5.6-sol)", () => {
    expect(codexModelSupportsFastMode("gpt-5.6-sol")).toBe(true);
  });

  test("rejects unsupported models", () => {
    expect(codexModelSupportsFastMode("unknown")).toBe(false);
  });
});

describe("buildCodexFeatures", () => {
  test("includes both fast_mode and plan_mode for a gpt-6 model", () => {
    const features = buildCodexFeatures({
      modelId: "gpt-6-astra",
      fastModeEnabled: false,
      planModeEnabled: true,
    });

    expect(features.map((feature) => ({ id: feature.id, value: feature.value }))).toEqual([
      { id: "fast_mode", value: false },
      { id: "plan_mode", value: true },
    ]);
  });

  test("includes only plan_mode for an unsupported model", () => {
    const features = buildCodexFeatures({
      modelId: "unknown",
      fastModeEnabled: true,
      planModeEnabled: false,
    });

    expect(features.map((feature) => ({ id: feature.id, value: feature.value }))).toEqual([
      { id: "plan_mode", value: false },
    ]);
  });
});
