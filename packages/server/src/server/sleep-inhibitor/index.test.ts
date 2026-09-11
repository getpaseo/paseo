import type { Logger } from "pino";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { SleepInhibitorBackend } from "./backend.js";
import {
  setupSleepInhibitor,
  type SleepInhibitorAgent,
  type SleepInhibitorState,
} from "./index.js";

const RELEASE_DELAY_MS = 5_000;

function createLogger(): Logger {
  const logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger as unknown as Logger;
}

interface BackendHarness {
  acquireCount: number;
  releaseCount: number;
  backend: SleepInhibitorBackend;
}

function createBackend(supported = true): BackendHarness {
  let held = false;
  const harness: BackendHarness = {
    acquireCount: 0,
    releaseCount: 0,
    backend: {
      isSupported: () => supported,
      isHeld: () => held,
      acquire(): void {
        if (!supported || held) return;
        held = true;
        harness.acquireCount += 1;
      },
      release(): void {
        if (!held) return;
        held = false;
        harness.releaseCount += 1;
      },
    },
  };
  return harness;
}

let harness: BackendHarness;

function createAgentManager() {
  const agents = new Map<string, SleepInhibitorAgent>();
  const listeners = new Set<(event: { type: string; agent?: SleepInhibitorAgent }) => void>();

  return {
    agents,
    manager: {
      subscribe(callback: (event: { type: string; agent?: SleepInhibitorAgent }) => void) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
      getAgent: (id: string) => agents.get(id) ?? null,
      listAgents: () => Array.from(agents.values()),
    },
    setAgent(agent: SleepInhibitorAgent): void {
      agents.set(agent.id, agent);
      for (const listener of listeners) listener({ type: "agent_state", agent });
    },
    removeAgent(id: string): void {
      const agent = agents.get(id);
      agents.delete(id);
      if (!agent) return;
      for (const listener of listeners) {
        listener({ type: "agent_state", agent: { ...agent, lifecycle: "closed" } });
      }
    },
    listenerCount: () => listeners.size,
  };
}

function setup(options?: { enabled?: boolean; supported?: boolean }) {
  harness = createBackend(options?.supported ?? true);
  const agentManager = createAgentManager();
  const config = { preventSleepWhileAgentsRun: options?.enabled ?? true };
  const states: SleepInhibitorState[] = [];

  const runtime = setupSleepInhibitor({
    agentManager: agentManager.manager,
    daemonConfigStore: { get: () => config },
    logger: createLogger(),
    backend: harness.backend,
    releaseDelayMs: RELEASE_DELAY_MS,
    onStateChanged: (state) => states.push(state),
  });

  return { runtime, agentManager, config, states };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("sleep inhibitor", () => {
  test("holds the inhibitor while an agent is running", () => {
    const { runtime, agentManager } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });

    expect(harness.acquireCount).toBe(1);
    expect(runtime.getState()).toEqual({ active: true, supported: true, agentCount: 1 });
    runtime.dispose();
  });

  test("counts an initializing agent as busy", () => {
    const { runtime, agentManager } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "initializing" });

    expect(harness.acquireCount).toBe(1);
    runtime.dispose();
  });

  test("acquires once for concurrent agents and releases after the last one settles", () => {
    const { runtime, agentManager } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });
    agentManager.setAgent({ id: "b", lifecycle: "running" });

    expect(harness.acquireCount).toBe(1);
    expect(runtime.getState().agentCount).toBe(2);

    agentManager.setAgent({ id: "a", lifecycle: "idle" });
    vi.advanceTimersByTime(RELEASE_DELAY_MS);

    expect(harness.releaseCount).toBe(0);

    agentManager.setAgent({ id: "b", lifecycle: "idle" });
    vi.advanceTimersByTime(RELEASE_DELAY_MS);

    expect(harness.releaseCount).toBe(1);
    expect(runtime.getState()).toEqual({ active: false, supported: true, agentCount: 0 });
    runtime.dispose();
  });

  test("keeps holding across a gap shorter than the release delay", () => {
    const { runtime, agentManager } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });
    agentManager.setAgent({ id: "a", lifecycle: "idle" });
    vi.advanceTimersByTime(RELEASE_DELAY_MS - 1);
    agentManager.setAgent({ id: "a", lifecycle: "running" });
    vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);

    expect(harness.acquireCount).toBe(1);
    expect(harness.releaseCount).toBe(0);
    expect(runtime.getState().active).toBe(true);
    runtime.dispose();
  });

  test("does not acquire while the setting is off", () => {
    const { runtime, agentManager } = setup({ enabled: false });

    agentManager.setAgent({ id: "a", lifecycle: "running" });

    expect(harness.acquireCount).toBe(0);
    expect(runtime.getState()).toEqual({ active: false, supported: true, agentCount: 1 });
    runtime.dispose();
  });

  test("releases immediately when the setting is turned off mid-run", () => {
    const { runtime, agentManager, config } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });
    expect(harness.acquireCount).toBe(1);

    config.preventSleepWhileAgentsRun = false;
    agentManager.setAgent({ id: "a", lifecycle: "running" });

    expect(harness.releaseCount).toBe(1);
    expect(runtime.getState().active).toBe(false);
    runtime.dispose();
  });

  test("ignores internal agents", () => {
    const { runtime, agentManager } = setup();

    agentManager.setAgent({ id: "summary", lifecycle: "running", internal: true });

    expect(harness.acquireCount).toBe(0);
    expect(runtime.getState()).toEqual({ active: false, supported: true, agentCount: 0 });
    runtime.dispose();
  });

  test("drops a busy agent that disappears without going idle", () => {
    const { runtime, agentManager } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });
    agentManager.removeAgent("a");
    vi.advanceTimersByTime(RELEASE_DELAY_MS);

    expect(harness.releaseCount).toBe(1);
    expect(runtime.getState()).toEqual({ active: false, supported: true, agentCount: 0 });
    runtime.dispose();
  });

  test("adopts agents already running when the daemon starts", () => {
    harness = createBackend();
    const agentManager = createAgentManager();
    agentManager.agents.set("a", { id: "a", lifecycle: "running" });

    const runtime = setupSleepInhibitor({
      agentManager: agentManager.manager,
      daemonConfigStore: { get: () => ({ preventSleepWhileAgentsRun: true }) },
      logger: createLogger(),
      backend: harness.backend,
      releaseDelayMs: RELEASE_DELAY_MS,
    });

    expect(harness.acquireCount).toBe(1);
    runtime.dispose();
  });

  test("reports unsupported hosts as inactive and never acquires", () => {
    const { runtime, agentManager } = setup({ supported: false });

    agentManager.setAgent({ id: "a", lifecycle: "running" });

    expect(harness.acquireCount).toBe(0);
    expect(runtime.getState()).toEqual({ active: false, supported: false, agentCount: 1 });
    runtime.dispose();
  });

  test("releases and unsubscribes on dispose", () => {
    const { runtime, agentManager } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });
    runtime.dispose();

    expect(harness.releaseCount).toBe(1);
    expect(agentManager.listenerCount()).toBe(0);
  });

  test("publishes each state transition once", () => {
    const { runtime, agentManager, states } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });
    agentManager.setAgent({ id: "a", lifecycle: "running" });
    agentManager.setAgent({ id: "a", lifecycle: "idle" });
    vi.advanceTimersByTime(RELEASE_DELAY_MS);

    expect(states).toEqual([
      { active: true, supported: true, agentCount: 1 },
      { active: true, supported: true, agentCount: 0 },
      { active: false, supported: true, agentCount: 0 },
    ]);
    runtime.dispose();
  });
});
