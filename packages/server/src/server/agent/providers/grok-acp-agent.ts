import type { SessionNotification, UsageUpdate } from "@agentclientprotocol/sdk";

import type { AvailableACPModel } from "./acp-agent.js";
import { GenericACPAgentClient, type GenericACPAgentClientOptions } from "./generic-acp-agent.js";

export function resolveGrokContextUsage(
  notification: SessionNotification,
  model: AvailableACPModel | null,
): UsageUpdate | undefined {
  // Grok publishes occupancy on notifications and capacity on the selected model,
  // rather than sending ACP's standard usage_update.
  const used = notification._meta?.["totalTokens"];
  const size = model?._meta?.["totalContextTokens"];
  const validUsed = typeof used === "number" && Number.isFinite(used) && used >= 0;
  const validSize = typeof size === "number" && Number.isFinite(size) && size > 0;
  if (!validUsed || !validSize) {
    return undefined;
  }
  return { used, size };
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  constructor(options: GenericACPAgentClientOptions) {
    super({ ...options, sessionUsageResolver: resolveGrokContextUsage });
  }
}
