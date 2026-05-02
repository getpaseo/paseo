import { describe, expect, it } from "vitest";
import type { Agent } from "@/contexts/session-context";
import {
  deriveAgentScreenViewState,
  type AgentScreenMachineInput,
  type AgentScreenMachineMemory,
  type AgentScreenViewState,
} from "./use-agent-screen-state-machine";

type ReadyState = Extract<AgentScreenViewState, { tag: "ready" }>;
type CatchingUpSyncState = Extract<ReadyState["sync"], { status: "catching_up" }>;

function createAgent(id: string): Agent {
  const now = new Date("2026-02-19T00:00:00.000Z");
  return {
    serverId: "server-1",
    id,
    provider: "claude",
    status: "running",
    createdAt: now,
    updatedAt: now,
    lastUserMessageAt: now,
    lastActivityAt: now,
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    runtimeInfo: {
      provider: "claude",
      sessionId: "session-1",
      model: null,
      modeId: null,
    },
    title: "Agent",
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
  };
}

function createAgentWithStatus({ id, status }: { id: string; status: Agent["status"] }): Agent {
  return {
    ...createAgent(id),
    status,
  };
}

function createBaseInput(): AgentScreenMachineInput {
  return {
    agent: null,
    placeholderAgent: null,
    missingAgentState: { kind: "idle" },
    isConnected: true,
    isArchivingCurrentAgent: false,
    isHistorySyncing: false,
    needsAuthoritativeSync: false,
    shouldUseOptimisticStream: false,
    hasHydratedHistoryBefore: false,
  };
}

function createBaseMemory(
  overrides: Partial<AgentScreenMachineMemory> = {},
): AgentScreenMachineMemory {
  return {
    hasRenderedReady: false,
    lastReadyAgent: null,
    hadInitialSyncFailure: false,
    ...overrides,
  };
}

function expectReadyState(state: AgentScreenViewState): ReadyState {
  expect(state.tag).toBe("ready");
  if (state.tag !== "ready") {
    throw new Error("expected ready state");
  }
  return state;
}

function expectCatchingUpSync(state: ReadyState): CatchingUpSyncState {
  expect(state.sync.status).toBe("catching_up");
  if (state.sync.status !== "catching_up") {
    throw new Error("expected catching_up sync state");
  }
  return state.sync;
}

function expectSyncErrorSync(state: ReadyState): void {
  expect(state.sync.status).toBe("sync_error");
}

