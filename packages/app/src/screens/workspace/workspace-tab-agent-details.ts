import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { resolveAgentModelSelection } from "@/composer/agent-controls/utils";
import type { Agent } from "@/stores/session-store";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import { formatDuration } from "@/utils/time";

export interface WorkspaceTabAgentModel {
  cwd: string;
  provider: Agent["provider"];
  model: Agent["model"];
  thinkingOptionId: Agent["thinkingOptionId"];
  runtimeModel: string | null | undefined;
  runtimeThinkingOptionId: string | null | undefined;
  turnPhase: Agent["turn"]["phase"];
  turnStartedAtMs: number | null;
}

export interface WorkspaceTabAgentDetailsInput {
  agent:
    | Pick<Agent, "provider" | "model" | "runtimeInfo" | "thinkingOptionId" | "turn">
    | WorkspaceTabAgentModel;
  entries: Pick<ProviderSnapshotEntry, "provider" | "label" | "models">[] | undefined;
  now: number;
}

function isWorkspaceTabAgentModel(
  agent: WorkspaceTabAgentDetailsInput["agent"],
): agent is WorkspaceTabAgentModel {
  return "turnPhase" in agent;
}

function resolveAgentDetailsFields(agent: WorkspaceTabAgentDetailsInput["agent"]) {
  if (isWorkspaceTabAgentModel(agent)) {
    return {
      runtimeModelId: agent.runtimeModel,
      runtimeThinkingOptionId: agent.runtimeThinkingOptionId,
      turnPhase: agent.turnPhase,
      turnStartedAtMs: agent.turnStartedAtMs,
    };
  }
  const turn = agent.turn;
  return {
    runtimeModelId: agent.runtimeInfo?.model,
    runtimeThinkingOptionId: agent.runtimeInfo?.thinkingOptionId,
    turnPhase: turn.phase,
    turnStartedAtMs: turn.phase === "open" ? (turn.startedAt?.getTime() ?? null) : null,
  };
}

export function buildWorkspaceTabAgentDetails({
  agent,
  entries,
  now,
}: WorkspaceTabAgentDetailsInput): string {
  const provider = entries?.find((entry) => entry.provider === agent.provider);
  const parts = [provider?.label ?? agent.provider];
  const fields = resolveAgentDetailsFields(agent);
  const hasModel = Boolean(fields.runtimeModelId?.trim() || agent.model?.trim());
  if (hasModel) {
    const models = provider?.models ?? null;
    const selection = resolveAgentModelSelection({
      models,
      runtimeModelId: fields.runtimeModelId,
      configuredModelId: agent.model,
      runtimeThinkingOptionId: fields.runtimeThinkingOptionId,
      explicitThinkingOptionId: agent.thinkingOptionId,
    });
    parts.push(selection.displayModel);
    if (selection.selectedThinkingId) parts.push(selection.displayThinking);
  }
  if (fields.turnPhase === "open" && fields.turnStartedAtMs !== null) {
    parts.push(formatDuration(now - fields.turnStartedAtMs));
  }
  return parts.join(" · ");
}

const EMPTY_TAB_AGENTS = new Map<string, WorkspaceTabAgentModel>();

export function selectWorkspaceTabAgents(input: {
  agents: Map<string, Agent> | undefined;
  tabs: readonly WorkspaceTabDescriptor[];
}): ReadonlyMap<string, WorkspaceTabAgentModel> {
  if (!input.agents || input.tabs.length === 0) {
    return EMPTY_TAB_AGENTS;
  }
  let selected: Map<string, WorkspaceTabAgentModel> | null = null;
  for (const tab of input.tabs) {
    if (tab.target.kind !== "agent") continue;
    const agent = input.agents.get(tab.target.agentId);
    if (!agent) continue;
    selected ??= new Map<string, WorkspaceTabAgentModel>();
    const turn = agent.turn;
    selected.set(tab.key, {
      cwd: agent.cwd,
      provider: agent.provider,
      model: agent.model,
      thinkingOptionId: agent.thinkingOptionId,
      runtimeModel: agent.runtimeInfo?.model,
      runtimeThinkingOptionId: agent.runtimeInfo?.thinkingOptionId,
      turnPhase: turn.phase,
      turnStartedAtMs: turn.phase === "open" ? (turn.startedAt?.getTime() ?? null) : null,
    });
  }
  return selected ?? EMPTY_TAB_AGENTS;
}

function workspaceTabAgentModelEqual(
  a: WorkspaceTabAgentModel,
  b: WorkspaceTabAgentModel,
): boolean {
  return (
    a.cwd === b.cwd &&
    a.provider === b.provider &&
    a.model === b.model &&
    a.thinkingOptionId === b.thinkingOptionId &&
    a.runtimeModel === b.runtimeModel &&
    a.runtimeThinkingOptionId === b.runtimeThinkingOptionId &&
    a.turnPhase === b.turnPhase &&
    a.turnStartedAtMs === b.turnStartedAtMs
  );
}

export function workspaceTabAgentsEqual(
  a: ReadonlyMap<string, WorkspaceTabAgentModel>,
  b: ReadonlyMap<string, WorkspaceTabAgentModel>,
): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const [key, valueA] of a) {
    const valueB = b.get(key);
    if (!valueB || !workspaceTabAgentModelEqual(valueA, valueB)) {
      return false;
    }
  }
  return true;
}
