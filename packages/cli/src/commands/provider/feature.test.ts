import { describe, expect, it } from "vitest";
import type { ServerInfoStatusPayload } from "@getpaseo/protocol/messages";

import { requirePaseoAgentCatalogFeature } from "./feature.js";

function createServerInfo(features: ServerInfoStatusPayload["features"]): ServerInfoStatusPayload {
  return {
    status: "server_info",
    serverId: "test-daemon",
    features,
  };
}

describe("provider feature gate", () => {
  it("waits for delayed server_info before allowing catalog commands", async () => {
    let resolveServerInfo: ((serverInfo: ServerInfoStatusPayload) => void) | null = null;

    const allowed = requirePaseoAgentCatalogFeature({
      waitForServerInfo: async () =>
        new Promise<ServerInfoStatusPayload>((resolve) => {
          resolveServerInfo = resolve;
        }),
    });

    expect(resolveServerInfo).not.toBeNull();
    resolveServerInfo?.(createServerInfo({ paseoAgentCatalog: true }));

    await expect(allowed).resolves.toBeUndefined();
  });

  it("surfaces the server_info wait timeout", async () => {
    const timeoutError = new Error("Timed out waiting for server_info status message (5ms)");

    await expect(
      requirePaseoAgentCatalogFeature({
        waitForServerInfo: async () => {
          throw timeoutError;
        },
      }),
    ).rejects.toThrow("Timed out waiting for server_info status message (5ms)");
  });

  it("requires the catalog feature when server_info arrives without it", async () => {
    await expect(
      requirePaseoAgentCatalogFeature({
        waitForServerInfo: async () => createServerInfo({ paseoAgentCatalog: false }),
      }),
    ).rejects.toMatchObject({
      code: "HOST_UPDATE_REQUIRED",
      message: "Update the Paseo daemon to use this command.",
    });
  });
});
