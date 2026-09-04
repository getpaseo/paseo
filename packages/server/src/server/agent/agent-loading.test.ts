import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, onTestFinished, test } from "vitest";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import { ensureAgentLoaded } from "./agent-loading.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentHistoryReadContext,
  AgentPersistenceHandle,
  AgentStreamEvent,
} from "./agent-sdk-types.js";
import { createTestAgentClients } from "../test-utils/fake-agent-client.js";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function completeHistory(events: AgentStreamEvent[]) {
  return { events, coverage: { kind: "complete" as const } };
}

type HistoryReader = NonNullable<AgentClient["readSessionHistory"]>;

interface LoaderHarnessOptions {
  readSessionHistory?: HistoryReader;
  archiveNativeSession?: (handle: AgentPersistenceHandle) => Promise<void>;
  unarchiveNativeSession?: (handle: AgentPersistenceHandle) => Promise<void>;
}

async function createLoaderHarness(options: LoaderHarnessOptions = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "agent-loading-history-"));
  const logger = createTestLogger();
  const storage = new AgentStorage(path.join(root, "agents"), logger);
  const baseClient = createTestAgentClients().codex;
  if (!baseClient) {
    throw new Error("expected Codex test client");
  }

  const calls = {
    createCount: 0,
    resumeSessionIds: [] as string[],
    history: [] as Array<{
      handle: AgentPersistenceHandle;
      context: AgentHistoryReadContext | undefined;
    }>,
  };
  const client: AgentClient = {
    provider: baseClient.provider,
    capabilities: baseClient.capabilities,
    createSession: async (config, launchContext) => {
      calls.createCount += 1;
      return await baseClient.createSession(config, launchContext);
    },
    resumeSession: async (handle, overrides, launchContext) => {
      calls.resumeSessionIds.push(handle.sessionId);
      return await baseClient.resumeSession(handle, overrides, launchContext);
    },
    readSessionHistory: async (handle, context) => {
      calls.history.push({ handle, context });
      return (await options.readSessionHistory?.(handle, context)) ?? completeHistory([]);
    },
    archiveNativeSession: options.archiveNativeSession,
    unarchiveNativeSession: options.unarchiveNativeSession,
    fetchCatalog: async (catalogOptions) => await baseClient.fetchCatalog(catalogOptions),
    isAvailable: async () => await baseClient.isAvailable(),
  };
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  onTestFinished(async () => {
    for (const agent of manager.listAgents()) {
      await manager.closeAgent(agent.id).catch(() => undefined);
    }
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  return {
    root,
    logger,
    storage,
    manager,
    calls,
    load: async (agentId: string, broadcastTimeline = false) =>
      await ensureAgentLoaded(agentId, {
        agentManager: manager,
        agentStorage: storage,
        ...(broadcastTimeline ? { broadcastTimeline: true } : {}),
        logger,
      }),
    createArchived: async (agentId: string, archiveOptions?: { internal?: boolean }) => {
      const agent = await manager.createAgent(
        {
          provider: "codex",
          cwd: root,
          ...(archiveOptions?.internal === undefined ? {} : { internal: archiveOptions.internal }),
        },
        agentId,
        {
          workspaceId: "workspace-archived",
        },
      );
      await manager.archiveAgent(agent.id);
      return agent;
    },
  };
}

test("loads archived history without interactive resume or archive-state changes", async () => {
  let nativeArchived = false;
  let nativeUnarchiveCount = 0;
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      expect(nativeArchived).toBe(true);
      return completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "Archived provider history" },
        },
      ]);
    },
    archiveNativeSession: async () => {
      nativeArchived = true;
    },
    unarchiveNativeSession: async () => {
      nativeArchived = false;
      nativeUnarchiveCount += 1;
    },
  });
  const archivedId = "00000000-0000-4000-8000-000000000301";
  const activeId = "00000000-0000-4000-8000-000000000302";
  const archived = await harness.createArchived(archivedId);
  const archivedAt = (await harness.storage.get(archived.id))?.archivedAt;
  const active = await harness.manager.createAgent(
    { provider: "codex", cwd: harness.root },
    activeId,
    { workspaceId: "workspace-active" },
  );
  await harness.manager.closeAgent(active.id);

  const archivedSnapshot = await harness.load(archived.id);
  const activeSnapshot = await harness.load(active.id);

  expect(archivedSnapshot.lifecycle).toBe("closed");
  expect(activeSnapshot.lifecycle).toBe("idle");
  expect(harness.manager.getAgent(archived.id)).toBeNull();
  expect(harness.manager.getTimeline(archived.id)).toContainEqual({
    type: "assistant_message",
    text: "Archived provider history",
  });
  expect(harness.calls.history).toEqual([
    {
      handle: expect.objectContaining({ sessionId: archived.persistence?.sessionId }),
      context: { agentId: archived.id, cwd: harness.root },
    },
  ]);
  expect(harness.calls.resumeSessionIds).toEqual([active.persistence?.sessionId]);
  expect((await harness.storage.get(archived.id))?.archivedAt).toBe(archivedAt);
  expect(nativeArchived).toBe(true);
  expect(nativeUnarchiveCount).toBe(0);
});

