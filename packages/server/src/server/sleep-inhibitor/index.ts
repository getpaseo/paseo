import type { Logger } from "pino";

import type { AgentLifecycleStatus } from "../agent/agent-manager.js";
import { createProcessSleepInhibitor, type SleepInhibitorBackend } from "./backend.js";

/**
 * Mirrors the agent manager's own busy definition (BUSY_STATUSES). An agent
 * that is initializing is already burning CPU on this host.
 */
const BUSY_STATUSES: ReadonlySet<AgentLifecycleStatus> = new Set(["initializing", "running"]);

/**
 * Releasing the instant the last agent goes idle would thrash the helper
 * process across a multi-turn conversation, where a turn ends and the next one
 * starts within a second. Acquiring stays immediate.
 */
const DEFAULT_RELEASE_DELAY_MS = 10_000;

export interface SleepInhibitorState {
  active: boolean;
  supported: boolean;
  agentCount: number;
}

/**
 * The only agent facts this module needs. Narrower than ManagedAgent on
 * purpose: it keeps the coupling to the agent manager to three fields.
 */
export interface SleepInhibitorAgent {
  id: string;
  lifecycle: AgentLifecycleStatus;
  internal?: boolean;
}

interface AgentManagerLike {
  subscribe(
    callback: (event: { type: string; agent?: SleepInhibitorAgent }) => void,
    options?: { replayState?: boolean },
  ): () => void;
  getAgent(id: string): SleepInhibitorAgent | null;
  listAgents(): SleepInhibitorAgent[];
}

export interface SleepInhibitorOptions {
  agentManager: AgentManagerLike;
  daemonConfigStore: {
    get(): { preventSleepWhileAgentsRun?: boolean };
    onChange(listener: () => void): () => void;
  };
  logger: Logger;
  backend?: SleepInhibitorBackend;
  releaseDelayMs?: number;
  onStateChanged?: (state: SleepInhibitorState) => void;
}

export interface SleepInhibitorRuntime {
  getState(): SleepInhibitorState;
  dispose(): void;
}

function isBusy(agent: SleepInhibitorAgent): boolean {
  return !agent.internal && BUSY_STATUSES.has(agent.lifecycle);
}

export function setupSleepInhibitor(options: SleepInhibitorOptions): SleepInhibitorRuntime {
  const log = options.logger.child({ module: "sleep-inhibitor" });
  const backend =
    options.backend ?? createProcessSleepInhibitor({ logger: options.logger, pid: process.pid });
  const releaseDelayMs = options.releaseDelayMs ?? DEFAULT_RELEASE_DELAY_MS;

  // Agent ids believed busy. The manager has no "agent removed" event, so
  // entries are pruned against the live agent map on read rather than trusted.
  const busyAgentIds = new Set<string>();
  let releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let lastState: SleepInhibitorState | null = null;

  function countBusyAgents(): number {
    for (const agentId of busyAgentIds) {
      const agent = options.agentManager.getAgent(agentId);
      if (!agent || !isBusy(agent)) busyAgentIds.delete(agentId);
    }
    return busyAgentIds.size;
  }

  function currentState(agentCount: number): SleepInhibitorState {
    return {
      active: backend.isHeld(),
      supported: backend.isSupported(),
      agentCount,
    };
  }

  function publishState(agentCount: number): void {
    const state = currentState(agentCount);
    if (
      lastState &&
      lastState.active === state.active &&
      lastState.supported === state.supported &&
      lastState.agentCount === state.agentCount
    ) {
      return;
    }
    lastState = state;
    options.onStateChanged?.(state);
  }

  function cancelPendingRelease(): void {
    if (!releaseTimer) return;
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }

  function releaseNow(): void {
    cancelPendingRelease();
    const wasHeld = backend.isHeld();
    backend.release();
    if (wasHeld) {
      log.info("Released sleep inhibitor");
      publishState(countBusyAgents());
    }
  }

  function evaluate(): void {
    if (disposed) return;

    const agentCount = countBusyAgents();
    // Read the flag at event time so toggling the setting applies without a
    // daemon restart.
    const enabled = options.daemonConfigStore.get().preventSleepWhileAgentsRun !== false;
    const shouldHold = enabled && agentCount > 0;

    if (shouldHold) {
      cancelPendingRelease();
      if (!backend.isHeld()) {
        backend.acquire();
        if (backend.isHeld()) log.info({ agentCount }, "Holding sleep inhibitor");
      }
      publishState(agentCount);
      return;
    }

    if (!backend.isHeld()) {
      publishState(agentCount);
      return;
    }

    // Turning the setting off should take effect now, not after the debounce.
    if (!enabled) {
      releaseNow();
      return;
    }

    if (!releaseTimer) {
      releaseTimer = setTimeout(releaseNow, releaseDelayMs);
      releaseTimer.unref?.();
    }
    publishState(agentCount);
  }

  for (const agent of options.agentManager.listAgents()) {
    if (isBusy(agent)) busyAgentIds.add(agent.id);
  }

  // Seed the baseline so construction only notifies when the first evaluate
  // actually changes something — a daemon starting with no agents is not news.
  lastState = currentState(busyAgentIds.size);

  const unsubscribe = options.agentManager.subscribe(
    (event) => {
      if (event.type !== "agent_state" || !event.agent) return;
      const agent = event.agent;
      if (isBusy(agent)) {
        busyAgentIds.add(agent.id);
      } else {
        busyAgentIds.delete(agent.id);
      }
      evaluate();
    },
    { replayState: false },
  );

  const unsubscribeConfig = options.daemonConfigStore.onChange(evaluate);
  evaluate();

  return {
    getState: () => currentState(countBusyAgents()),
    dispose(): void {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      unsubscribeConfig();
      cancelPendingRelease();
      backend.release();
    },
  };
}
