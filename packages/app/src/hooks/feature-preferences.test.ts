import { describe, expect, it } from "vitest";

import { resolveFeatureValues } from "./feature-preferences";

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

it("defaults only supported auto accept to true and preserves explicit false and Plan", () => {
  const features = [
    { id: "auto_accept", label: "Auto Accept", type: "toggle" as const, value: false },
    { id: "plan_mode", label: "Plan", type: "toggle" as const, value: false },
  ];
  expect(
    resolveFeatureValues({
      features,
      persistedFeatureValues: {},
      localFeatureValues: { plan_mode: true },
    }),
  ).toEqual({ auto_accept: true, plan_mode: true });
  expect(
    resolveFeatureValues({
      features,
      persistedFeatureValues: { auto_accept: false },
      localFeatureValues: {},
    }),
  ).toEqual({ auto_accept: false });
  expect(
    resolveFeatureValues({
      features,
      persistedFeatureValues: {},
      localFeatureValues: {},
      hasPermissionModes: true,
    }),
  ).toEqual({});
});