test("keeps archived internal history hidden from public provider-subagent reads", async () => {
  const agentId = "00000000-0000-4000-8000-000000000307";
  const subagentId = "hidden-archived-child";
  const harness = await createLoaderHarness({
    readSessionHistory: async () =>
      completeHistory([
        {
          type: "provider_subagent",
          provider: "codex",
          event: {
            type: "upsert",
            id: subagentId,
            title: "Hidden archived child",
            status: "completed",
          },
        },
      ]),
  });
  await harness.createArchived(agentId, { internal: true });
  expect((await harness.storage.get(agentId))?.internal).toBe(true);

  const snapshot = await harness.load(agentId);

  expect(snapshot.internal).toBe(true);
  expect(() => harness.manager.getTimeline(agentId)).toThrow(`Unknown agent '${agentId}'`);
  expect(() => harness.manager.fetchPublicTimeline(agentId)).toThrow(`Unknown agent '${agentId}'`);
  expect(() => harness.manager.listProviderSubagents(agentId)).toThrow(
    `Unknown agent '${agentId}'`,
  );
  expect(() => harness.manager.getProviderSubagent(agentId, subagentId)).toThrow(
    `Unknown agent '${agentId}'`,
  );
  expect(() => harness.manager.fetchProviderSubagentTimeline(agentId, subagentId)).toThrow(
    `Unknown agent '${agentId}'`,
  );
});

test("shares archived history reads and upgrades deferred timeline broadcast", async () => {
  const historyStarted = deferred();
  const historyAllowed = deferred();
  onTestFinished(() => historyAllowed.resolve());
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      historyStarted.resolve();
      await historyAllowed.promise;
      return completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "Shared archived history" },
        },
      ]);
    },
  });
  const agentId = "00000000-0000-4000-8000-000000000303";
  await harness.createArchived(agentId);
  const events: AgentManagerEvent[] = [];
  harness.manager.subscribe((event) => events.push(event), { agentId, replayState: false });

  const quietLoad = harness.load(agentId);
  await historyStarted.promise;
  const broadcastingLoad = harness.load(agentId, true);
  historyAllowed.resolve();

  const [quietSnapshot, broadcastingSnapshot] = await Promise.all([quietLoad, broadcastingLoad]);
  const cachedSnapshot = await harness.load(agentId);
  expect([quietSnapshot.id, broadcastingSnapshot.id, cachedSnapshot.id]).toEqual([
    agentId,
    agentId,
    agentId,
  ]);
  expect(harness.calls.history).toHaveLength(1);
  expect(events).toContainEqual(
    expect.objectContaining({
      type: "agent_stream",
      agentId,
      event: expect.objectContaining({
        type: "timeline",
        item: { type: "assistant_message", text: "Shared archived history" },
      }),
    }),
  );
});

