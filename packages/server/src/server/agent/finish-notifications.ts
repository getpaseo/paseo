import { getParentAgentIdFromLabels } from "@getpaseo/protocol/agent-labels";
import type { Logger } from "pino";

import type { AgentPermissionRequest } from "./agent-sdk-types.js";
import type { AgentManager, AgentManagerEvent, ManagedAgent } from "./agent-manager.js";

export type FinishNotificationReason = "finished" | "errored" | "needs permission" | "was closed";

export interface FinishNotificationDelivery {
  reason: FinishNotificationReason;
  permissionRequest?: AgentPermissionRequest;
}

export interface WatchAgentFinishParams {
  agentManager: AgentManager;
  childAgentId: string;
  callerAgentId: string;
  requireParentOwnership?: boolean;
  deliver(delivery: FinishNotificationDelivery): Promise<void>;
  logger: Logger;
}

interface FinishWatcher extends WatchAgentFinishParams {
  hasSeenRunning: boolean;
  terminalReason: "errored" | "was closed" | null;
  notifiedPermissionRequestIds: Set<string>;
  deliveryTail: Promise<void>;
}

interface FinishCoordinator {
  agentManager: AgentManager;
  watchers: Set<FinishWatcher>;
  pendingDeliveries: Map<string, number>;
  unsubscribe: (() => void) | null;
  evaluationScheduled: boolean;
}

const coordinators = new WeakMap<AgentManager, FinishCoordinator>();

export function watchAgentFinish(params: WatchAgentFinishParams): void {
  const snapshot = params.agentManager.getAgent(params.childAgentId);
  if (snapshot?.lifecycle === "closed") {
    return;
  }
  if (
    snapshot &&
    params.requireParentOwnership &&
    getParentAgentIdFromLabels(snapshot.labels) !== params.callerAgentId
  ) {
    return;
  }

  const coordinator = getCoordinator(params.agentManager);
  const hasSeenRunning =
    snapshot?.lifecycle === "running" && snapshot.pendingPermissions.size === 0;
  coordinator.watchers.add({
    ...params,
    hasSeenRunning,
    terminalReason: snapshot?.lifecycle === "error" ? "errored" : null,
    notifiedPermissionRequestIds: new Set(),
    deliveryTail: Promise.resolve(),
  });
  refreshSubscription(coordinator);
  scheduleEvaluation(coordinator);
}

function getCoordinator(agentManager: AgentManager): FinishCoordinator {
  const existing = coordinators.get(agentManager);
  if (existing) return existing;
  const coordinator: FinishCoordinator = {
    agentManager,
    watchers: new Set(),
    pendingDeliveries: new Map(),
    unsubscribe: null,
    evaluationScheduled: false,
  };
  coordinators.set(agentManager, coordinator);
  return coordinator;
}

function refreshSubscription(coordinator: FinishCoordinator): void {
  if (coordinator.watchers.size > 0 && !coordinator.unsubscribe) {
    coordinator.unsubscribe = coordinator.agentManager.subscribe(
      (event) => handleEvent(coordinator, event),
      { replayState: false },
    );
    return;
  }
  if (coordinator.watchers.size === 0 && coordinator.unsubscribe) {
    coordinator.unsubscribe();
    coordinator.unsubscribe = null;
  }
}

function handleEvent(coordinator: FinishCoordinator, event: AgentManagerEvent): void {
  if (event.type === "agent_state") {
    handleAgentState(coordinator, event.agent);
    scheduleEvaluation(coordinator);
  } else if (event.type === "agent_stream") {
    handleAgentStream(coordinator, event.agentId, event.event);
  }
}

