import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import { AgentStorage, type StoredAgentRecord } from "./agent/agent-storage.js";
import {
  type AgentMessageQueueAgentManager,
  type AgentMessageQueueAgent,
  type AgentMessageQueueAgentStorage,
  AgentMessageQueueService,
  AgentMessageQueueStore,
  buildQueuedAgentPrompt,
} from "./agent-message-queue.js";

const tempDirs: string[] = [];

async function createStore(): Promise<{ dir: string; store: AgentMessageQueueStore }> {
  const dir = await mkdtemp(path.join(tmpdir(), "paseo-agent-message-queue-"));
  tempDirs.push(dir);
  return {
    dir,
    store: new AgentMessageQueueStore({
      filePath: path.join(dir, "agent-message-queue.json"),
      logger: pino({ level: "silent" }),
    }),
  };
}

function createStoredRecord(overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  const now = "2026-06-30T00:00:00.000Z";
  return {
    id: "agent-record",
    provider: "codex",
    cwd: "/workspace/project",
    createdAt: now,
    updatedAt: now,
    labels: {},
    lastStatus: "idle",
    config: null,
    persistence: null,
    ...overrides,
  };
}

function deferred<T>(): PromiseWithResolvers<T> {
  return Promise.withResolvers<T>();
}

function createQueueAgentManager(
  methods: AgentMessageQueueAgentManager,
): AgentMessageQueueAgentManager {
  return methods;
}

function createQueueAgentStorage(get: AgentStorage["get"]): AgentMessageQueueAgentStorage {
  return {
    get,
    list: async () => [],
    addAgentHardDeletedCallback: () => () => {},
  };
}

async function noopDispatch(): Promise<void> {}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

test("persists queued agent messages and exposes summary payloads", async () => {
  const { dir, store } = await createStore();

  const first = await store.enqueue({
    agentId: "agent-a",
    messageId: "queued-1",
    text: "  first message  ",
    images: [{ data: "base64-image", mimeType: "image/png" }],
    attachments: [
      {
        type: "text",
        mimeType: "text/plain",
        title: "notes.txt",
        text: "attachment body",
      },
    ],
  });
  await store.enqueue({
    agentId: "agent-a",
    messageId: "queued-2",
    text: "second message",
  });

  expect(first.text).toBe("first message");

  const reloadedStore = new AgentMessageQueueStore({
    filePath: path.join(dir, "agent-message-queue.json"),
    logger: pino({ level: "silent" }),
  });

  await expect(reloadedStore.listQueues("agent-a")).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 2,
      messages: [
        {
          id: "queued-1",
          agentId: "agent-a",
          text: "first message",
          createdAt: expect.any(String),
          images: [{ data: "base64-image", mimeType: "image/png" }],
          attachments: [
            {
              type: "text",
              mimeType: "text/plain",
              title: "notes.txt",
              text: "attachment body",
            },
          ],
          imageCount: 1,
          attachmentCount: 1,
        },
        {
          id: "queued-2",
          agentId: "agent-a",
          text: "second message",
          createdAt: expect.any(String),
          images: [],
          attachments: [],
          imageCount: 0,
          attachmentCount: 0,
        },
      ],
    },
  ]);

  await expect(readFile(path.join(dir, "agent-message-queue.json"), "utf8")).resolves.toContain(
    '"revisions"',
  );
});

test("reads legacy client ids and omits them from the next persisted state", async () => {
  const { dir, store } = await createStore();
  const filePath = path.join(dir, "agent-message-queue.json");
  await writeFile(
    filePath,
    JSON.stringify({
      version: 1,
      queues: {
        "agent-a": [
          {
            id: "queued-legacy",
            agentId: "agent-a",
            text: "legacy",
            images: [],
            attachments: [],
            createdAt: "2026-06-30T00:00:00.000Z",
            createdByClientId: "legacy-client",
          },
        ],
      },
      revisions: { "agent-a": 1 },
    }),
    "utf8",
  );

  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      agentId: "agent-a",
      revision: 1,
      messages: [{ id: "queued-legacy", text: "legacy" }],
    },
  ]);

  await store.enqueue({ agentId: "agent-a", messageId: "queued-current", text: "current" });
  await expect(readFile(filePath, "utf8")).resolves.not.toContain("createdByClientId");
});

