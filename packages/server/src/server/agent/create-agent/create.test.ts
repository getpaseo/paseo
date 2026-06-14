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

test("session create drops the source workspaceId when a worktree setup continuation runs", async () => {
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
    }),
  });

  const createOptions = createAgent.mock.calls[0]?.[2];
  expect(createOptions?.workspaceId).toBeUndefined();
});
