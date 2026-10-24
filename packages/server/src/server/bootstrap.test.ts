import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createJsonFinishSubscriptionStore } from "./agent/finish-subscriptions/index.js";
import { recoverInterruptedAgentRecords } from "./agent/restart-recovery.js";

import { fanOutReconciledWorkspaceUpdates } from "./bootstrap.js";

test("clean shutdown preserves active-turn interruption for the next worker", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-clean-interruption-"));
  let finish!: () => void;
  let running!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    running = resolve;
  });
  const clients = createTestAgentClients({
    beforeTurnComplete: async () => {
      running();
      await finished;
    },
  });
  const handle = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: clients,
  });
  let run: Promise<unknown> | undefined;
  try {
    const agent = await handle.daemon.agentManager.createAgent(
      { provider: "codex", cwd: root, modeId: "full-access" },
      undefined,
      {},
    );
    run = handle.daemon.agentManager.runAgent(agent.id, "keep working").catch(() => undefined);
    await started;
    expect(handle.daemon.agentManager.getAgent(agent.id)?.lifecycle).toBe("running");
    await handle.close();
    const reloaded = new AgentStorage(join(root, ".paseo", "agents"), createTestLogger());
    const record = await reloaded.get(agent.id);
    expect(record).toMatchObject({
      lastStatus: "error",
      lastError: "Daemon restarted before the active turn completed.",
    });
  } finally {
    finish();
    await run;
    await handle.daemon.agentManager.flush();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("startup reports an interrupted plugin turn without reopening its provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-interrupted-turn-"));
  const storage = new AgentStorage(join(root, ".paseo", "agents"), createTestLogger());
  const id = "00000000-0000-4000-8000-000000000001";
  await storage.upsert({
    id,
    provider: "plugin-interrupted",
    cwd: root,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    labels: {},
    lastStatus: "running",
    persistence: null,
  });
  const daemon = await createTestPaseoDaemon({ paseoHomeRoot: root, cleanup: false });
  try {
    const record = await daemon.daemon.agentStorage.get(id);
    expect(record).toMatchObject({
      lastStatus: "error",
      requiresAttention: true,
      attentionReason: "error",
      lastError: "Daemon restarted before the active turn completed.",
    });
    expect(record?.attentionTimestamp).toEqual(expect.any(String));
    expect(daemon.daemon.agentManager.listAgents()).toEqual([]);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("startup replays interrupted errors through the durable finish-subscription service", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-interrupted-subscription-"));
  const logger = createTestLogger();
  const home = join(root, ".paseo");
  const storage = new AgentStorage(join(home, "agents"), logger);
  const parentId = "00000000-0000-4000-8000-000000000002";
  const childId = "00000000-0000-4000-8000-000000000003";
  const base = {
    cwd: root,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    persistence: null,
    lastModeId: "full-access",
  };
  await storage.upsert({
    ...base,
    id: parentId,
    provider: "codex",
    labels: {},
    lastStatus: "idle",
  });
  await storage.upsert({
    ...base,
    id: childId,
    provider: "plugin-interrupted",
    labels: { "paseo.parent-agent-id": parentId },
    lastStatus: "running",
  });
  await storage.flush();
  await createJsonFinishSubscriptionStore(home).put({
    id: "interrupted-subscription",
    childAgentId: childId,
    callerAgentId: parentId,
    requireParentOwnership: true,
  });
  let attempts = 0;
  const prompts: string[] = [];
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot: root,
    cleanup: false,
    agentClients: createTestAgentClients({
      async beforeCreateSession() {
        if (++attempts === 1) throw new Error("recipient temporarily unavailable");
      },
      onStartTurn: (prompt) => prompts.push(String(prompt)),
    }),
  });
  try {
    await expect.poll(() => prompts.length, { timeout: 12_000 }).toBe(1);
    expect(prompts[0]).toContain(`Agent ${childId}`);
    expect(prompts[0]).toContain("errored");
    expect(attempts).toBe(2);
    expect(daemon.daemon.agentManager.getAgent(childId)).toBeNull();
    expect((await daemon.daemon.agentStorage.get(childId))?.lastStatus).toBe("error");
    await expect.poll(() => createJsonFinishSubscriptionStore(home).list()).toEqual([]);
  } finally {
    await daemon.close();
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}, 15_000);

test("startup keeps archived and daemon-owned agents closed while preserving idle records", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-archived-recovery-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(root, logger);
  const base = {
    provider: "claude",
    cwd: root,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    persistence: null,
    labels: {},
  };
  const archived = {
    ...base,
    id: "archived",
    lastStatus: "running" as const,
    archivedAt: "2026-10-22T01:00:00.000Z",
  };
  const idle = { ...base, id: "idle", lastStatus: "idle" as const };
  const owned = {
    ...base,
    id: "owned",
    lastStatus: "running" as const,
    owner: { kind: "daemon" as const, daemonId: "hub", executionId: "execution" },
  };
  await storage.upsert(archived);
  await storage.upsert(idle);
  await storage.upsert(owned);
  try {
    await recoverInterruptedAgentRecords(storage, logger);
    expect(await storage.get("archived")).toEqual({
      ...archived,
      lastStatus: "closed",
    });
    expect(await storage.get("idle")).toEqual(idle);
    expect(await storage.get("owned")).toEqual({ ...owned, lastStatus: "closed" });
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reconciliation emits workspace updates when observer sync fails", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const syncFailure = new Error("workspace observer unavailable");

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {
          throw syncFailure;
        },
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: { warn: () => {} },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
});

test("reconciliation isolates workspace update failures between sessions", async () => {
  const emittedWorkspaceIds: string[][] = [];
  const warnings: unknown[] = [];

  await fanOutReconciledWorkspaceUpdates({
    sessions: [
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async () => {
          throw new Error("session closed");
        },
      },
      {
        syncWorkspaceGitObserversForExternalWorkspaceIds: async () => {},
        emitWorkspaceUpdatesForExternalWorkspaceIds: async (workspaceIds) => {
          emittedWorkspaceIds.push(Array.from(workspaceIds));
        },
      },
    ],
    workspaceIds: ["ws-reclassified"],
    logger: {
      warn: (context) => {
        warnings.push(context);
      },
    },
  });

  expect(emittedWorkspaceIds).toEqual([["ws-reclassified"]]);
  expect(warnings).toHaveLength(1);
});
