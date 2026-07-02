import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { CommandError } from "../../output/index.js";

export interface PaseoAgentCatalogFeatureClient extends Pick<DaemonClient, "waitForServerInfo"> {}

export async function requirePaseoAgentCatalogFeature(
  client: PaseoAgentCatalogFeatureClient,
): Promise<void> {
  const serverInfo = await client.waitForServerInfo();
  if (serverInfo.features?.paseoAgentCatalog === true) {
    return;
  }
  throw {
    code: "HOST_UPDATE_REQUIRED",
    message: "Update the Paseo daemon to use this command.",
  } satisfies CommandError;
}