test("remove, shift, and unshift preserve queue order", async () => {
  const { store } = await createStore();

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await store.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" });
  await store.enqueue({ agentId: "agent-a", messageId: "queued-3", text: "third" });

  await expect(store.remove("agent-a", "missing")).resolves.toBeNull();
  await expect(store.remove("agent-a", "queued-2")).resolves.toMatchObject({
    id: "queued-2",
    text: "second",
  });

  const shifted = await store.shift("agent-a");
  expect(shifted?.id).toBe("queued-1");

  if (!shifted) {
    throw new Error("Expected shifted queued message");
  }
  await store.unshift(shifted);

  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [
        { id: "queued-1", text: "first" },
        { id: "queued-3", text: "third" },
      ],
    },
  ]);

  await expect(store.shift("agent-a")).resolves.toMatchObject({ id: "queued-1" });
  await expect(store.shift("agent-a")).resolves.toMatchObject({ id: "queued-3" });
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 8,
      messages: [],
    },
  ]);
});

test("explicit message ids are idempotent while the durable record is pending", async () => {
  const { store } = await createStore();

  const first = await store.enqueue({
    agentId: "agent-a",
    messageId: "queued-1",
    text: "first",
  });
  const duplicate = await store.enqueue({
    agentId: "agent-a",
    messageId: "queued-1",
    text: "duplicate text ignored",
  });

  expect(duplicate).toEqual(first);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      agentId: "agent-a",
      revision: 1,
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);
});

test("quarantines a corrupt queue file and starts from an empty store", async () => {
  const { dir, store } = await createStore();
  await writeFile(path.join(dir, "agent-message-queue.json"), "{not-json", "utf8");

  await expect(store.listQueues()).resolves.toEqual([]);

  const entries = await readdir(dir);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatch(/^agent-message-queue\.json\.corrupt-/);
});

test("clearAgent keeps archive tombstones until delete drops them", async () => {
  const { store } = await createStore();

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await expect(store.clearAgent("agent-a")).resolves.toEqual({
    agentId: "agent-a",
    revision: 2,
    messages: [],
  });

  await expect(store.listQueues("agent-a")).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 2,
      messages: [],
    },
  ]);
  await expect(store.listQueues()).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 2,
      messages: [],
    },
  ]);

  await expect(store.clearAgent("agent-a")).resolves.toBeNull();
  await expect(store.clearAgent("agent-a", { dropRevision: true })).resolves.toEqual({
    agentId: "agent-a",
    revision: 3,
    messages: [],
  });
  await expect(store.listQueues()).resolves.toEqual([]);
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    {
      agentId: "agent-a",
      revision: 0,
      messages: [],
    },
  ]);
});

test("the daemon-global archive callback clears queued messages", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let archiveCallback:
    | Parameters<AgentMessageQueueAgentManager["addAgentArchivedCallback"]>[0]
    | null = null;
  const agentManager = {
    getAgent: () => null,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: (
      callback: Parameters<AgentMessageQueueAgentManager["addAgentArchivedCallback"]>[0],
    ) => {
      archiveCallback = callback;
      return () => {
        archiveCallback = null;
      };
    },
  } satisfies AgentMessageQueueAgentManager;
  const agentStorage = {
    get: async (agentId: string) => createStoredRecord({ id: agentId }),
    list: async () => [],
    addAgentHardDeletedCallback: () => () => {},
  } satisfies AgentMessageQueueAgentStorage;
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage: noopDispatch,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });
  await service.start();
  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  if (!archiveCallback) throw new Error("Expected archive callback registration");
  await archiveCallback("agent-a");

  await expect(store.listQueues("agent-a")).resolves.toEqual([
    { agentId: "agent-a", revision: 2, messages: [] },
  ]);
  service.stop();
});

