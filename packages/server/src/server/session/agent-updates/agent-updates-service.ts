import type pino from "pino";
import type {
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  SessionInboundMessage,
  SessionOutboundMessage,
} from "../../messages.js";
import type { ManagedAgent } from "../../agent/agent-manager.js";
import type { StoredAgentRecord } from "../../agent/agent-storage.js";
import { resolveEffectiveThinkingOptionId } from "../../agent/agent-projections.js";

type AgentUpdatePayload = Extract<SessionOutboundMessage, { type: "agent_update" }>["payload"];
type AgentUpdatesFilter = NonNullable<
  Extract<SessionInboundMessage, { type: "fetch_agents_request" }>["filter"]
>;

interface AgentUpdatesSubscriptionState {
  subscriptionId: string;
  filter?: AgentUpdatesFilter;
  isBootstrapping: boolean;
  pendingUpdatesByAgentId: Map<string, AgentUpdatePayload>;
}

/**
 * Owns the single per-client `agent_update` subscription: when a client subscribes
 * via `fetch_agents_request`, every later agent lifecycle change (live forward,
 * stored-record archive/detach, delete) is filtered against the subscription's
 * filter and either emitted or — while the initial snapshot is still being built —
 * buffered and replayed on flush. Keeping the mutable subscription state, the
 * bootstrap buffer, the provider-visibility gate, and the filter predicate behind
 * one interface stops the rest of session.ts from poking the subscription shape or
 * hand-rolling `agent_update` payloads, and the (previously untested) filter/buffer/
 * flush branches become exercisable through injected fakes.
 *
 * The snapshot listing path applies the SAME filter via the pure
 * `matchesAgentUpdatesFilter` so a subscription's initial page and its live updates
 * stay consistent.
 */
export interface AgentUpdatesService {
  beginSubscription(input: { subscriptionId: string; filter?: AgentUpdatesFilter }): void;
  flushBootstrapped(
    subscriptionId: string,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): void;
  clearSubscription(subscriptionId: string): void;
  hasSubscription(): boolean;
  forwardLiveAgent(agent: ManagedAgent): Promise<void>;
  emitStoredRecord(record: StoredAgentRecord): Promise<AgentSnapshotPayload>;
  removeAgent(agentId: string): void;
  dispose(): void;
}

export interface AgentUpdatesServiceDeps {
  emit(message: SessionOutboundMessage): void;
  buildAgentPayload(agent: ManagedAgent): Promise<AgentSnapshotPayload>;
  buildStoredAgentPayload(record: StoredAgentRecord): AgentSnapshotPayload;
  isProviderVisibleToClient(provider: string): boolean;
  buildProjectPlacementForWorkspaceId(workspaceId: string): Promise<ProjectPlacementPayload | null>;
  emitWorkspaceUpdateForWorkspaceId(workspaceId: string): Promise<void>;
  logger: pino.Logger;
}

function agentThinkingOptionMatchesFilter(
  agent: AgentSnapshotPayload,
  filter: AgentUpdatesFilter,
): boolean {
  if (filter.thinkingOptionId === undefined) {
    return true;
  }
  const expectedThinkingOptionId = resolveEffectiveThinkingOptionId({
    configuredThinkingOptionId: filter.thinkingOptionId ?? null,
  });
  const resolvedThinkingOptionId =
    agent.effectiveThinkingOptionId ??
    resolveEffectiveThinkingOptionId({
      runtimeInfo: agent.runtimeInfo,
      configuredThinkingOptionId: agent.thinkingOptionId ?? null,
    });
  return resolvedThinkingOptionId === expectedThinkingOptionId;
}

function matchesAgentStructuralFilter(
  agent: AgentSnapshotPayload,
  project: ProjectPlacementPayload,
  filter: AgentUpdatesFilter,
): boolean {
  if (filter.statuses && filter.statuses.length > 0) {
    const statuses = new Set(filter.statuses);
    if (!statuses.has(agent.status)) {
      return false;
    }
  }

  if (typeof filter.requiresAttention === "boolean") {
    const requiresAttention = agent.requiresAttention ?? false;
    if (requiresAttention !== filter.requiresAttention) {
      return false;
    }
  }

  if (filter.projectKeys && filter.projectKeys.length > 0) {
    const projectKeys = new Set(filter.projectKeys.filter((item) => item.trim().length > 0));
    if (projectKeys.size > 0 && !projectKeys.has(project.projectKey)) {
      return false;
    }
  }
  return true;
}

/**
 * Pure predicate shared by the live subscription stream and the snapshot listing
 * pager: does an agent (with its resolved project placement) satisfy a
 * `fetch_agents` filter?
 */
export function matchesAgentUpdatesFilter(input: {
  agent: AgentSnapshotPayload;
  project: ProjectPlacementPayload;
  filter?: AgentUpdatesFilter;
}): boolean {
  const { agent, project, filter } = input;

  if (filter?.labels) {
    const matchesLabels = Object.entries(filter.labels).every(
      ([key, value]) => agent.labels[key] === value,
    );
    if (!matchesLabels) {
      return false;
    }
  }

  const includeArchived = filter?.includeArchived ?? false;
  if (!includeArchived && agent.archivedAt) {
    return false;
  }

  if (filter && !agentThinkingOptionMatchesFilter(agent, filter)) {
    return false;
  }

  if (filter && !matchesAgentStructuralFilter(agent, project, filter)) {
    return false;
  }

  return true;
}

