import { z } from "zod";
import type { Agent } from "@/stores/session-store";
import { assistantAgentName } from "./assistant-catalog";
import {
  ASSISTANT_MESSAGE_DEFAULT_LIMIT,
  ASSISTANT_MESSAGE_MAX_LIMIT,
  assistantNoticeRow,
  buildAssistantMessageRows,
  mergeAssistantMessageRows,
  type AssistantMessageRow,
  type AssistantTimelineEntry,
} from "./assistant-messages";

const MAX_FAN_OUT = 6;

const AssistantQueryRequestSchema = z.object({
  requestId: z.string().min(1),
  serverId: z.string().min(1).nullish(),
  agentId: z.string().min(1).nullish(),
  workspaceId: z.string().min(1).nullish(),
  limit: z.number().int().min(1).max(ASSISTANT_MESSAGE_MAX_LIMIT).nullish(),
});

export interface AssistantQueryRequest {
  requestId: string;
  serverId?: string | null;
  agentId: string | null;
  workspaceId: string | null;
  limit: number;
}

export interface AssistantQueryHost {
  serverId: string;
  label: string;
  connected: boolean;
  workspaceIds: ReadonlySet<string>;
  agents: readonly Agent[];
}

export interface AssistantQueryTarget {
  serverId: string;
  agentId: string;
  agentName: string;
  workspaceId: string | null;
}

/** Validates what the native side handed over; anything malformed is dropped whole. */
export function parseAssistantQueryRequest(raw: unknown): AssistantQueryRequest | null {
  const result = AssistantQueryRequestSchema.safeParse(raw);
  if (!result.success) {
    return null;
  }
  const agentId = result.data.agentId ?? null;
  const workspaceId = agentId ? null : (result.data.workspaceId ?? null);
  if (!agentId && !workspaceId) {
    return null;
  }
  return {
    requestId: result.data.requestId,
    serverId: result.data.serverId ?? null,
    agentId,
    workspaceId,
    limit: result.data.limit ?? ASSISTANT_MESSAGE_DEFAULT_LIMIT,
  };
}

function targetFor(host: AssistantQueryHost, agent: Agent): AssistantQueryTarget {
  return {
    serverId: host.serverId,
    agentId: agent.id,
    agentName: assistantAgentName(agent),
    workspaceId: agent.workspaceId ?? null,
  };
}

function offlineNotice(hosts: readonly AssistantQueryHost[]): string {
  const labels = hosts.map((host) => host.label).join(", ");
  return `Host ${labels} is offline, so Paseo cannot read the conversation; reconnect and ask again.`;
}

/**
 * Which agents answer this query. A workspace fans out over its non-archived
 * top-level agents on every host that owns it; an explicit agent id wins and
 * names exactly one.
 */
export function resolveAssistantQueryTargets(
  request: AssistantQueryRequest,
  hosts: readonly AssistantQueryHost[],
): { targets: AssistantQueryTarget[]; notice: string | null } {
  const scopedHosts = request.serverId
    ? hosts.filter((host) => host.serverId === request.serverId)
    : hosts;
  const agentId = request.agentId;
  if (agentId) {
    const owners = scopedHosts.filter((host) => host.agents.some((agent) => agent.id === agentId));
    if (owners.length === 0) {
      return {
        targets: [],
        notice: "Paseo does not know that agent; ask it to list agents again.",
      };
    }
    const online = owners.filter((host) => host.connected);
    if (online.length === 0) {
      return { targets: [], notice: offlineNotice(owners) };
    }
    const host = online[0];
    const agent = host.agents.find((candidate) => candidate.id === agentId);
    return { targets: agent ? [targetFor(host, agent)] : [], notice: null };
  }

  const workspaceId = request.workspaceId;
  const owners = scopedHosts.filter(
    (host) => workspaceId !== null && host.workspaceIds.has(workspaceId),
  );
  if (owners.length === 0) {
    return {
      targets: [],
      notice: "Paseo does not know that workspace; ask it to list workspaces again.",
    };
  }
  const online = owners.filter((host) => host.connected);
  if (online.length === 0) {
    return { targets: [], notice: offlineNotice(owners) };
  }
  const candidates = online.flatMap((host) =>
    host.agents
      .filter(
        (agent) => agent.workspaceId === workspaceId && !agent.archivedAt && !agent.parentAgentId,
      )
      .map((agent) => ({ host, agent })),
  );
  candidates.sort((a, b) => b.agent.lastActivityAt.getTime() - a.agent.lastActivityAt.getTime());
  return {
    targets: candidates.slice(0, MAX_FAN_OUT).map(({ host, agent }) => targetFor(host, agent)),
    notice: null,
  };
}

export type AssistantQueryFetch = (
  target: AssistantQueryTarget,
  limit: number,
) => Promise<readonly AssistantTimelineEntry[]>;

/**
 * Answers one provider query. Everything that keeps the rows from arriving
 * becomes a single notice row the assistant can read out loud, because the
 * caller has no way to act on a failure.
 */
export async function runAssistantQuery(input: {
  request: AssistantQueryRequest;
  hosts: readonly AssistantQueryHost[];
  fetchEntries: AssistantQueryFetch;
}): Promise<AssistantMessageRow[]> {
  const { request } = input;
  const notice = (text: string) =>
    assistantNoticeRow({
      text,
      serverId: request.serverId,
      agentId: request.agentId,
      workspaceId: request.workspaceId,
    });

  const resolved = resolveAssistantQueryTargets(request, input.hosts);
  if (resolved.notice) {
    return [notice(resolved.notice)];
  }
  if (resolved.targets.length === 0) {
    return [];
  }

  const groups = await Promise.all(
    resolved.targets.map(async (target) => {
      try {
        const entries = await input.fetchEntries(target, request.limit);
        return buildAssistantMessageRows(target, entries, request.limit);
      } catch {
        return null;
      }
    }),
  );
  const fetched = groups.filter((group): group is AssistantMessageRow[] => group !== null);
  if (fetched.length === 0) {
    return [notice("Paseo could not read that conversation from the host; try again in a moment.")];
  }
  return mergeAssistantMessageRows(fetched, request.limit);
}
