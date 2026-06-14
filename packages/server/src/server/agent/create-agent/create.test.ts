import { expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import { createAgentCommand } from "./create.js";
import type { ManagedAgent } from "../agent-manager.js";

test("session create forwards clientMessageId to the initial prompt run options", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const streamAgent = vi.fn(() => (async function* noop() {})());
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent: vi.fn(async () => snapshot),
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      streamAgent,
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {} as Parameters<
      typeof createAgentCommand
    >[0]["providerSnapshotManager"],
  };

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    initialPrompt: "hello from create",
    clientMessageId: "msg-create-1",
    labels: {},
    provisionalTitle: null,
    explicitTitle: "Explicit title",
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(streamAgent).toHaveBeenCalledWith("agent-1", "hello from create", {
    messageId: "msg-create-1",
  });
});

function buildCreateAgentDependencies(snapshot: ManagedAgent) {
  const createAgent = vi.fn(async () => snapshot);
  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn(() => snapshot),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      streamAgent: vi.fn(() => (async function* noop() {})()),
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {} as Parameters<
      typeof createAgentCommand
    >[0]["providerSnapshotManager"],
  };
  return { dependencies, createAgent };
}

test("session create stamps the requested workspaceId when no worktree setup runs", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test",
    runtimeInfo: null,
  } as ManagedAgent;
  const { dependencies, createAgent } = buildCreateAgentDependencies(snapshot);

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test" },
    workspaceId: "ws-source",
    labels: {},
    provisionalTitle: null,
    explicitTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({ sessionConfig: config }),
  });

  expect(createAgent).toHaveBeenCalledWith(
    expect.anything(),
    undefined,
    expect.objectContaining({ workspaceId: "ws-source" }),
  );
});

test("session create stamps the new worktree's workspaceId when a setup continuation runs", async () => {
  const snapshot = {
    id: "agent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test/worktree",
    runtimeInfo: null,
  } as ManagedAgent;
  const { dependencies, createAgent } = buildCreateAgentDependencies(snapshot);

  await createAgentCommand(dependencies, {
    kind: "session",
    config: { provider: "codex", cwd: "/tmp/paseo-create-test/worktree" },
    workspaceId: "ws-source",
    labels: {},
    provisionalTitle: null,
    explicitTitle: null,
    firstAgentContext: { attachments: [] },
    buildSessionConfig: async (config) => ({
      sessionConfig: config,
      setupContinuation: { startAfterAgentCreate: vi.fn() },
      createdWorkspaceId: "ws-new-worktree",
    }),
  });

  const createOptions = createAgent.mock.calls[0]?.[2];
  expect(createOptions?.workspaceId).toBe("ws-new-worktree");
});

test("mcp create stamps the new worktree's workspaceId, not the parent's", async () => {
  const parentAgent = {
    id: "parent-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test/repo",
    workspaceId: "ws-parent",
    runtimeInfo: null,
  } as ManagedAgent;
  const childSnapshot = {
    id: "child-1",
    provider: "codex",
    cwd: "/tmp/paseo-create-test/repo/worktree",
    runtimeInfo: null,
  } as ManagedAgent;
  const createAgent = vi.fn(async () => childSnapshot);
  const createPaseoWorktree = vi.fn(async () => ({
    worktree: { worktreePath: "/tmp/paseo-create-test/repo/worktree" },
    intent: {},
    workspace: { workspaceId: "ws-new-worktree" },
    repoRoot: "/tmp/paseo-create-test/repo",
    created: true,
    setupContinuation: { kind: "agent" as const, startAfterAgentCreate: vi.fn() },
  })) as unknown as Parameters<typeof createAgentCommand>[0]["createPaseoWorktree"];

  const dependencies: Parameters<typeof createAgentCommand>[0] = {
    agentManager: {
      createAgent,
      getAgent: vi.fn((id: string) => (id === "parent-1" ? parentAgent : childSnapshot)),
      tryRunOutOfBand: vi.fn(() => false),
      hasInFlightRun: vi.fn(() => false),
      streamAgent: vi.fn(() => (async function* noop() {})()),
      waitForAgentRunStart: vi.fn(async () => undefined),
    } as unknown as Parameters<typeof createAgentCommand>[0]["agentManager"],
    agentStorage: {} as Parameters<typeof createAgentCommand>[0]["agentStorage"],
    logger: createTestLogger(),
    providerSnapshotManager: {
      resolveCreateConfig: vi.fn(async () => ({ modeId: undefined, featureValues: undefined })),
    } as unknown as Parameters<typeof createAgentCommand>[0]["providerSnapshotManager"],
    createPaseoWorktree,
  };

  await createAgentCommand(dependencies, {
    kind: "mcp",
    provider: "codex/gpt-5.4",
    title: "child",
    initialPrompt: "do the thing",
    background: true,
    notifyOnFinish: false,
    callerAgentId: "parent-1",
    worktree: { worktreeName: "feature", baseBranch: "main" },
  });

  const createOptions = createAgent.mock.calls[0]?.[2];
  expect(createOptions?.workspaceId).toBe("ws-new-worktree");
});