test("startup removes orphan queues and revision tombstones durably", async () => {
  const { dir, store } = await createStore();
  const logger = pino({ level: "silent" });
  const agentStorage = new AgentStorage(path.join(dir, "agents"), logger);
  await agentStorage.initialize();
  await agentStorage.upsert(createStoredRecord({ id: "agent-stored" }));

  await store.enqueue({ agentId: "agent-orphan", messageId: "orphan-message", text: "orphan" });
  await store.enqueue({
    agentId: "agent-orphan-tombstone",
    messageId: "orphan-tombstone-message",
    text: "orphan tombstone",
  });
  await store.clearAgent("agent-orphan-tombstone");
  await store.enqueue({ agentId: "agent-stored", messageId: "stored-message", text: "stored" });
  await store.clearAgent("agent-stored");
  await store.enqueue({ agentId: "agent-live", messageId: "live-message", text: "live" });
  await store.clearAgent("agent-live");

  const liveAgent = {
    id: "agent-live",
    lifecycle: "idle",
  } satisfies AgentMessageQueueAgent;

  const updates: Array<{ agentId: string; revision: number; messageCount: number }> = [];
  const service = new AgentMessageQueueService({
    store,
    agentManager: createQueueAgentManager({
      getAgent: (agentId) => (agentId === "agent-live" ? liveAgent : undefined),
      hasInFlightRun: () => false,
      subscribeAgentState: () => () => {},
      addAgentArchivedCallback: () => () => {},
    }),
    agentStorage,
    dispatchMessage: noopDispatch,
    logger,
    onQueueUpdated: (queue) => {
      updates.push({
        agentId: queue.agentId,
        revision: queue.revision,
        messageCount: queue.messages.length,
      });
    },
  });

  await service.start();

  await expect(store.listQueues()).resolves.toEqual([
    { agentId: "agent-live", revision: 2, messages: [] },
    { agentId: "agent-stored", revision: 2, messages: [] },
  ]);
  expect(updates).toEqual([
    { agentId: "agent-orphan", revision: 2, messageCount: 0 },
    { agentId: "agent-orphan-tombstone", revision: 3, messageCount: 0 },
  ]);
  await expect(readFile(path.join(dir, "agent-message-queue.json"), "utf8")).resolves.not.toContain(
    "agent-orphan",
  );
  service.stop();
});

test("the durable agent hard-delete boundary clears queue records and tombstones", async () => {
  vi.useFakeTimers();
  const { dir, store } = await createStore();
  const logger = pino({ level: "silent" });
  const agentStorage = new AgentStorage(path.join(dir, "agents"), logger);
  await agentStorage.initialize();
  await agentStorage.upsert(createStoredRecord({ id: "agent-delete" }));
  await store.enqueue({ agentId: "agent-delete", messageId: "queued-delete", text: "delete" });

  const updates: Array<{ agentId: string; revision: number; messageCount: number }> = [];
  const service = new AgentMessageQueueService({
    store,
    agentManager: createQueueAgentManager({
      getAgent: () => undefined,
      hasInFlightRun: () => false,
      subscribeAgentState: () => () => {},
      addAgentArchivedCallback: () => () => {},
    }),
    agentStorage,
    dispatchMessage: noopDispatch,
    logger,
    onQueueUpdated: (queue) => {
      updates.push({
        agentId: queue.agentId,
        revision: queue.revision,
        messageCount: queue.messages.length,
      });
    },
  });
  await service.start();

  await agentStorage.remove("agent-delete");

  await expect(agentStorage.get("agent-delete")).resolves.toBeNull();
  await expect(store.listQueues()).resolves.toEqual([]);
  expect(updates).toEqual([{ agentId: "agent-delete", revision: 2, messageCount: 0 }]);
  await expect(readFile(path.join(dir, "agent-message-queue.json"), "utf8")).resolves.toBe(
    JSON.stringify({ version: 1, queues: {}, revisions: {} }, null, 2),
  );
  service.stop();
});