function handleAgentState(coordinator: FinishCoordinator, agent: ManagedAgent): void {
  for (const watcher of coordinator.watchers) {
    if (watcher.childAgentId !== agent.id) continue;
    for (const requestId of watcher.notifiedPermissionRequestIds) {
      if (!agent.pendingPermissions.has(requestId)) {
        watcher.notifiedPermissionRequestIds.delete(requestId);
      }
    }
    if (agent.lifecycle === "running" && agent.pendingPermissions.size === 0) {
      watcher.hasSeenRunning = true;
    } else if (agent.lifecycle === "error") {
      watcher.terminalReason = "errored";
    } else if (agent.lifecycle === "closed") {
      watcher.terminalReason = "was closed";
    }
  }
}

function handleAgentStream(
  coordinator: FinishCoordinator,
  agentId: string,
  event: Extract<AgentManagerEvent, { type: "agent_stream" }>["event"],
): void {
  for (const watcher of coordinator.watchers) {
    if (watcher.childAgentId !== agentId) continue;
    if (event.type === "permission_requested") {
      watcher.hasSeenRunning = false;
      if (!watcher.notifiedPermissionRequestIds.has(event.request.id)) {
        watcher.notifiedPermissionRequestIds.add(event.request.id);
        enqueueDelivery(watcher, {
          reason: "needs permission",
          permissionRequest: event.request,
        });
      }
    } else if (event.type === "permission_resolved") {
      watcher.notifiedPermissionRequestIds.delete(event.requestId);
      const child = coordinator.agentManager.getAgent(agentId);
      if (child?.pendingPermissions.size === 0) {
        watcher.hasSeenRunning = child.lifecycle === "running";
      }
    }
  }
}

function enqueueDelivery(watcher: FinishWatcher, delivery: FinishNotificationDelivery): void {
  watcher.deliveryTail = watcher.deliveryTail
    .then(() => watcher.deliver(delivery))
    .catch((error: unknown) => {
      watcher.logger.error(
        {
          err: error,
          childAgentId: watcher.childAgentId,
          callerAgentId: watcher.callerAgentId,
          reason: delivery.reason,
        },
        "Failed to notify caller agent",
      );
    });
}

function scheduleEvaluation(coordinator: FinishCoordinator): void {
  if (coordinator.evaluationScheduled) return;
  coordinator.evaluationScheduled = true;
  queueMicrotask(() => {
    coordinator.evaluationScheduled = false;
    evaluate(coordinator);
  });
}

function evaluate(coordinator: FinishCoordinator): void {
  if (coordinator.watchers.size === 0) return;
  const agents = coordinator.agentManager.listAgents();
  const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

  for (const watcher of coordinator.watchers) {
    const child = agentsById.get(watcher.childAgentId);
    if (
      child &&
      watcher.requireParentOwnership &&
      getParentAgentIdFromLabels(child.labels) !== watcher.callerAgentId
    ) {
      coordinator.watchers.delete(watcher);
    }
  }
  refreshSubscription(coordinator);
  if (coordinator.watchers.size === 0) return;

  const dependencies = buildDependencies(agents, coordinator.watchers);
  const candidates = Array.from(coordinator.watchers).filter((watcher) =>
    isTerminalCandidate(coordinator, watcher, agentsById, dependencies),
  );
  const candidateAgentIds = new Set(candidates.map((watcher) => watcher.childAgentId));
  const activeWatcherAgentIds = new Set(
    Array.from(coordinator.watchers, (watcher) => watcher.childAgentId),
  );

  for (const watcher of candidates) {
    if (
      !watcher.terminalReason &&
      hasUnsettledDescendant(
        watcher.childAgentId,
        dependencies,
        activeWatcherAgentIds,
        candidateAgentIds,
      )
    ) {
      continue;
    }
    beginTerminalDelivery(coordinator, watcher);
  }
}

function buildDependencies(
  agents: ManagedAgent[],
  watchers: Set<FinishWatcher>,
): Map<string, Set<string>> {
  const dependencies = new Map<string, Set<string>>();
  function add(callerAgentId: string, childAgentId: string): void {
    const children = dependencies.get(callerAgentId) ?? new Set<string>();
    children.add(childAgentId);
    dependencies.set(callerAgentId, children);
  }
  for (const agent of agents) {
    const parentAgentId = getParentAgentIdFromLabels(agent.labels);
    if (parentAgentId) add(parentAgentId, agent.id);
  }
  for (const watcher of watchers) add(watcher.callerAgentId, watcher.childAgentId);
  return dependencies;
}

