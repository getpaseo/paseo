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
type SyncErrorSyncState = Extract<ReadyState["sync"], { status: "sync_error" }>;

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
    labels: {},
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
  overrides: Partial<AgentScreenMachineMemory> = {}
): AgentScreenMachineMemory {
  return {
    hasRenderedReady: false,
    lastReadyAgent: null,
    activeToastLatch: "none",
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

function expectSyncErrorSync(state: ReadyState): SyncErrorSyncState {
  expect(state.sync.status).toBe("sync_error");
  if (state.sync.status !== "sync_error") {
    throw new Error("expected sync_error sync state");
  }
  return state.sync;
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
    expect(sync.shouldEmitHistoryRefreshToast).toBe(false);
  });

  it("uses toast catching-up state for already-hydrated agents", () => {
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

    expect(sync.ui).toBe("toast");
    expect(sync.shouldEmitHistoryRefreshToast).toBe(true);
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
    const sync = expectSyncErrorSync(ready);

    expect(sync.shouldEmitSyncErrorToast).toBe(true);
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
    const errorSync = expectSyncErrorSync(errorReady);

    expect(errorSync.shouldEmitSyncErrorToast).toBe(true);
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
    expect(retrySync.shouldEmitHistoryRefreshToast).toBe(false);
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
    const sync = expectSyncErrorSync(ready);

    expect(ready.source).toBe("stale");
    expect(ready.agent.id).toBe("agent-1");
    expect(sync.shouldEmitSyncErrorToast).toBe(true);
  });

  it("emits sync error toast only on transition into sync_error", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      missingAgentState: { kind: "error", message: "network timeout" },
    };

    const first = deriveAgentScreenViewState({ input, memory });
    const firstReady = expectReadyState(first.state);
    const firstSync = expectSyncErrorSync(firstReady);
    expect(firstSync.shouldEmitSyncErrorToast).toBe(true);

    const second = deriveAgentScreenViewState({
      input,
      memory: first.memory,
    });
    const secondReady = expectReadyState(second.state);
    const secondSync = expectSyncErrorSync(secondReady);
    expect(secondSync.shouldEmitSyncErrorToast).toBe(false);
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

  it("emits history refresh toast only on transition into toast catch-up state", () => {
    const memory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });
    const input: AgentScreenMachineInput = {
      ...createBaseInput(),
      needsAuthoritativeSync: true,
      hasHydratedHistoryBefore: true,
    };

    const first = deriveAgentScreenViewState({ input, memory });
    const firstReady = expectReadyState(first.state);
    const firstSync = expectCatchingUpSync(firstReady);

    expect(firstSync.ui).toBe("toast");
    expect(firstSync.shouldEmitHistoryRefreshToast).toBe(true);

    const second = deriveAgentScreenViewState({
      input,
      memory: first.memory,
    });
    const secondReady = expectReadyState(second.state);
    const secondSync = expectCatchingUpSync(secondReady);

    expect(secondSync.ui).toBe("toast");
    expect(secondSync.shouldEmitHistoryRefreshToast).toBe(false);
  });

  it("re-arms history refresh toast after leaving and re-entering catch-up", () => {
    const baseInput: AgentScreenMachineInput = {
      ...createBaseInput(),
      hasHydratedHistoryBefore: true,
    };
    const initialMemory = createBaseMemory({
      hasRenderedReady: true,
      lastReadyAgent: createAgent("agent-1"),
    });

    const firstCatchingUp = deriveAgentScreenViewState({
      input: { ...baseInput, needsAuthoritativeSync: true },
      memory: initialMemory,
    });
    const firstCatchingUpReady = expectReadyState(firstCatchingUp.state);
    const firstCatchingUpSync = expectCatchingUpSync(firstCatchingUpReady);
    expect(firstCatchingUpSync.ui).toBe("toast");
    expect(firstCatchingUpSync.shouldEmitHistoryRefreshToast).toBe(true);

    const idle = deriveAgentScreenViewState({
      input: { ...baseInput, needsAuthoritativeSync: false },
      memory: firstCatchingUp.memory,
    });
    const idleReady = expectReadyState(idle.state);
    expect(idleReady.sync.status).toBe("idle");

    const secondCatchingUp = deriveAgentScreenViewState({
      input: { ...baseInput, needsAuthoritativeSync: true },
      memory: idle.memory,
    });
    const secondCatchingUpReady = expectReadyState(secondCatchingUp.state);
    const secondCatchingUpSync = expectCatchingUpSync(secondCatchingUpReady);
    expect(secondCatchingUpSync.ui).toBe("toast");
    expect(secondCatchingUpSync.shouldEmitHistoryRefreshToast).toBe(true);
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

    expect(sync.ui).toBe("toast");
    expect(result.memory.hadInitialSyncFailure).toBe(false);
  });
});
