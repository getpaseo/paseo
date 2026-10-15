import { describe, expect, it } from "vitest";
import { assertPluginCompatibility, validatePluginRequirements } from "./plugin-requirements.js";

describe.each(["daemon", "app"] as const)("plugin requirements on %s", (runtime) => {
  it.each([
    [undefined, "0.7.2"],
    [undefined, "unknown"],
    [undefined, null],
    ["^0.8.0", "0.11.1"],
    [">=99.0.0", "0.11.1"],
    [">=99.0.0-beta.1", "0.11.1"],
    [">=0.8.0", "0.8.0"],
    [">=0.8.0", "0.8.0-beta.1"],
    [">=0.8.0", "1.0.0"],
    ["^0.8.0", "0.8.4"],
    [">=0.8.0-beta.1", "0.8.0-beta.2"],
    [">=0.8.0-beta.1", "0.8.0-beta.1"],
    [">=0.8.0-beta.1", "0.8.0"],
    ["^0.8.0 || ^0.9.0", "0.9.2+build.42"],
  ])("accepts %s on %s", (paseo, version) => {
    expect(() =>
      assertPluginCompatibility({ id: "test", requirements: { paseo }, version, runtime }),
    ).not.toThrow();
  });

  it.each(["", "   ", "latest", ">=potato", "0.8.0 nonsense"])(
    "rejects malformed range %s",
    (paseo) => {
      expect(() => validatePluginRequirements({ paseo })).toThrow("Invalid requirements.paseo");
    },
  );
});