function isTerminalCandidate(
  coordinator: FinishCoordinator,
  watcher: FinishWatcher,
  agentsById: Map<string, ManagedAgent>,
  dependencies: Map<string, Set<string>>,
): boolean {
  if (watcher.terminalReason) return true;
  const child = agentsById.get(watcher.childAgentId);
  if (!child || !watcher.hasSeenRunning || child.lifecycle !== "idle") return false;
  return !hasActiveReachableAgent(coordinator, child.id, agentsById, dependencies);
}

function hasActiveReachableAgent(
  coordinator: FinishCoordinator,
  rootAgentId: string,
  agentsById: Map<string, ManagedAgent>,
  dependencies: Map<string, Set<string>>,
): boolean {
  const visited = new Set<string>();
  const pending = [rootAgentId];
  while (pending.length > 0) {
    const agentId = pending.pop()!;
    if (visited.has(agentId)) continue;
    visited.add(agentId);
    const agent = agentsById.get(agentId);
    if (!agent) return true;
    const hasPendingDelivery = (coordinator.pendingDeliveries.get(agentId) ?? 0) > 0;
    const isRunning = agent.lifecycle === "initializing" || agent.lifecycle === "running";
    if (hasPendingDelivery || isRunning || coordinator.agentManager.hasInFlightRun(agentId)) {
      return true;
    }
    pending.push(...(dependencies.get(agentId) ?? []));
  }
  return false;
}

function hasUnsettledDescendant(
  rootAgentId: string,
  dependencies: Map<string, Set<string>>,
  activeWatcherAgentIds: Set<string>,
  candidateAgentIds: Set<string>,
): boolean {
  const visited = new Set([rootAgentId]);
  const pending = [...(dependencies.get(rootAgentId) ?? [])];
  while (pending.length > 0) {
    const agentId = pending.pop()!;
    if (visited.has(agentId)) continue;
    visited.add(agentId);
    if (activeWatcherAgentIds.has(agentId)) {
      if (!candidateAgentIds.has(agentId)) return true;
      if (!isReachable(agentId, rootAgentId, dependencies)) return true;
    }
    pending.push(...(dependencies.get(agentId) ?? []));
  }
  return false;
}

function isReachable(
  fromAgentId: string,
  targetAgentId: string,
  dependencies: Map<string, Set<string>>,
): boolean {
  const visited = new Set<string>();
  const pending = [fromAgentId];
  while (pending.length > 0) {
    const agentId = pending.pop()!;
    if (agentId === targetAgentId) return true;
    if (visited.has(agentId)) continue;
    visited.add(agentId);
    pending.push(...(dependencies.get(agentId) ?? []));
  }
  return false;
}

function beginTerminalDelivery(coordinator: FinishCoordinator, watcher: FinishWatcher): void {
  const pendingCount = coordinator.pendingDeliveries.get(watcher.callerAgentId) ?? 0;
  coordinator.pendingDeliveries.set(watcher.callerAgentId, pendingCount + 1);
  coordinator.watchers.delete(watcher);
  refreshSubscription(coordinator);

  enqueueDelivery(watcher, { reason: watcher.terminalReason ?? "finished" });
  void watcher.deliveryTail.finally(() => {
    const remaining = (coordinator.pendingDeliveries.get(watcher.callerAgentId) ?? 1) - 1;
    if (remaining === 0) {
      coordinator.pendingDeliveries.delete(watcher.callerAgentId);
    } else {
      coordinator.pendingDeliveries.set(watcher.callerAgentId, remaining);
    }
    refreshSubscription(coordinator);
    scheduleEvaluation(coordinator);
  });
}