test("agent state events schedule drains only when the queue has messages", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let listener: ((agent: AgentMessageQueueAgent) => void) | null = null;
  const agentManager = createQueueAgentManager({
    getAgent: () => undefined,
    hasInFlightRun: () => false,
    subscribeAgentState: (nextListener) => {
      listener = nextListener;
      return () => {
        listener = null;
      };
    },
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = {
    get: async () => null,
    list: async () => [],
    addAgentHardDeletedCallback: () => () => {},
  } satisfies AgentMessageQueueAgentStorage;
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage: noopDispatch,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });
  await service.start();

  const agent = { id: "agent-a", lifecycle: "idle" } satisfies AgentMessageQueueAgent;
  listener?.(agent);
  await store.hasMessages("agent-a");
  expect(vi.getTimerCount()).toBe(0);

  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "queued" });
  listener?.(agent);
  await store.hasMessages("agent-a");
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(1);
  service.stop();
});

test("dispatch failure does not restore messages for non-replayable agents", async () => {
  const { store } = await createStore();
  const updates: Array<{ revision: number; messages: Array<{ id: string }> }> = [];
  const agentManager = createQueueAgentManager({
    getAgent: () => null,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async () => null);
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage: async () => {
      throw new Error("Agent not found: missing-agent");
    },
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      updates.push({
        revision: queue.revision,
        messages: queue.messages.map((message) => ({ id: message.id })),
      });
    },
  });

  await store.enqueue({ agentId: "missing-agent", messageId: "queued-1", text: "first" });

  await expect(service.dispatchNow("missing-agent", "queued-1")).rejects.toThrow(
    "Agent not found: missing-agent",
  );
  await expect(store.listQueues("missing-agent")).resolves.toEqual([
    {
      agentId: "missing-agent",
      revision: 2,
      messages: [],
    },
  ]);
  expect(updates).toEqual([{ revision: 2, messages: [] }]);
});

test("dispatch failure does not restore messages for live internal agents", async () => {
  const { store } = await createStore();
  const updates: Array<{ revision: number; messages: Array<{ id: string }> }> = [];
  const agentManager = createQueueAgentManager({
    getAgent: () =>
      ({
        id: "internal-agent",
        lifecycle: "idle",
        internal: true,
      }) satisfies AgentMessageQueueAgent,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async () => null);
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage: async () => {
      throw new Error("Cannot dispatch message to internal agent: internal-agent");
    },
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      updates.push({
        revision: queue.revision,
        messages: queue.messages.map((message) => ({ id: message.id })),
      });
    },
  });

  await store.enqueue({ agentId: "internal-agent", messageId: "queued-1", text: "first" });

  await expect(service.dispatchNow("internal-agent", "queued-1")).rejects.toThrow();
  await expect(store.listQueues("internal-agent")).resolves.toEqual([
    {
      agentId: "internal-agent",
      revision: 2,
      messages: [],
    },
  ]);
  expect(updates).toEqual([{ revision: 2, messages: [] }]);
});

test("dispatch reports archived agents without restoring messages", async () => {
  const { store } = await createStore();
  const updates: Array<{ revision: number; messages: Array<{ id: string }> }> = [];
  const agentManager = createQueueAgentManager({
    getAgent: () =>
      ({
        id: "archiving-agent",
        lifecycle: "idle",
      }) satisfies AgentMessageQueueAgent,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId: string) =>
    createStoredRecord({
      id: agentId,
      archivedAt: "2026-06-30T00:00:01.000Z",
    }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage: async () => {
      throw new Error("Queued message target agent is archived: archiving-agent");
    },
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      updates.push({
        revision: queue.revision,
        messages: queue.messages.map((message) => ({ id: message.id })),
      });
    },
  });

  await store.enqueue({ agentId: "archiving-agent", messageId: "queued-1", text: "first" });

  await expect(service.dispatchNow("archiving-agent", "queued-1")).rejects.toThrow(
    "Queued message target agent is archived: archiving-agent",
  );
  await expect(store.listQueues("archiving-agent")).resolves.toEqual([
    {
      agentId: "archiving-agent",
      revision: 2,
      messages: [],
    },
  ]);
  expect(updates).toEqual([{ revision: 2, messages: [] }]);
});

