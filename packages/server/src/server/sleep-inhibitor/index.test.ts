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
  lose(supported: boolean): void;
  listenerCount(): number;
  backend: SleepInhibitorBackend;
}

function createBackend(supported = true): BackendHarness {
  let held = false;
  const listeners = new Set<() => void>();
  function notify(): void {
    for (const listener of listeners) listener();
  }
  const harness: BackendHarness = {
    acquireCount: 0,
    releaseCount: 0,
    lose(available): void {
      held = false;
      supported = available;
      notify();
    },
    listenerCount: () => listeners.size,
    backend: {
      isSupported: () => supported,
      isHeld: () => held,
      onChange(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      acquire(): void {
        if (!supported || held) return;
        held = true;
        harness.acquireCount += 1;
        notify();
      },
      release(): void {
        if (!held) return;
        held = false;
        harness.releaseCount += 1;
        notify();
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

function createConfigStore(enabled = true) {
  const config = { preventSleepWhileAgentsRun: enabled };
  const listeners = new Set<() => void>();
  return {
    store: {
      get: () => config,
      onChange(listener: () => void) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    setEnabled(value: boolean): void {
      config.preventSleepWhileAgentsRun = value;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function setup(options?: { enabled?: boolean; supported?: boolean }) {
  harness = createBackend(options?.supported ?? true);
  const agentManager = createAgentManager();
  const config = createConfigStore(options?.enabled ?? true);
  const states: SleepInhibitorState[] = [];

  const runtime = setupSleepInhibitor({
    agentManager: agentManager.manager,
    daemonConfigStore: config.store,
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

  test("applies setting changes while the agent stays running", () => {
    const { runtime, agentManager, config, states } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });
    expect(harness.acquireCount).toBe(1);

    config.setEnabled(false);

    expect(harness.releaseCount).toBe(1);
    expect(runtime.getState().active).toBe(false);

    config.setEnabled(true);

    expect(harness.acquireCount).toBe(2);
    expect(runtime.getState().active).toBe(true);
    expect(states).toEqual([
      { active: true, supported: true, agentCount: 1 },
      { active: false, supported: true, agentCount: 1 },
      { active: true, supported: true, agentCount: 1 },
    ]);
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
      daemonConfigStore: createConfigStore().store,
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

  test.each([true, false])(
    "publishes helper loss with supported=%s without retrying",
    (supported) => {
      const { runtime, agentManager, states } = setup();
      agentManager.setAgent({ id: "a", lifecycle: "running" });

      harness.lose(supported);
      vi.advanceTimersByTime(RELEASE_DELAY_MS * 2);

      expect(states).toEqual([
        { active: true, supported: true, agentCount: 1 },
        { active: false, supported, agentCount: 1 },
      ]);
      expect(runtime.getState()).toEqual({ active: false, supported, agentCount: 1 });
      expect(harness.acquireCount).toBe(1);
      runtime.dispose();
    },
  );

  test("can reacquire after helper loss on a later agent event", () => {
    const { runtime, agentManager } = setup();
    agentManager.setAgent({ id: "a", lifecycle: "running" });
    harness.lose(true);

    agentManager.setAgent({ id: "a", lifecycle: "running" });

    expect(harness.acquireCount).toBe(2);
    expect(runtime.getState()).toEqual({ active: true, supported: true, agentCount: 1 });
    runtime.dispose();
  });

  test("releases and unsubscribes on dispose", () => {
    const { runtime, agentManager, config, states } = setup();

    agentManager.setAgent({ id: "a", lifecycle: "running" });
    runtime.dispose();

    expect(harness.releaseCount).toBe(1);
    expect(agentManager.listenerCount()).toBe(0);
    expect(config.listenerCount()).toBe(0);
    expect(harness.listenerCount()).toBe(0);

    harness.lose(false);
    config.setEnabled(false);
    config.setEnabled(true);
    agentManager.setAgent({ id: "a", lifecycle: "running" });

    expect(harness.acquireCount).toBe(1);
    expect(states).toEqual([{ active: true, supported: true, agentCount: 1 }]);
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
