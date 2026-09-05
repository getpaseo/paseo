import type { AgentPlanUsageWindow } from "@getpaseo/protocol/agent-types";
import { providerUsageCopy } from "./copy";
import type { ProviderUsage, ProviderUsageWindow } from "./types";

export interface AgentPlanUsageInput {
  /** The agent's provider id, which is also the id of its provider-usage entry. */
  providerId: string | null | undefined;
  /** The provider-level usage entry for the same id, when the daemon has one. */
  providerUsage: ProviderUsage | null;
  planWindows: AgentPlanUsageWindow[] | null | undefined;
  observedAt: string | null | undefined;
}

// Usage observed from the agent's own traffic wins over the provider-level
// fetch: it describes exactly the account the agent bills to, it is as fresh as
// the agent's last API call, and it carries per-model windows the provider
// fetch cannot see for pinned accounts. The provider entry still contributes
// the display name and plan label, which the agent's stream does not carry.
export function buildAgentPlanUsage(input: AgentPlanUsageInput): ProviderUsage | null {
  const windows = input.planWindows ?? [];
  if (!input.providerId || windows.length === 0) return null;
  return {
    providerId: input.providerId,
    displayName: input.providerUsage?.displayName ?? input.providerId,
    status: "available",
    planLabel: input.providerUsage?.planLabel ?? null,
    sourceLabel: providerUsageCopy.observedFromAgent,
    fetchedAt: input.observedAt ?? null,
    windows: windows.map((window) => {
      const converted: ProviderUsageWindow = {
        id: window.id,
        label: window.label,
        usedPct: window.usedPct,
        remainingPct: Math.max(0, 100 - window.usedPct),
        resetsAt: window.resetsAt ?? null,
      };
      if (window.tone) converted.tone = window.tone;
      return converted;
    }),
    balances: [],
    details: [],
    error: null,
  };
}