function agentUpdateTargetId(update: AgentUpdatePayload): string {
  return update.kind === "remove" ? update.agentId : update.agent.id;
}

export function createAgentUpdatesService(deps: AgentUpdatesServiceDeps): AgentUpdatesService {
  let subscription: AgentUpdatesSubscriptionState | null = null;

  function bufferOrEmit(sub: AgentUpdatesSubscriptionState, payload: AgentUpdatePayload): void {
    if (payload.kind === "upsert" && !deps.isProviderVisibleToClient(payload.agent.provider)) {
      return;
    }
    if (sub.isBootstrapping) {
      sub.pendingUpdatesByAgentId.set(agentUpdateTargetId(payload), payload);
      return;
    }

    deps.emit({
      type: "agent_update",
      payload,
    });
  }

  function beginSubscription(input: { subscriptionId: string; filter?: AgentUpdatesFilter }): void {
    subscription = {
      subscriptionId: input.subscriptionId,
      filter: input.filter,
      isBootstrapping: true,
      pendingUpdatesByAgentId: new Map(),
    };
  }

  function flushBootstrapped(
    subscriptionId: string,
    options?: { snapshotUpdatedAtByAgentId?: Map<string, number> },
  ): void {
    if (!subscription || subscription.subscriptionId !== subscriptionId) {
      return;
    }
    if (!subscription.isBootstrapping) {
      return;
    }

    subscription.isBootstrapping = false;
    const pending = Array.from(subscription.pendingUpdatesByAgentId.values());
    subscription.pendingUpdatesByAgentId.clear();

    for (const payload of pending) {
      if (payload.kind === "upsert") {
        const snapshotUpdatedAt = options?.snapshotUpdatedAtByAgentId?.get(payload.agent.id);
        if (typeof snapshotUpdatedAt === "number") {
          const updateUpdatedAt = Date.parse(payload.agent.updatedAt);
          if (!Number.isNaN(updateUpdatedAt) && updateUpdatedAt <= snapshotUpdatedAt) {
            continue;
          }
        }
      }

      deps.emit({
        type: "agent_update",
        payload,
      });
    }
  }

  function clearSubscription(subscriptionId: string): void {
    if (subscription && subscription.subscriptionId === subscriptionId) {
      subscription = null;
    }
  }

  function hasSubscription(): boolean {
    return subscription !== null;
  }

  function removeAgent(agentId: string): void {
    if (!subscription) {
      return;
    }
    bufferOrEmit(subscription, { kind: "remove", agentId });
  }

  async function emitStoredRecord(record: StoredAgentRecord): Promise<AgentSnapshotPayload> {
    const payload = deps.buildStoredAgentPayload(record);
    const sub = subscription;
    if (!sub) {
      return payload;
    }

    const project = payload.workspaceId
      ? await deps.buildProjectPlacementForWorkspaceId(payload.workspaceId)
      : null;
    if (!project) {
      bufferOrEmit(sub, {
        kind: "remove",
        agentId: payload.id,
      });
      return payload;
    }

    const matches = matchesAgentUpdatesFilter({
      agent: payload,
      project,
      filter: sub.filter,
    });
    bufferOrEmit(
      sub,
      matches
        ? {
            kind: "upsert",
            agent: payload,
            project,
          }
        : {
            kind: "remove",
            agentId: payload.id,
          },
    );
    return payload;
  }

  async function forwardLiveAgent(agent: ManagedAgent): Promise<void> {
    try {
      const sub = subscription;
      const payload = await deps.buildAgentPayload(agent);
      if (sub) {
        const project = payload.workspaceId
          ? await deps.buildProjectPlacementForWorkspaceId(payload.workspaceId)
          : null;
        if (!project) {
          bufferOrEmit(sub, {
            kind: "remove",
            agentId: payload.id,
          });
        } else {
          const matches = matchesAgentUpdatesFilter({
            agent: payload,
            project,
            filter: sub.filter,
          });

          if (matches) {
            bufferOrEmit(sub, {
              kind: "upsert",
              agent: payload,
              project,
            });
          } else {
            bufferOrEmit(sub, {
              kind: "remove",
              agentId: payload.id,
            });
          }
        }
      }

      // A lifecycle change updates exactly the agent's owning workspace, never
      // every workspace sharing its cwd. Ownership is the agent's workspaceId.
      if (payload.workspaceId) {
        await deps.emitWorkspaceUpdateForWorkspaceId(payload.workspaceId);
      }
    } catch (error) {
      deps.logger.error({ err: error }, "Failed to emit agent update");
    }
  }

  function dispose(): void {
    subscription = null;
  }

  return {
    beginSubscription,
    flushBootstrapped,
    clearSubscription,
    hasSubscription,
    forwardLiveAgent,
    emitStoredRecord,
    removeAgent,
    dispose,
  };
}
