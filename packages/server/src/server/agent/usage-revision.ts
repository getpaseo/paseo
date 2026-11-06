import { createHash } from "node:crypto";
import type { AgentUsageSession } from "./agent-sdk-types.js";

/** Public launch identity without exposing the provider's private session key or environment. */
export function usageRevision(session: AgentUsageSession | null): string | null {
  if (!session) return null;
  return createHash("sha256")
    .update(JSON.stringify([session.sessionKey, session.provider, session.model ?? null]))
    .digest("hex");
}
