import { describe, expect, it } from "vitest";
import { resolvePluginPageState } from "./plugins-page-state";

describe("resolvePluginPageState", () => {
  it.each([
    ["offline", false, false, false, false, 0],
    ["unsupported", true, false, false, false, 0],
    ["loading", true, true, true, false, 0],
    ["error", true, true, false, true, 0],
    ["empty", true, true, false, false, 0],
    ["ready", true, true, false, false, 1],
  ] as const)("resolves %s", (expected, connected, supported, loading, error, pluginCount) => {
    expect(resolvePluginPageState({ connected, supported, loading, error, pluginCount })).toBe(
      expected,
    );
  });
});