async function runConcurrentUnarchiveScenario(
  historyFails: boolean,
  scenarioOptions?: { internal?: boolean },
) {
  const historyStarted = deferred();
  const historyAllowed = deferred();
  onTestFinished(() => historyAllowed.resolve());
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      historyStarted.resolve();
      await historyAllowed.promise;
      if (historyFails) {
        throw new Error("archived history became unavailable");
      }
      return completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "History before unarchive" },
        },
      ]);
    },
    archiveNativeSession: async () => undefined,
    unarchiveNativeSession: async () => undefined,
  });
  let agentId = "00000000-0000-4000-8000-000000000304";
  if (historyFails) {
    agentId = "00000000-0000-4000-8000-000000000305";
  }
  if (scenarioOptions?.internal) {
    agentId = "00000000-0000-4000-8000-000000000308";
  }
  await harness.createArchived(agentId, scenarioOptions);

  const archivedLoad = harness.load(agentId);
  await historyStarted.promise;
  await harness.manager.unarchiveSnapshot(agentId);
  const interactiveLoad = harness.load(agentId);
  historyAllowed.resolve();
  const [first, second] = await Promise.all([archivedLoad, interactiveLoad]);

  expect(first.lifecycle).toBe("idle");
  expect(second.lifecycle).toBe("idle");
  expect(harness.manager.getAgent(agentId)?.lifecycle).toBe("idle");
  expect(harness.calls.history).toHaveLength(1);
  expect(harness.calls.resumeSessionIds).toHaveLength(1);
  return { harness, agentId };
}

test("promotes a shared archived history read to interactive resume after unarchive", async () => {
  const { harness, agentId } = await runConcurrentUnarchiveScenario(false);
  expect(harness.manager.getTimeline(agentId)).toContainEqual({
    type: "assistant_message",
    text: "History before unarchive",
  });
});

test("promotes to interactive resume when archived history fails after unarchive", async () => {
  await runConcurrentUnarchiveScenario(true);
});

test("does not retain archived history state when the provider read fails", async () => {
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      throw new Error("archived history is unavailable");
    },
  });
  const agentId = "00000000-0000-4000-8000-000000000309";
  await harness.createArchived(agentId);

  await expect(harness.load(agentId)).rejects.toThrow("archived history is unavailable");

  expect(harness.manager.getHistorySnapshot(agentId)).toBeNull();
  expect(() => harness.manager.fetchTimeline(agentId)).toThrow(`Unknown agent '${agentId}'`);
  expect(harness.manager.getAgent(agentId)).toBeNull();
});

test("discards archived history state when the record is deleted during the read", async () => {
  const historyStarted = deferred();
  const historyAllowed = deferred();
  onTestFinished(() => historyAllowed.resolve());
  const harness = await createLoaderHarness({
    readSessionHistory: async () => {
      historyStarted.resolve();
      await historyAllowed.promise;
      return completeHistory([
        {
          type: "timeline",
          provider: "codex",
          item: { type: "assistant_message", text: "History deleted during read" },
        },
      ]);
    },
  });
  const agentId = "00000000-0000-4000-8000-000000000310";
  await harness.createArchived(agentId);

  const load = harness.load(agentId);
  await historyStarted.promise;
  await harness.storage.remove(agentId);
  await harness.manager.deleteAgentState(agentId);
  historyAllowed.resolve();

  await expect(load).rejects.toThrow(`Agent not found: ${agentId}`);
  expect(harness.manager.getHistorySnapshot(agentId)).toBeNull();
  expect(harness.manager.getAgent(agentId)).toBeNull();
  expect(() => harness.manager.fetchTimeline(agentId)).toThrow(`Unknown agent '${agentId}'`);
  await expect(harness.load(agentId)).rejects.toThrow(`Agent not found: ${agentId}`);
});

test("preserves internal visibility when archived history is promoted after unarchive", async () => {
  const { harness, agentId } = await runConcurrentUnarchiveScenario(false, { internal: true });

  expect(harness.manager.getAgent(agentId)?.internal).toBe(true);
  expect(harness.manager.listAgents().map((agent) => agent.id)).not.toContain(agentId);

  await harness.manager.closeAgent(agentId);
});

test("does not create an interactive session for an archived record without persistence", async () => {
  const harness = await createLoaderHarness({ archiveNativeSession: async () => undefined });
  const agentId = "00000000-0000-4000-8000-000000000306";
  await harness.createArchived(agentId);
  const archivedRecord = await harness.storage.get(agentId);
  if (!archivedRecord) {
    throw new Error("expected archived record");
  }
  await harness.storage.upsert({ ...archivedRecord, persistence: undefined });
  const createCountBeforeLoad = harness.calls.createCount;

  await expect(harness.load(agentId)).rejects.toThrow(
    `Archived agent history is unavailable without persistence: ${agentId}`,
  );
  expect(harness.calls.createCount).toBe(createCountBeforeLoad);
  expect(harness.calls.resumeSessionIds).toEqual([]);
  expect(harness.calls.history).toEqual([]);
  expect(harness.manager.getAgent(agentId)).toBeNull();
});