test("auto drain dispatches queued messages FIFO one idle turn at a time", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let inFlight = false;
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const dispatchMessage = vi.fn(async () => {
    inFlight = true;
  });
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => inFlight,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId) =>
    createStoredRecord({ id: agentId }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await service.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" });

  await vi.runOnlyPendingTimersAsync();

  await vi.waitFor(() => {
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });
  expect(dispatchMessage).toHaveBeenCalledWith(
    expect.objectContaining({ id: "queued-1", text: "first" }),
    { replaceRunning: false },
  );
  await vi.waitFor(async () => {
    const queues = await store.listQueues("agent-a");
    expect(queues).toMatchObject([
      {
        messages: [{ id: "queued-2", text: "second" }],
      },
    ]);
  });
});

test("auto drain requeues instead of replacing a run that starts after the availability check", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let inFlight = false;
  let sawShiftedQueue = false;
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const dispatchMessage = vi.fn(async () => {
    if (inFlight) {
      throw new Error("Agent agent-a already has an active run");
    }
  });
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => inFlight,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId) =>
    createStoredRecord({ id: agentId }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      if (queue.revision === 2 && queue.messages.length === 0) {
        sawShiftedQueue = true;
        inFlight = true;
      }
    },
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  await vi.runOnlyPendingTimersAsync();

  await vi.waitFor(() => {
    expect(sawShiftedQueue).toBe(true);
  });
  expect(sawShiftedQueue).toBe(true);
  expect(dispatchMessage).toHaveBeenCalledTimes(1);
  await vi.waitFor(async () => {
    const queues = await store.listQueues("agent-a");
    expect(queues).toMatchObject([
      {
        messages: [{ id: "queued-1", text: "first" }],
      },
    ]);
  });
});

test("dispatchNow does not replace an auto-drained message in the same dispatch window", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let inFlight = false;
  let dispatchNowResult: Promise<string> | null = null;
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const dispatchMessage = vi.fn(async () => {
    inFlight = true;
  });
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => inFlight,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId) =>
    createStoredRecord({ id: agentId }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      if (queue.revision === 3 && queue.messages.some((message) => message.id === "queued-2")) {
        dispatchNowResult ??= service.dispatchNow("agent-a", "queued-2").then(
          () => "resolved",
          (error) => (error instanceof Error ? error.message : String(error)),
        );
      }
    },
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await service.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" });

  await vi.runOnlyPendingTimersAsync();

  await vi.waitFor(() => {
    expect(dispatchNowResult).not.toBeNull();
  });
  await expect(dispatchNowResult).resolves.toBe("Agent queue is already dispatching: agent-a");
  expect(dispatchMessage).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [{ id: "queued-2", text: "second" }],
    },
  ]);
});

test("dispatchNow blocks a scheduled auto drain until the explicit dispatch finishes", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const dispatchStarted = deferred<void>();
  const releaseDispatch = deferred<void>();
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const dispatchMessage = vi.fn(async () => {
    dispatchStarted.resolve();
    await releaseDispatch.promise;
  });
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId) =>
    createStoredRecord({ id: agentId }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  await service.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" });

  const dispatchNowResult = service.dispatchNow("agent-a", "queued-1");

  await dispatchStarted.promise;
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();

  expect(dispatchMessage).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [{ id: "queued-2", text: "second" }],
    },
  ]);

  releaseDispatch.resolve();
  await expect(dispatchNowResult).resolves.toBeUndefined();
  expect(dispatchMessage).toHaveBeenCalledWith(
    expect.objectContaining({ id: "queued-1", text: "first" }),
    { replaceRunning: true },
  );
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [{ id: "queued-2", text: "second" }],
    },
  ]);
});

