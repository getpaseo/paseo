import type { DaemonServerInfo } from "@/stores/session-store";

export function resolveAgentPurposeSummary(input: {
  summary: string | null | undefined;
  serverInfo: DaemonServerInfo | null | undefined;
}): string | null {
  if (input.serverInfo?.features?.agentPurposeSummary !== true) {
    return null;
  }
  const summary = input.summary?.trim();
  return summary ? summary : null;
}
