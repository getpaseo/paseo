import { describe, expect, test } from "vitest";

import { MutableDaemonConfigPatchSchema, MutableDaemonConfigSchema } from "./messages.js";
import { ProviderOverrideSchema, ProviderPaseoToolsPolicySchema } from "./provider-config.js";

describe("provider Paseo-tool policy", () => {
  test("accepts arbitrary tool IDs and leaves an empty policy enabled by default", () => {
    expect(
      ProviderPaseoToolsPolicySchema.parse({
        disabledTools: ["future_tool", "browser_future_tool"],
      }),
    ).toEqual({
      disabledTools: ["future_tool", "browser_future_tool"],
    });
    expect(ProviderPaseoToolsPolicySchema.parse({})).toEqual({});
    expect(ProviderOverrideSchema.parse({}).paseoTools).toBeUndefined();
  });

  test("accepts paseoTools on persisted provider overrides", () => {
    expect(
      ProviderOverrideSchema.parse({
        extends: "claude",
        paseoTools: {
          enabled: false,
          disabledTools: ["create_workspace"],
        },
      }).paseoTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["create_workspace"],
    });
  });

  test("accepts paseoTools when reading and patching mutable daemon providers", () => {
    expect(
      MutableDaemonConfigSchema.parse({
        mcp: { injectIntoAgents: true },
        providers: {
          codex: {
            paseoTools: { enabled: false, disabledTools: ["future_tool"] },
          },
        },
      }).providers.codex?.paseoTools,
    ).toEqual({
      enabled: false,
      disabledTools: ["future_tool"],
    });

    expect(
      MutableDaemonConfigPatchSchema.parse({
        providers: {
          codex: {
            paseoTools: { disabledTools: ["browser_future_tool"] },
          },
        },
      }).providers?.codex?.paseoTools,
    ).toEqual({ disabledTools: ["browser_future_tool"] });
  });
});
