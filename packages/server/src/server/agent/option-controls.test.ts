import { describe, expect, test } from "vitest";
import {
  convertLegacyOptions,
  foldFeatureValues,
  foldHookFeatureValues,
} from "./option-controls.js";

describe("convertLegacyOptions", () => {
  test.each([
    { legacy: true, tier: "fast" },
    { legacy: false, tier: "default" },
    { legacy: null, tier: null },
  ])("Codex fast_mode: $legacy becomes service_tier: $tier", ({ legacy, tier }) => {
    expect(
      convertLegacyOptions({ provider: "codex", options: { fast_mode: legacy, plan_mode: true } }),
    ).toEqual({ plan_mode: true, service_tier: tier });
  });

  test("a service_tier in the same input wins", () => {
    expect(
      convertLegacyOptions({
        provider: "codex",
        options: { service_tier: "default", fast_mode: true },
      }),
    ).toEqual({ service_tier: "default" });
  });

  test("other providers keep fast_mode", () => {
    const options = { fast_mode: true };
    expect(convertLegacyOptions({ provider: "claude", options })).toBe(options);
  });
});

describe("legacy Codex Fast at the other entry points", () => {
  test("a stored record's fast_mode folds into service_tier", () => {
    expect(
      foldFeatureValues({
        config: { featureValues: { fast_mode: true }, providerOptions: { plan_mode: false } },
        provider: "codex",
      }).providerOptions,
    ).toEqual({ plan_mode: false, service_tier: "fast" });
  });

  test("a plugin hook that edits featureValues.fast_mode sets service_tier", () => {
    const sent = { provider: "codex", providerOptions: {}, featureValues: {} };
    const returned = { ...sent, featureValues: { fast_mode: true } };

    expect(foldHookFeatureValues({ returned, sent }).providerOptions).toEqual({
      service_tier: "fast",
    });
  });
});
