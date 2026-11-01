import { describe, expect, test } from "vitest";
import { convertLegacyOptions, foldHookFeatureValues } from "./option-controls.js";

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

describe("foldHookFeatureValues", () => {
  const convert = (options: Record<string, unknown>) =>
    convertLegacyOptions({ provider: "codex", options });

  test("a hook that edits featureValues.fast_mode sets service_tier", () => {
    const sent = { providerOptions: {}, featureValues: {} };
    const returned = { providerOptions: {}, featureValues: { fast_mode: true } };

    expect(foldHookFeatureValues({ returned, sent, convert }).providerOptions).toEqual({
      service_tier: "fast",
    });
  });

  test("a hook that replaces the speed it was sent with fast_mode selects Fast", () => {
    const sent = {
      providerOptions: { service_tier: "default" },
      featureValues: { service_tier: "default" },
    };
    const returned = { ...sent, featureValues: { fast_mode: true } };

    expect(foldHookFeatureValues({ returned, sent, convert }).providerOptions).toEqual({
      service_tier: "fast",
    });
  });
});
