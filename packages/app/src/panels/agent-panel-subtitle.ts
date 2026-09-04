import {
  formatAgentModelDisplayMeta,
  type AgentModelDisplay,
} from "@/composer/agent-controls/utils";
import type { Agent } from "@/stores/session-store";

function formatProviderLabel(provider: Agent["provider"]): string {
  if (!provider) {
    return "Agent";
  }
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * "Claude · Opus 4.5 · High" once the agent reports what it is running, falling
 * back to "Claude agent" while the model and thinking level are still unknown.
 */
export function buildAgentPanelSubtitle(
  provider: Agent["provider"],
  modelDisplay: AgentModelDisplay,
): string {
  const providerLabel = formatProviderLabel(provider);
  const meta = formatAgentModelDisplayMeta(modelDisplay);
  return meta ? `${providerLabel} · ${meta}` : `${providerLabel} agent`;
}
