import { expect, test } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentStorage } from "./agent/agent-storage.js";
import { createTestLogger } from "../test-utils/test-logger.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { createAgentMessageDelivery } from "./agent/agent-messages/index.js";
import {
  recoverInterruptedAgentRecords,
  deliverInterruptedFinishNotifications,
} from "./agent/restart-recovery.js";

import { fanOutReconciledWorkspaceUpdates } from "./bootstrap.js";

test("clean shutdown preserves active-turn interruption and finish callbacks for the next worker", async () => {
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
    await handle.daemon.agentStorage.addFinishNotification(agent.id, {
      id: "shutdown-watch",
      callerAgentId: "caller",
      requireParentOwnership: false,
    });
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
    expect(record?.finishNotifications).toEqual([
      {
        id: "shutdown-watch",
        callerAgentId: "caller",
        requireParentOwnership: false,
        interruptedAt: expect.any(String),
      },
    ]);
    // A late stop() from the previous worker must not discard the recovered callback.
    await reloaded.removeFinishNotification(agent.id, "shutdown-watch");
    expect((await reloaded.get(agent.id))?.finishNotifications).toHaveLength(1);
  } finally {
    finish();
    await run;
    await handle.daemon.agentManager.flush();
    await rm(root, { recursive: true, force: true });
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
    await rm(root, { recursive: true, force: true });
  }
});

test("interrupted finish callbacks survive failed dispatch and are removed after acknowledgement", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-interrupted-notify-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(root, logger);
  const parentId = "00000000-0000-4000-8000-000000000002";
  const childId = "00000000-0000-4000-8000-000000000003";
  const base = {
    provider: "claude",
    cwd: root,
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    persistence: null,
  };
  await storage.upsert({ ...base, id: parentId, labels: {}, lastStatus: "idle" });
  await storage.upsert({
    ...base,
    id: childId,
    labels: { "paseo.parent-agent-id": parentId },
    lastStatus: "running",
  });
  await storage.addFinishNotification(childId, {
    id: "callback-1",
    callerAgentId: parentId,
    requireParentOwnership: true,
  });
  await recoverInterruptedAgentRecords(storage, logger);
  const attempted: Array<{
    recipientId: string;
    messageIds: readonly string[];
    prompt: unknown;
    unarchive: boolean;
  }> = [];
  const delivery = createAgentMessageDelivery({
    schedule: (_delay, callback) => {
      queueMicrotask(callback);
      return () => {};
    },
    async dispatch(request) {
      attempted.push(request);
      if (attempted.length === 1) throw new Error("recipient temporarily unavailable");
      return "turn_started";
    },
    onError() {},
  });
  try {
    await deliverInterruptedFinishNotifications({ storage, agentMessages: delivery, logger });
    expect((await storage.get(childId))?.finishNotifications).toEqual([
      {
        id: "callback-1",
        callerAgentId: parentId,
        requireParentOwnership: true,
        interruptedAt: expect.any(String),
      },
    ]);
    const reloaded = new AgentStorage(root, logger);
    await recoverInterruptedAgentRecords(reloaded, logger);
    await deliverInterruptedFinishNotifications({
      storage: reloaded,
      agentMessages: delivery,
      logger,
    });
    expect(attempted).toHaveLength(2);
    expect(
      attempted.map(({ recipientId, messageIds, unarchive }) => ({
        recipientId,
        messageIds,
        unarchive,
      })),
    ).toEqual([
      { recipientId: parentId, messageIds: ["callback-1"], unarchive: false },
      { recipientId: parentId, messageIds: ["callback-1"], unarchive: false },
    ]);
    expect(attempted[1]?.prompt).toContain("Daemon restarted before the active turn completed.");
    expect((await reloaded.get(childId))?.finishNotifications).toEqual([]);
    await deliverInterruptedFinishNotifications({
      storage: reloaded,
      agentMessages: delivery,
      logger,
    });
    expect(attempted).toHaveLength(2);
  } finally {
    await delivery.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("startup keeps archived agents closed and preserves idle agents without finish subscriptions", async () => {
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
  await storage.upsert(archived);
  await storage.upsert(idle);
  try {
    await recoverInterruptedAgentRecords(storage, logger);
    expect(await storage.get("archived")).toEqual({
      ...archived,
      lastStatus: "closed",
      finishNotifications: [],
    });
    expect(await storage.get("idle")).toEqual(idle);
  } finally {
    await rm(root, { recursive: true, force: true });
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
