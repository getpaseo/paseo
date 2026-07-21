import { isDelegatedAgent } from "@getpaseo/protocol/agent-labels";
import { isAgentContextAttachment, type UserComposerAttachment } from "@/attachments/types";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

export const MAX_AGENT_CONTEXT_ATTACHMENTS = 5;

export type AgentContextSourceGroupKind = "workspace" | "project" | "other";

export interface AgentContextSourceGroup {
  kind: AgentContextSourceGroupKind;
  agents: AggregatedAgent[];
}

export function getAgentContextSourceKey(source: Pick<AggregatedAgent, "serverId" | "id">): string {
  return `${source.serverId}:${source.id}`;
}

export { isAgentContextAttachment } from "@/attachments/types";

export function getAgentContextAttachmentKey(
  attachment: Extract<UserComposerAttachment, { kind: "agent_context" }>,
): string {
  return `${attachment.source.serverId}:${attachment.source.agentId}`;
}

export function getAgentContextSourceTitle(
  source: Pick<AggregatedAgent, "title" | "cwd" | "id">,
): string {
  return source.title?.trim() || source.cwd.trim() || source.id;
}

export function getAgentContextSourceWorkspaceLabel(
  source: Pick<AggregatedAgent, "projectPlacement" | "cwd">,
): string {
  return source.projectPlacement?.workspaceName?.trim() || source.cwd.trim();
}

export function buildAgentContextAttachment(
  source: AggregatedAgent,
): Extract<UserComposerAttachment, { kind: "agent_context" }> {
  const workspaceLabel = getAgentContextSourceWorkspaceLabel(source);
  return {
    kind: "agent_context",
    source: {
      serverId: source.serverId,
      agentId: source.id,
      title: getAgentContextSourceTitle(source),
      ...(workspaceLabel ? { workspaceLabel } : {}),
      ...(source.provider?.trim() ? { provider: source.provider } : {}),
    },
  };
}

/**
 * `@` search has only lightweight display metadata, unlike the picker which
 * holds a full directory entry. Keep the persisted attachment shape identical
 * regardless of which surface selected it.
 */
export function buildAgentContextAttachmentFromMetadata(input: {
  serverId: string;
  agentId: string;
  title: string;
  provider?: string | null;
  workspaceLabel?: string | null;
}): Extract<UserComposerAttachment, { kind: "agent_context" }> {
  return {
    kind: "agent_context",
    source: {
      serverId: input.serverId,
      agentId: input.agentId,
      title: input.title,
      ...(input.workspaceLabel?.trim() ? { workspaceLabel: input.workspaceLabel } : {}),
      ...(input.provider?.trim() ? { provider: input.provider } : {}),
    },
  };
}

function appendAgentContextAttachment(
  current: readonly UserComposerAttachment[],
  attachment: Extract<UserComposerAttachment, { kind: "agent_context" }>,
): UserComposerAttachment[] {
  const key = getAgentContextAttachmentKey(attachment);
  const existing = current.filter(isAgentContextAttachment);
  if (existing.some((entry) => getAgentContextAttachmentKey(entry) === key)) {
    return current.map((entry) =>
      isAgentContextAttachment(entry) && getAgentContextAttachmentKey(entry) === key
        ? attachment
        : entry,
    );
  }
  if (existing.length >= MAX_AGENT_CONTEXT_ATTACHMENTS) {
    return [...current];
  }
  return [...current, attachment];
}

export function appendAgentContextAttachmentFromPicker(input: {
  current: readonly UserComposerAttachment[];
  source: AggregatedAgent;
}): UserComposerAttachment[] {
  return appendAgentContextAttachment(input.current, buildAgentContextAttachment(input.source));
}

export function appendAgentContextAttachmentFromMention(input: {
  current: readonly UserComposerAttachment[];
  source: {
    serverId: string;
    agentId: string;
    title: string;
    provider?: string | null;
  };
}): UserComposerAttachment[] {
  return appendAgentContextAttachment(
    input.current,
    buildAgentContextAttachmentFromMetadata(input.source),
  );
}

function searchableText(source: AggregatedAgent): string {
  return [
    source.title,
    source.cwd,
    source.provider,
    source.projectPlacement?.workspaceName,
    source.projectPlacement?.projectName,
  ]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLocaleLowerCase();
}

function matchesQuery(source: AggregatedAgent, query: string): boolean {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized.length === 0 || searchableText(source).includes(normalized);
}

function compareByActivity(left: AggregatedAgent, right: AggregatedAgent): number {
  return right.lastActivityAt.getTime() - left.lastActivityAt.getTime();
}

/**
 * Agent references are resolved by the destination daemon, so sources must
 * belong to that daemon. The picker deliberately does not infer cross-host
 * eligibility from checkout paths or git remotes.
 */
export function buildAgentContextSourceGroups(input: {
  agents: readonly AggregatedAgent[];
  serverId: string;
  workspaceId?: string | null;
  projectKey?: string | null;
  currentAgentId?: string | null;
  query: string;
}): AgentContextSourceGroup[] {
  const workspace: AggregatedAgent[] = [];
  const project: AggregatedAgent[] = [];
  const other: AggregatedAgent[] = [];
  const seen = new Set<string>();
  const currentProjectKey =
    input.projectKey ??
    input.agents.find(
      (agent) =>
        agent.serverId === input.serverId &&
        agent.workspaceId === input.workspaceId &&
        agent.id === input.currentAgentId,
    )?.projectPlacement?.projectKey;

  for (const source of input.agents) {
    const key = getAgentContextSourceKey(source);
    if (
      source.serverId !== input.serverId ||
      source.archivedAt ||
      source.id === input.currentAgentId ||
      isDelegatedAgent(source) ||
      seen.has(key) ||
      !matchesQuery(source, input.query)
    ) {
      continue;
    }
    seen.add(key);

    if (input.workspaceId && source.workspaceId === input.workspaceId) {
      workspace.push(source);
      continue;
    }
    if (currentProjectKey && source.projectPlacement?.projectKey === currentProjectKey) {
      project.push(source);
      continue;
    }
    other.push(source);
  }

  return [
    { kind: "workspace" as const, agents: workspace },
    { kind: "project" as const, agents: project },
    { kind: "other" as const, agents: other },
  ]
    .filter((group) => group.agents.length > 0)
    .map((group) => ({
      kind: group.kind,
      agents: group.agents.toSorted(compareByActivity),
    }));
}
