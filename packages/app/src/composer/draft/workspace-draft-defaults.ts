import { useRef } from "react";
import { useSessionStore, type Agent, type SessionState } from "@/stores/session-store";
import type { CreateAgentInitialValues } from "@/hooks/use-agent-form-state";

/**
 * New tabs in an existing workspace default to the workspace's own most recent
 * top-level agent instead of the device-global "last selected model"
 * preference.
 *
 * The global preference is keyed by provider only, so switching between hosts
 * (servers) with different model catalogs resolves to nothing and the composer
 * falls back to the provider's advertised default model — forcing a manual
 * re-pick in every window. A workspace belongs to exactly one host, so
 * remembering per workspace also remembers per host.
 *
 * Subagents are skipped: they run picker-internal models (classifiers, quick
 * lookups) that should not become the default for new tabs.
 */

const FIELD_SEPARATOR = "\u0000";

interface WorkspaceLastAgentConfig {
  provider: string;
  model: string;
  modeId: string;
  thinkingOptionId: string;
}

export function selectWorkspaceLastAgentConfig(input: {
  session: Pick<SessionState, "agents" | "hasHydratedAgents"> | null | undefined;
  workspaceId: string;
}): WorkspaceLastAgentConfig | null {
  const session = input.session;
  const agents = session?.agents;
  if (!session || !agents || agents.size === 0) return null;
  // A partially hydrated directory (replica-cache restore lands before the
  // agents_list fetch) must not pin the latch: `hasHydratedAgents` flips only
  // when the full directory has been fetched, so wait for it.
  if (!session.hasHydratedAgents) return null;
  const workspaceKey = input.workspaceId.trim();
  let best: Agent | null = null;
  let bestCreatedAt = -1;
  for (const agent of agents.values()) {
    if (!agent || agent.parentAgentId) continue;
    if (!agent.provider || !agent.model) continue;
    if ((agent.workspaceId ?? "").trim() !== workspaceKey) continue;
    const createdAt = agent.createdAt ? agent.createdAt.getTime() : 0;
    if (Number.isNaN(createdAt)) continue;
    if (createdAt >= bestCreatedAt) {
      bestCreatedAt = createdAt;
      best = agent;
    }
  }
  if (!best || !best.provider || !best.model) return null;
  return {
    provider: best.provider,
    model: best.model,
    modeId: best.currentModeId ?? "",
    thinkingOptionId: best.thinkingOptionId ?? "",
  };
}

export function serializeWorkspaceLastAgentConfig(
  config: WorkspaceLastAgentConfig | null,
): string {
  if (!config) return "";
  return [
    config.provider,
    config.model,
    config.modeId,
    config.thinkingOptionId,
  ].join(FIELD_SEPARATOR);
}

export function parseWorkspaceLastAgentConfig(serialized: string): WorkspaceLastAgentConfig | null {
  if (!serialized) return null;
  const [provider, model, modeId, thinkingOptionId] = serialized.split(FIELD_SEPARATOR);
  if (!provider || !model) return null;
  return {
    provider,
    model,
    modeId: modeId ?? "",
    thinkingOptionId: thinkingOptionId ?? "",
  };
}

export function toCreateAgentInitialValues(
  config: WorkspaceLastAgentConfig | null,
): CreateAgentInitialValues | undefined {
  if (!config) return undefined;
  return {
    provider: config.provider,
    modeId: config.modeId || null,
    model: config.model,
    thinkingOptionId: config.thinkingOptionId || null,
  };
}

export function useWorkspaceLastAgentInitialValues(
  serverId: string,
  workspaceId: string,
): CreateAgentInitialValues | undefined {
  // A primitive selector result keeps re-renders scoped to actual config
  // changes; the config fields survive as a joined string.
  const serialized = useSessionStore((state) =>
    serializeWorkspaceLastAgentConfig(
      selectWorkspaceLastAgentConfig({
        session: state.sessions[serverId],
        workspaceId,
      }),
    ),
  );

  // Latch the first non-empty config for the lifetime of this draft. Form
  // resolution treats an initialValues change as a reset of the user's manual
  // picker edits, so a later agent (heartbeat, `paseo run`) must not move the
  // goalposts while the composer is open. The zustand hook above still runs on
  // every render to keep hook order stable.
  const latched = useRef<WorkspaceLastAgentConfig | null>(null);
  if (!latched.current && serialized) {
    latched.current = parseWorkspaceLastAgentConfig(serialized);
  }
  return toCreateAgentInitialValues(latched.current);
}
