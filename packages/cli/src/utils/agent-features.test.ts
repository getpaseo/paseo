import { describe, expect, it } from "vitest";
import type { AgentFeature } from "@getpaseo/protocol/agent-types";
import { formatFeatureValues, parseFeatureFlags, resolveFeatureValues } from "./agent-features.js";

const codexFeatures: AgentFeature[] = [
  {
    type: "select",
    id: "service_tier",
    label: "Speed",
    value: "default",
    options: [
      { id: "default", label: "Normal", isDefault: true },
      { id: "priority", label: "Fast" },
    ],
  },
  { type: "toggle", id: "plan_mode", label: "Plan", value: false },
];

describe("parseFeatureFlags", () => {
  it("reads id=value pairs and keeps the last value of a repeated id", () => {
    expect(
      parseFeatureFlags(["service_tier=default", "plan_mode=true", "service_tier=priority"]),
    ).toEqual({ service_tier: "priority", plan_mode: "true" });
  });

  it("keeps an id that names an Object prototype property, so it is reported", () => {
    const requested = parseFeatureFlags(["__proto__=true"]);
    expect(Object.keys(requested)).toEqual(["__proto__"]);
    expect(() => resolveFeatureValues(requested, codexFeatures)).toThrow(
      expect.objectContaining({ message: "Unknown feature: __proto__" }),
    );
  });

  it("returns no features without flags", () => {
    expect(parseFeatureFlags(undefined)).toEqual({});
  });

  it.each(["service_tier", "=priority", "service_tier=", " = "])("rejects %j", (flag) => {
    expect(() => parseFeatureFlags([flag])).toThrow(
      expect.objectContaining({ code: "INVALID_FEATURE" }),
    );
  });
});

describe("resolveFeatureValues", () => {
  it("converts toggles to booleans and keeps select option ids", () => {
    expect(
      resolveFeatureValues({ service_tier: "priority", plan_mode: "false" }, codexFeatures),
    ).toEqual({ service_tier: "priority", plan_mode: false });
  });

  it("names the valid options of a select", () => {
    expect(() => resolveFeatureValues({ service_tier: "fast" }, codexFeatures)).toThrow(
      expect.objectContaining({
        code: "INVALID_FEATURE",
        message: "Invalid value for feature service_tier: fast",
        details: "Use service_tier=default|priority",
      }),
    );
  });

  it("accepts only true or false for a toggle", () => {
    expect(() => resolveFeatureValues({ plan_mode: "yes" }, codexFeatures)).toThrow(
      expect.objectContaining({ details: "Use plan_mode=true|false" }),
    );
  });

  it("lists the available features for an unknown id", () => {
    expect(() => resolveFeatureValues({ fast_mode: "true" }, codexFeatures)).toThrow(
      expect.objectContaining({
        message: "Unknown feature: fast_mode",
        details: "Available features: service_tier=default|priority; plan_mode=true|false",
      }),
    );
  });

  it("says so when the provider and model expose no features", () => {
    expect(() => resolveFeatureValues({ service_tier: "priority" }, [])).toThrow(
      expect.objectContaining({ details: "This provider and model expose no features" }),
    );
  });
});

describe("formatFeatureValues", () => {
  it("lists current values and marks a missing list", () => {
    expect(formatFeatureValues(codexFeatures)).toBe("service_tier=default,plan_mode=false");
    expect(formatFeatureValues(undefined)).toBe("-");
  });
});