test("dispatchNow does not retry a delayed turn start after the former timeout", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const releaseStart = deferred<void>();
  let dispatchSettled = false;
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const dispatchMessage = vi.fn(async () => await releaseStart.promise);
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId) =>
    createStoredRecord({ id: agentId }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });
  const dispatch = service.dispatchNow("agent-a", "queued-1").finally(() => {
    dispatchSettled = true;
  });

  await vi.waitFor(() => {
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });
  await vi.advanceTimersByTimeAsync(60_000);

  expect(dispatchSettled).toBe(false);
  expect(dispatchMessage).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([{ messages: [] }]);

  releaseStart.resolve();
  await expect(dispatch).resolves.toBeUndefined();
  expect(dispatchMessage).toHaveBeenCalledTimes(1);
});

test("auto drain retries after a transient dispatch failure", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  let inFlight = false;
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const dispatchMessage = vi.fn(async () => {
    if (dispatchMessage.mock.calls.length === 1) {
      throw new Error("Transient async turn-start failure");
    }
    inFlight = true;
  });
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => inFlight,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId) =>
    createStoredRecord({ id: agentId }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  await vi.runOnlyPendingTimersAsync();
  await vi.waitFor(() => {
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);

  await vi.advanceTimersByTimeAsync(25);

  await vi.waitFor(() => {
    expect(dispatchMessage).toHaveBeenCalledTimes(2);
  });
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [],
    },
  ]);
});

test("dispatchNow durably restores a message after an asynchronous turn-start failure", async () => {
  const { store } = await createStore();
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const dispatchMessage = vi.fn(async () => {
    await Promise.resolve();
    throw new Error("Explicit async turn-start failure");
  });
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId) =>
    createStoredRecord({ id: agentId }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  await expect(service.dispatchNow("agent-a", "queued-1")).rejects.toThrow(
    "Explicit async turn-start failure",
  );
  expect(dispatchMessage).toHaveBeenCalledTimes(1);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      revision: 3,
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);
});

test("a failed persist leaves no phantom record in memory", async () => {
  const { dir, store } = await createStore();
  const filePath = path.join(dir, "agent-message-queue.json");
  await store.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  // Replacing the persisted file with a directory makes the atomic rename
  // fail on every platform after the in-memory draft has been mutated.
  await rm(filePath);
  await mkdir(filePath);

  await expect(
    store.enqueue({ agentId: "agent-a", messageId: "queued-2", text: "second" }),
  ).rejects.toThrow();

  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    { messages: [{ id: "queued-1" }] },
  ]);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    { agentId: "agent-a", revision: 1 },
  ]);
});

test("auto drain stops retrying after consecutive dispatch failures", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const agent = {
    id: "agent-a",
    lifecycle: "idle",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const dispatchMessage = vi.fn(async () => {
    throw new Error("Persistent dispatch failure");
  });
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId) =>
    createStoredRecord({ id: agentId }),
  );
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage,
    logger: pino({ level: "silent" }),
    onQueueUpdated: () => {},
  });

  await service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" });

  // One initial attempt plus one retry per remaining rung of the delay
  // ladder; afterwards the drain waits for the next agent event instead of
  // looping.
  await vi.runOnlyPendingTimersAsync();
  await vi.waitFor(() => {
    expect(dispatchMessage).toHaveBeenCalledTimes(1);
  });
  for (const [attempt, delayMs] of [25, 100, 250, 1000].entries()) {
    await vi.advanceTimersByTimeAsync(delayMs);
    await vi.waitFor(() => {
      expect(dispatchMessage).toHaveBeenCalledTimes(attempt + 2);
    });
  }

  await vi.advanceTimersByTimeAsync(60_000);
  expect(dispatchMessage).toHaveBeenCalledTimes(5);
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [{ id: "queued-1", text: "first" }],
    },
  ]);
});

