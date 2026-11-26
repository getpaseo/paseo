import { describe, expect, test, vi } from "vitest";
import type { PluginHookContext } from "@getpaseo/plugin/server";
import { readProviderEnv } from "./provider-env.js";

function hookContext(providers: Record<string, unknown>): PluginHookContext {
  return {
    paseo: {
      config: {
        get: vi.fn(async () => ({ requestId: "r1", config: { providers } })),
      },
    },
    signal: new AbortController().signal,
  } as unknown as PluginHookContext;
}

describe("provider environment", () => {
  test("reads the environment the user configured for the provider", async () => {
    const context = hookContext({
      "glm-acp-agent": { env: { Z_AI_API_KEY: "configured_key" } },
    });

    await expect(readProviderEnv(context, "glm-acp-agent")).resolves.toEqual({
      Z_AI_API_KEY: "configured_key",
    });
  });

  test("reports nothing for a provider the user did not configure", async () => {
    const context = hookContext({});

    await expect(readProviderEnv(context, "glm-acp-agent")).resolves.toBeUndefined();
  });

  test("reports nothing when the daemon does not answer the config request", async () => {
    const context = {
      paseo: {
        config: {
          get: vi.fn(async () => {
            throw new Error("daemon.read is not permitted");
          }),
        },
      },
      signal: new AbortController().signal,
    } as unknown as PluginHookContext;

    await expect(readProviderEnv(context, "glm-acp-agent")).resolves.toBeUndefined();
  });
});
