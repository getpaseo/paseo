import { describe, expect, it } from "vitest";

import {
  applyControlValues,
  pruneControlValues,
  resolveControlValues,
  resolveFeatureValues,
} from "./feature-preferences";

describe("feature-preferences", () => {
  const features = [
    {
      type: "toggle" as const,
      id: "fast_mode",
      label: "Fast",
      value: false,
    },
    {
      type: "toggle" as const,
      id: "plan_mode",
      label: "Plan",
      value: false,
    },
  ];

  it("restores persisted values for available features", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          unknown_feature: true,
        },
        localFeatureValues: {},
      }),
    ).toEqual({
      fast_mode: true,
    });
  });

  it("prefers local values over persisted values", () => {
    expect(
      resolveFeatureValues({
        features,
        persistedFeatureValues: {
          fast_mode: true,
          plan_mode: false,
        },
        localFeatureValues: {
          fast_mode: false,
        },
      }),
    ).toEqual({
      fast_mode: false,
      plan_mode: false,
    });
  });
});

describe("composer control values", () => {
  const controls = [
    { kind: "toggle" as const, id: "verbose", label: "Verbose", value: false },
    {
      kind: "select" as const,
      id: "tier",
      label: "Tier",
      value: null,
      options: [{ id: "flex", label: "Flex" }],
    },
    { kind: "action" as const, id: "send-pony", label: "Send pony" },
  ];

  it("resolves local over persisted values for value controls only", () => {
    expect(
      resolveControlValues({
        controls,
        persistedControlValues: { verbose: true, tier: "flex", sendPony: true },
        localControlValues: { verbose: false },
      }),
    ).toEqual({ verbose: false, tier: "flex" });
  });

  it("prunes values whose control id is gone and ignores actions", () => {
    expect(pruneControlValues({ verbose: true, retired: true }, controls)).toEqual({
      verbose: true,
    });
  });

  it("overlays stored values onto descriptors without touching actions", () => {
    expect(applyControlValues(controls, { verbose: true, tier: "flex" })).toEqual([
      { kind: "toggle", id: "verbose", label: "Verbose", value: true },
      {
        kind: "select",
        id: "tier",
        label: "Tier",
        value: "flex",
        options: [{ id: "flex", label: "Flex" }],
      },
      { kind: "action", id: "send-pony", label: "Send pony" },
    ]);
  });
});