test("enqueue is rejected inside the mutation when the agent is archived", async () => {
  const { store } = await createStore();
  const agentManager = createQueueAgentManager({
    getAgent: () => undefined,
    hasInFlightRun: () => false,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId: string) =>
    createStoredRecord({ id: agentId, archivedAt: "2026-06-30T00:00:00.000Z" }),
  );
  const updates: string[] = [];
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage: noopDispatch,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      updates.push(queue.agentId);
    },
  });

  await expect(
    service.enqueue({ agentId: "agent-a", messageId: "queued-1", text: "first" }),
  ).rejects.toThrow("Cannot queue message for archived agent: agent-a");

  expect(updates).toEqual([]);
  await expect(store.listQueues("agent-a")).resolves.toEqual([
    { agentId: "agent-a", revision: 0, messages: [] },
  ]);
});

test("queue update broadcasts omit image and structured attachment payloads but keep counts", async () => {
  vi.useFakeTimers();
  const { store } = await createStore();
  const agent = {
    id: "agent-a",
    lifecycle: "running",
    provider: "codex",
  } satisfies AgentMessageQueueAgent;
  const agentManager = createQueueAgentManager({
    getAgent: () => agent,
    hasInFlightRun: () => true,
    subscribeAgentState: () => () => {},
    addAgentArchivedCallback: () => () => {},
  });
  const agentStorage = createQueueAgentStorage(async (agentId: string) =>
    createStoredRecord({ id: agentId }),
  );
  const broadcasts: Array<{
    images: Array<{ data: string; mimeType: string }>;
    attachments: unknown[];
    imageCount: number;
    attachmentCount: number;
  }> = [];
  const service = new AgentMessageQueueService({
    store,
    agentManager,
    agentStorage,
    dispatchMessage: noopDispatch,
    logger: pino({ level: "silent" }),
    onQueueUpdated: (queue) => {
      for (const message of queue.messages) {
        broadcasts.push({
          images: message.images,
          attachments: message.attachments,
          imageCount: message.imageCount,
          attachmentCount: message.attachmentCount,
        });
      }
    },
  });

  await service.enqueue({
    agentId: "agent-a",
    messageId: "queued-1",
    text: "first",
    images: [{ data: "base64-image", mimeType: "image/png" }],
    attachments: [
      {
        type: "text",
        mimeType: "text/plain",
        title: "notes.txt",
        text: "attachment body",
      },
    ],
  });

  expect(broadcasts).toEqual([{ images: [], attachments: [], imageCount: 1, attachmentCount: 1 }]);
  // The store keeps the full payload for list responses and replay.
  await expect(store.listQueues("agent-a")).resolves.toMatchObject([
    {
      messages: [
        {
          images: [{ data: "base64-image", mimeType: "image/png" }],
          attachments: [{ type: "text", text: "attachment body" }],
        },
      ],
    },
  ]);
});

test("buildQueuedAgentPrompt preserves text, image, and structured attachments", () => {
  expect(
    buildQueuedAgentPrompt(
      "  replay this  ",
      [{ data: "base64-image", mimeType: "image/png" }],
      [
        {
          type: "text",
          mimeType: "text/plain",
          title: "notes.txt",
          text: "attachment body",
        },
      ],
    ),
  ).toEqual([
    { type: "text", text: "replay this" },
    { type: "image", data: "base64-image", mimeType: "image/png" },
    {
      type: "text",
      mimeType: "text/plain",
      title: "notes.txt",
      text: "attachment body",
    },
  ]);

  expect(buildQueuedAgentPrompt("  plain text  ", [], [])).toBe("plain text");
});