describe("deriveAgentScreenViewState", () => {
  it("returns boot loading before first interactive paint", () => {
    const memory = createBaseMemory();
    const input = createBaseInput();

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state.tag).toBe("boot");
    if (result.state.tag !== "boot") {
      throw new Error("expected boot state");
    }
    expect(result.state.reason).toBe("loading");
    expect(result.state.source).toBe("none");
  });

  it("stays ready after first paint even if agent is temporarily missing", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input = createBaseInput();

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("stale");
    expect(ready.sync.status).toBe("idle");
    expect(ready.agent.id).toBe("agent-1");
  });

  it("shows reconnecting sync status without blocking after first paint", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      isConnected: false,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.sync.status).toBe("reconnecting");
  });

  it("shows overlay catching-up state for first open while loading history", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    const sync = expectCatchingUpSync(ready);

    expect(sync.ui).toBe("overlay");
  });

  it("uses silent catching-up state for already-hydrated agents", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      hasHydratedHistoryBefore: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    const sync = expectCatchingUpSync(ready);

    expect(sync.ui).toBe("silent");
  });

  it("keeps sync errors non-blocking once the screen was ready", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    expectSyncErrorSync(ready);
  });

  it("remembers first-load sync failure and keeps catch-up overlay off after error clears", () => {
    const initialMemory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const errorInput: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const errorResult = deriveAgentScreenViewState({
      input: errorInput,
      memory: initialMemory,
    });
    const errorReady = expectReadyState(errorResult.state);
    expectSyncErrorSync(errorReady);
    expect(errorResult.memory.hadInitialSyncFailure).toBe(true);

    const retryInput: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      missingAgentState: { kind: "idle" },
    };
    const retryResult = deriveAgentScreenViewState({
      input: retryInput,
      memory: errorResult.memory,
    });
    const retryReady = expectReadyState(retryResult.state);
    const retrySync = expectCatchingUpSync(retryReady);

    expect(retrySync.ui).toBe("silent");
    expect(retryResult.memory.hadInitialSyncFailure).toBe(true);
  });

  it("keeps ready with sync_error when refresh fails after first paint", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    expectSyncErrorSync(ready);

    expect(ready.source).toBe("stale");
    expect(ready.agent.id).toBe("agent-1");
  });

  it("returns blocking error before first paint when refresh fails", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state.tag).toBe("error");
    if (result.state.tag !== "error") {
      throw new Error("expected error state");
    }
    expect(result.state.message).toContain("network timeout");
  });

  it("returns not_found when resolver confirms missing agent", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      missingAgentState: { kind: "not_found", message: "agent missing" },
    };

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state.tag).toBe("not_found");
    if (result.state.tag !== "not_found") {
      throw new Error("expected not_found state");
    }
    expect(result.state.message).toContain("missing");
  });

  it("promotes optimistic source while placeholder is used", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      placeholderAgent: createAgent("draft-agent"),
      shouldUseOptimisticStream: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("optimistic");
    expect(ready.sync.status).toBe("idle");
  });

  it("keeps first route entry blocked until authoritative history is applied", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgent("agent-1"),
      needsAuthoritativeSync: true,
      isHistorySyncing: true,
      hasHydratedHistoryBefore: false,
    };

    const result = deriveAgentScreenViewState({ input, memory });

    expect(result.state).toEqual({
      tag: "boot",
      reason: "loading",
      source: "none",
    });
    expect(result.memory.hasRenderedReady).toBe(false);
    expect(result.memory.lastReadyAgent).toBeNull();
  });

  it("still allows optimistic create flow to render before authoritative history arrives", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "idle" }),
      placeholderAgent: createAgent("agent-1"),
      shouldUseOptimisticStream: true,
      needsAuthoritativeSync: true,
      isHistorySyncing: true,
      hasHydratedHistoryBefore: false,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("optimistic");
    expect(ready.agent.status).toBe("running");
  });

  it("keeps optimistic flow non-blocking while transitioning to authoritative stream", () => {
    const initialMemory = createBaseMemory();
    const optimisticInput: AgentScreenMachineInput = {
      ...createBaseInput(),
      placeholderAgent: createAgent("draft-agent"),
      shouldUseOptimisticStream: true,
    };

    const optimistic = deriveAgentScreenViewState({
      input: optimisticInput,
      memory: initialMemory,
    });
    const optimisticReady = expectReadyState(optimistic.state);
    expect(optimisticReady.source).toBe("optimistic");

    const handoffInput: AgentScreenMachineInput = {
      ...createBaseInput(),
    };
    const handoff = deriveAgentScreenViewState({
      input: handoffInput,
      memory: optimistic.memory,
    });
    const handoffReady = expectReadyState(handoff.state);

    expect(handoffReady.source).toBe("stale");
    expect(handoffReady.agent.id).toBe("draft-agent");
  });

  it("keeps optimistic running status while authoritative agent is still bootstrapping", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "idle" }),
      placeholderAgent: createAgent("agent-1"),
      shouldUseOptimisticStream: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("optimistic");
    expect(ready.agent.status).toBe("running");
  });

  it("keeps optimistic running status while authoritative agent is initializing", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "initializing" }),
      placeholderAgent: createAgent("agent-1"),
      shouldUseOptimisticStream: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("optimistic");
    expect(ready.agent.status).toBe("running");
  });

  it("hands off to authoritative once agent reaches running", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "running" }),
      placeholderAgent: createAgent("agent-1"),
      shouldUseOptimisticStream: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("authoritative");
    expect(ready.agent.status).toBe("running");
  });

  it("hands off to authoritative for terminal error states", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "error" }),
      placeholderAgent: createAgent("agent-1"),
      shouldUseOptimisticStream: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("authoritative");
    expect(ready.agent.status).toBe("error");
  });

  it("hands off to authoritative for terminal closed states", () => {
    const memory = createBaseMemory();
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      agent: createAgentWithStatus({ id: "agent-1", status: "closed" }),
      placeholderAgent: createAgent("agent-1"),
      shouldUseOptimisticStream: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);

    expect(ready.source).toBe("authoritative");
    expect(ready.agent.status).toBe("closed");
  });

  it("clears initial sync failure memory after history is hydrated", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
      hadInitialSyncFailure: true,
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      hasHydratedHistoryBefore: true,
      needsAuthoritativeSync: true,
    };

    const result = deriveAgentScreenViewState({ input, memory });
    const ready = expectReadyState(result.state);
    const sync = expectCatchingUpSync(ready);

    expect(sync.ui).toBe("silent");
    expect(result.memory.hadInitialSyncFailure).toBe(false);
  });
});
