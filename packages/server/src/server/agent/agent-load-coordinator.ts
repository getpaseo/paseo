import type { ManagedAgent } from "./agent-manager.js";

export interface PendingAgentInitialization {
  promise: Promise<ManagedAgent>;
  options: { broadcastTimeline: boolean };
}

const pendingAgentInitializations = new Map<string, PendingAgentInitialization>();
const interactiveTransitions = new Map<string, Promise<unknown>>();

export function getPendingAgentInitialization(
  agentId: string,
): PendingAgentInitialization | undefined {
  return pendingAgentInitializations.get(agentId);
}

export function hasAgentInteractiveTransition(agentId: string): boolean {
  return interactiveTransitions.has(agentId);
}

export function claimPendingAgentInitialization(
  agentId: string,
  pending: PendingAgentInitialization,
): boolean {
  if (pendingAgentInitializations.has(agentId) || interactiveTransitions.has(agentId)) {
    return false;
  }
  pendingAgentInitializations.set(agentId, pending);
  return true;
}

export function clearPendingAgentInitialization(
  agentId: string,
  pending: PendingAgentInitialization,
): void {
  if (pendingAgentInitializations.get(agentId) === pending) {
    pendingAgentInitializations.delete(agentId);
  }
}

/**
 * Serialize an archived-to-interactive transition with provider-backed loading.
 * A transition waits for an already-claimed history initialization to settle so
 * its reader can be closed before any native unarchive action runs.
 */
export function runAgentInteractiveTransition<T>(
  agentId: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = interactiveTransitions.get(agentId);
  const run = (async () => {
    await previous?.catch(() => undefined);
    await pendingAgentInitializations.get(agentId)?.promise.catch(() => undefined);
    return await operation();
  })();
  interactiveTransitions.set(agentId, run);
  const clear = () => {
    if (interactiveTransitions.get(agentId) === run) {
      interactiveTransitions.delete(agentId);
    }
  };
  void run.then(clear, clear);
  return run;
}

/** Wait until every interactive transition visible at the call boundary settles. */
export async function waitForAgentInteractiveTransition(agentId: string): Promise<void> {
  while (true) {
    const transition = interactiveTransitions.get(agentId);
    if (!transition) {
      return;
    }
    await transition.catch(() => undefined);
  }
}
