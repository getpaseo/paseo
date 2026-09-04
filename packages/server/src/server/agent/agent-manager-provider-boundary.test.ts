import type {
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
  ProviderTimelineItem,
} from "@getpaseo/plugin/provider";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { describe, expect, it } from "vitest";
import { AgentManager, type AgentManagerEvent } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { startAgentRun } from "./agent-prompt.js";
import { ProviderRuntime } from "./provider-connection-runtime.js";
import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";

const ROOT_ID = "00000000-0000-4000-8000-000000000001";
const CHILD_PROVIDER_ID = "toolu_native-child";

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class HeldRegistrationStorage extends AgentStorage {
  private gate: { entered: Deferred<void>; release: Deferred<void> } | null = null;

  holdNextGet(): { entered: Promise<void>; release(): void } {
    const entered = deferred<void>();
    const release = deferred<void>();
    this.gate = { entered, release };
    return { entered: entered.promise, release: () => release.resolve() };
  }

  override async get(agentId: string) {
    const gate = this.gate;
    if (gate) {
      this.gate = null;
      gate.entered.resolve();
      await gate.release.promise;
    }
    return await super.get(agentId);
  }
}

function rootChildren(manager: AgentManager) {
  return manager.listAgents().filter((agent) => agent.labels[PARENT_AGENT_ID_LABEL] === ROOT_ID);
}

function provider(
  replay: readonly ProviderTimelineItem[] = [],
  afterRootReady?: (emit: (event: ProviderEvent) => void, sessionId: string) => void,
): {
  registration: ProviderRegistration;
  inputs: ProviderInput[];
  emit(event: ProviderEvent): void;
} {
  const inputs: ProviderInput[] = [];
  let connectionEmit: ((event: ProviderEvent) => void) | null = null;
  const registration: ProviderRegistration = {
    id: "boundary",
    label: "Boundary",
    async connect() {
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };
      connectionEmit = emit;
      return {
        version: 1,
        capabilities: [
          "prompt.message",
          "prompt.command",
          "session.persistence",
          "session.reload",
          "session.revert.conversation",
          "session.subsession",
        ],
        async send(input) {
          inputs.push(input);
          if (input.type === "session.open") {
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities: [
                "prompt.message",
                "prompt.command",
                "session.persistence",
                "session.reload",
                "session.revert.conversation",
                "session.subsession",
              ],
              restoration: "core",
              persistence: { version: 1, data: { id: input.sessionId } },
              cwd: input.config.cwd,
            });
            emit({
              type: "session.config",
              sessionId: input.sessionId,
              config: {
                model: input.config.model,
                models: [{ id: "model-1", label: "Model 1" }],
                modes: [],
                thinkingOptions: [],
                settings: [],
              },
            });
            for (const item of replay) {
              emit({ type: "timeline.item", sessionId: input.sessionId, item });
            }
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
            afterRootReady?.(emit, input.sessionId);
          } else if (input.type === "session.reload") {
            if (input.config.model === "broken") {
              emit({
                type: "request.failed",
                requestId: input.requestId,
                error: { message: "reload rejected" },
              });
            } else {
              emit({
                type: "session.opened",
                requestId: input.requestId,
                sessionId: input.sessionId,
                capabilities: [
                  "prompt.message",
                  "prompt.command",
                  "session.persistence",
                  "session.reload",
                  "session.revert.conversation",
                  "session.subsession",
                ],
                restoration: "core",
                persistence: { version: 1, data: { id: input.sessionId } },
                cwd: input.config.cwd,
              });
              emit({
                type: "session.config",
                sessionId: input.sessionId,
                config: {
                  model: input.config.model,
                  models: [{ id: "model-1", label: "Model 1" }],
                  modes: [],
                  thinkingOptions: [],
                  settings: [],
                },
              });
              emit({
                type: "session.ready",
                requestId: input.requestId,
                sessionId: input.sessionId,
              });
            }
          } else if (input.type === "session.prompt") {
            if (input.prompt.input.type === "command") {
              emit({
                type: "session.prompt_result",
                sessionId: input.sessionId,
                clientMessageId: input.prompt.clientMessageId,
                result: { type: "completed" },
              });
              return;
            }
            emit({
              type: "session.prompt_result",
              sessionId: input.sessionId,
              clientMessageId: input.prompt.clientMessageId,
              result: { type: "turn", turnId: "turn-1" },
            });
            emit({
              type: "session.turn",
              sessionId: input.sessionId,
              turnId: "turn-1",
              state: "started",
            });
            const promptText =
              input.prompt.input.type === "message"
                ? input.prompt.input.content
                    .filter((part) => part.type === "text")
                    .map((part) => part.text)
                    .join("\n")
                : input.prompt.input.name;
            emit({
              type: "timeline.item",
              sessionId: input.sessionId,
              item: { type: "assistant_message", id: "answer-1", text: "boundary answer" },
            });
            emit({
              type: "session.opened",
              sessionId: CHILD_PROVIDER_ID,
              parentSessionId: input.sessionId,
              capabilities: [],
              restoration: "parent",
              persistence: { version: 1, data: { nativeId: CHILD_PROVIDER_ID } },
              cwd: input.sessionId,
            });
            emit({
              type: "timeline.item",
              sessionId: CHILD_PROVIDER_ID,
              item: { type: "assistant_message", id: "child-answer", text: "child answer" },
            });
            if (promptText !== "long") {
              emit({
                type: "session.turn",
                sessionId: input.sessionId,
                turnId: "turn-1",
                state: "completed",
              });
            }
          } else if (input.type === "session.interrupt") {
            emit({
              type: "session.turn",
              sessionId: input.sessionId,
              turnId: "turn-1",
              state: "canceled",
            });
            emit({ type: "request.completed", requestId: input.requestId });
          } else if (input.type === "session.revert") {
            emit({ type: "request.completed", requestId: input.requestId });
          } else if (input.type === "session.close") {
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
          }
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {},
      };
    },
  };
  return {
    registration,
    inputs,
    emit(event) {
      if (!connectionEmit) throw new Error("Provider is not connected");
      connectionEmit(event);
    },
  };
}

function normalizingConfigProvider(): ProviderRegistration {
  return {
    id: "boundary",
    label: "Boundary",
    async connect() {
      const listeners = new Set<(event: ProviderEvent) => void>();
      const emit = (event: ProviderEvent) => {
        for (const listener of listeners) listener(event);
      };
      const config = (sessionId: string): ProviderEvent => ({
        type: "session.config",
        sessionId,
        config: {
          model: "canonical",
          models: [{ id: "canonical", aliases: ["alias"], label: "Canonical" }],
          modes: [{ id: "requested-mode", label: "Requested mode" }],
          thinkingOptions: [],
          settings: [{ type: "toggle", id: "fast_mode", label: "Fast", value: false }],
        },
      });
      return {
        version: 1,
        capabilities: ["prompt.message", "session.configure", "session.reload"],
        async send(input) {
          if (input.type === "session.open") {
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities: ["prompt.message", "session.configure", "session.reload"],
              restoration: "core",
              cwd: input.config.cwd,
            });
            emit(config(input.sessionId));
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          } else if (input.type === "session.configure") {
            emit(config(input.sessionId));
            emit({ type: "request.completed", requestId: input.requestId });
          } else if (input.type === "session.reload") {
            emit({
              type: "session.opened",
              requestId: input.requestId,
              sessionId: input.sessionId,
              capabilities: ["prompt.message", "session.configure", "session.reload"],
              restoration: "core",
              cwd: input.config.cwd,
            });
            emit(config(input.sessionId));
            emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
          } else if (input.type === "session.close") {
            emit({ type: "session.closed", sessionId: input.sessionId });
            emit({ type: "request.completed", requestId: input.requestId });
          }
        },
        onEvent(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        async close() {},
      };
    },
  };
}

class DurableTimelineStore implements AgentTimelineStore {
  private readonly memory = new InMemoryAgentTimelineStore();

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    this.ensure(agentId);
    return this.memory.append(agentId, item, options);
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    this.ensure(agentId);
    return this.memory.fetch(agentId, options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    return this.memory.has(agentId) ? (this.memory.getRows(agentId).at(-1)?.seq ?? 0) : 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    return this.memory.has(agentId) ? this.memory.getRows(agentId) : [];
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    return this.memory.has(agentId) ? this.memory.getLastItem(agentId) : null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    return this.memory.has(agentId) ? this.memory.getLastAssistantMessage(agentId) : null;
  }

  async deleteAgent(agentId: string): Promise<void> {
    if (this.memory.has(agentId)) this.memory.delete(agentId);
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    this.upsert(agentId, rows);
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    this.upsert(agentId, [row]);
  }

  private ensure(agentId: string): void {
    if (!this.memory.has(agentId)) this.memory.initialize(agentId);
  }

  private upsert(agentId: string, rows: readonly AgentTimelineRow[]): void {
    this.ensure(agentId);
    const bySeq = new Map(this.memory.getRows(agentId).map((row) => [row.seq, row]));
    for (const row of rows) bySeq.set(row.seq, { ...row });
    const current = [...bySeq.values()].sort((left, right) => left.seq - right.seq);
    this.memory.initialize(agentId, {
      rows: current,
      nextSeq: (current.at(-1)?.seq ?? 0) + 1,
    });
  }
}

describe("AgentManager provider boundary", () => {
  const snapshots: ProviderTimelineItem[] = [
    { type: "assistant_message", id: "text-1", text: "hel" },
    { type: "assistant_message", id: "text-1", text: "hello" },
    {
      type: "tool_call",
      id: "tool-1",
      callId: "tool-1",
      name: "read",
      status: "running",
      detail: { type: "read", filePath: "/repo/a.ts" },
      error: null,
    },
    {
      type: "tool_call",
      id: "tool-1",
      callId: "tool-1",
      name: "read",
      status: "completed",
      detail: { type: "read", filePath: "/repo/b.ts" },
      error: null,
    },
    {
      type: "todo",
      id: "todo-1",
      items: [{ id: "task-1", text: "first", completed: false }],
    },
    {
      type: "todo",
      id: "todo-1",
      items: [{ id: "task-1", text: "updated", completed: true }],
    },
    {
      type: "plugin",
      id: "plugin-1",
      pluginId: "boundary",
      kind: "card",
      version: 1,
      data: { value: "first" },
    },
    {
      type: "plugin",
      id: "plugin-1",
      pluginId: "boundary",
      kind: "card",
      version: 1,
      data: { value: "updated" },
    },
  ];

  function expectCurrentSnapshots(manager: AgentManager): void {
    expect(manager.getTimeline(ROOT_ID)).toEqual([
      { type: "assistant_message", text: "hello" },
      {
        type: "tool_call",
        callId: "tool-1",
        name: "read",
        status: "completed",
        detail: { type: "read", filePath: "/repo/b.ts" },
        error: null,
      },
      {
        type: "todo",
        items: [{ id: "task-1", text: "updated", completed: true }],
      },
      {
        type: "plugin",
        id: "plugin-1",
        pluginId: "boundary",
        kind: "card",
        version: 1,
        data: { value: "updated" },
      },
    ]);
  }

  it("stores whole current snapshots by boundary item ID during live delivery", async () => {
    const controlled = provider();
    const manager = new AgentManager({
      providers: { boundary: new ProviderRuntime(controlled.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      logger: pino({ level: "silent" }),
      agentStreamCoalesceWindowMs: 0,
    });
    await manager.createAgent(
      { provider: "boundary", cwd: process.cwd(), model: "model-1" },
      ROOT_ID,
      {
        workspaceId: undefined,
      },
    );

    for (const item of snapshots) {
      controlled.emit({ type: "timeline.item", sessionId: ROOT_ID, item });
    }
    await expect.poll(() => manager.getTimeline(ROOT_ID).length).toBe(4);

    expectCurrentSnapshots(manager);
  });

  it("advances the cursor and publishes revision metadata for stable-ID replacements", async () => {
    const controlled = provider();
    const manager = new AgentManager({
      providers: { boundary: new ProviderRuntime(controlled.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      logger: pino({ level: "silent" }),
      agentStreamCoalesceWindowMs: 0,
    });
    await manager.createAgent(
      { provider: "boundary", cwd: process.cwd(), model: "model-1" },
      ROOT_ID,
      { workspaceId: undefined },
    );
    const liveRows: Array<Extract<AgentManagerEvent, { type: "agent_stream" }>> = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_stream" && event.event.type === "timeline") {
          liveRows.push(event);
        }
      },
      { agentId: ROOT_ID, replayState: false },
    );

    controlled.emit({
      type: "timeline.item",
      sessionId: ROOT_ID,
      item: { type: "assistant_message", id: "answer", text: "draft" },
    });
    await manager.flush();
    await expect.poll(() => manager.fetchTimeline(ROOT_ID).window.maxSeq).toBe(1);
    const cursor = { epoch: manager.fetchTimeline(ROOT_ID).epoch, seq: 1 };

    controlled.emit({
      type: "timeline.item",
      sessionId: ROOT_ID,
      item: { type: "assistant_message", id: "answer", text: "final" },
    });
    await manager.flush();
    await expect.poll(() => manager.fetchTimeline(ROOT_ID).window.maxSeq).toBe(2);

    const after = manager.fetchTimeline(ROOT_ID, { direction: "after", cursor, limit: 0 });
    expect(after.rows).toEqual([
      expect.objectContaining({
        seq: 2,
        providerTimelineItemId: "answer",
        item: { type: "assistant_message", text: "final" },
      }),
    ]);
    expect(manager.getTimeline(ROOT_ID)).toEqual([{ type: "assistant_message", text: "final" }]);
    expect(liveRows.at(-1)).toMatchObject({ seq: 2, epoch: cursor.epoch });
  });

  it("keeps provider-normalized composer config visible and persisted across configure and reload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-committed-provider-config-"));
    const storage = new AgentStorage(join(directory, "agents"), pino({ level: "silent" }));
    const manager = new AgentManager({
      providers: { boundary: new ProviderRuntime(normalizingConfigProvider()) },
      providerDefinitions: { boundary: { enabled: true } },
      registry: storage,
      logger: pino({ level: "silent" }),
    });
    try {
      const created = await manager.createAgent(
        {
          provider: "boundary",
          cwd: directory,
          model: "alias",
          modeId: "requested-mode",
          featureValues: { fast_mode: true },
        },
        ROOT_ID,
        { workspaceId: undefined },
      );
      expect(created.config).toMatchObject({
        model: "canonical",
        featureValues: { fast_mode: false },
      });
      expect(created.config.modeId).toBeUndefined();
      expect(created.currentModeId).toBeNull();

      await manager.setAgentModel(ROOT_ID, "alias");
      await manager.setAgentMode(ROOT_ID, "requested-mode");
      await manager.setAgentFeature(ROOT_ID, "fast_mode", true);
      const reloaded = await manager.reloadAgentSession(ROOT_ID, {
        model: "alias",
        modeId: "requested-mode",
        featureValues: { fast_mode: true },
      });
      await manager.flush();

      expect(reloaded.config).toMatchObject({
        model: "canonical",
        featureValues: { fast_mode: false },
      });
      expect(reloaded.config.modeId).toBeUndefined();
      expect(reloaded.currentModeId).toBeNull();
      expect(reloaded.runtimeInfo).toMatchObject({ model: "canonical", modeId: null });
      const persisted = await storage.get(ROOT_ID);
      expect(persisted?.config).toMatchObject({
        model: "canonical",
        featureValues: { fast_mode: false },
      });
      expect(persisted?.config?.modeId).toBeUndefined();
      expect(persisted?.lastModeId).toBeNull();
    } finally {
      await manager.closeAgent(ROOT_ID).catch(() => undefined);
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("stores whole current snapshots by boundary item ID during replay", async () => {
    const controlled = provider(snapshots);
    const manager = new AgentManager({
      providers: { boundary: new ProviderRuntime(controlled.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      logger: pino({ level: "silent" }),
      agentStreamCoalesceWindowMs: 0,
    });
    await manager.resumeAgentFromPersistence(
      { provider: "boundary", sessionId: ROOT_ID },
      { cwd: process.cwd(), model: "model-1" },
      ROOT_ID,
    );
    await manager.hydrateTimelineFromProvider(ROOT_ID);

    expectCurrentSnapshots(manager);
  });

  it("restores an opaque object revert token durably and returns it unchanged", async () => {
    const token = { cursor: ["native", 7], checkpoint: { generation: 3 } };
    const durableTimelineStore = new DurableTimelineStore();
    const first = provider();
    const firstManager = new AgentManager({
      providers: { boundary: new ProviderRuntime(first.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      durableTimelineStore,
      logger: pino({ level: "silent" }),
      agentStreamCoalesceWindowMs: 0,
    });
    await firstManager.createAgent(
      { provider: "boundary", cwd: process.cwd(), model: "model-1" },
      ROOT_ID,
      { workspaceId: undefined },
    );
    first.emit({
      type: "timeline.item",
      sessionId: ROOT_ID,
      item: {
        type: "user_message",
        id: "provider-user-1",
        messageId: "visible-user-1",
        text: "restore me",
        revertToken: token,
      },
    });
    await expect.poll(() => firstManager.getTimeline(ROOT_ID).length).toBe(1);
    await firstManager.flush();
    await firstManager.closeAgent(ROOT_ID);

    const second = provider();
    const secondManager = new AgentManager({
      providers: { boundary: new ProviderRuntime(second.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      durableTimelineStore,
      logger: pino({ level: "silent" }),
      agentStreamCoalesceWindowMs: 0,
    });
    await secondManager.resumeAgentFromPersistence(
      { provider: "boundary", sessionId: ROOT_ID },
      { cwd: process.cwd(), model: "model-1" },
      ROOT_ID,
    );

    await secondManager.rewind(ROOT_ID, "visible-user-1", "conversation");

    expect(second.inputs).toContainEqual(
      expect.objectContaining({ type: "session.revert", token }),
    );
  });

  it("durably removes an opaque revert token when its replacement omits it", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paseo-provider-timeline-restart-"));
    const token = { cursor: ["native", 19], checkpoint: { generation: 4 } };
    try {
      const firstProvider = provider();
      const firstManager = new AgentManager({
        providers: { boundary: new ProviderRuntime(firstProvider.registration) },
        providerDefinitions: { boundary: { enabled: true } },
        durableTimelineStore: new FileAgentTimelineStore(join(directory, "timelines")),
        logger: pino({ level: "silent" }),
        agentStreamCoalesceWindowMs: 0,
      });
      await firstManager.createAgent(
        { provider: "boundary", cwd: directory, model: "model-1" },
        ROOT_ID,
        { workspaceId: undefined },
      );
      firstProvider.emit({
        type: "timeline.item",
        sessionId: ROOT_ID,
        item: {
          type: "user_message",
          id: "durable-user",
          messageId: "visible-durable-user",
          text: "draft snapshot",
          revertToken: token,
        },
      });
      firstProvider.emit({
        type: "timeline.item",
        sessionId: ROOT_ID,
        item: {
          type: "user_message",
          id: "durable-user",
          messageId: "visible-durable-user",
          text: "current snapshot",
        },
      });
      await expect.poll(() => firstManager.getTimeline(ROOT_ID)[0]?.text).toBe("current snapshot");
      await firstManager.flush();
      await firstManager.closeAgent(ROOT_ID);

      const restartedProvider = provider();
      const restartedManager = new AgentManager({
        providers: { boundary: new ProviderRuntime(restartedProvider.registration) },
        providerDefinitions: { boundary: { enabled: true } },
        durableTimelineStore: new FileAgentTimelineStore(join(directory, "timelines")),
        logger: pino({ level: "silent" }),
        agentStreamCoalesceWindowMs: 0,
      });
      await restartedManager.resumeAgentFromPersistence(
        { provider: "boundary", sessionId: ROOT_ID },
        { cwd: directory, model: "model-1" },
        ROOT_ID,
      );

      expect(restartedManager.getTimeline(ROOT_ID)).toEqual([
        {
          type: "user_message",
          messageId: "visible-durable-user",
          text: "current snapshot",
        },
      ]);
      await expect(
        restartedManager.rewind(ROOT_ID, "visible-durable-user", "conversation"),
      ).rejects.toThrow("did not supply a revert token");
      expect(restartedProvider.inputs.some((input) => input.type === "session.revert")).toBe(false);
      await restartedManager.closeAgent(ROOT_ID);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("refuses revert when the canonical item has no provider token", async () => {
    const controlled = provider();
    const manager = new AgentManager({
      providers: { boundary: new ProviderRuntime(controlled.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      logger: pino({ level: "silent" }),
      agentStreamCoalesceWindowMs: 0,
    });
    await manager.createAgent(
      { provider: "boundary", cwd: process.cwd(), model: "model-1" },
      ROOT_ID,
      { workspaceId: undefined },
    );
    controlled.emit({
      type: "timeline.item",
      sessionId: ROOT_ID,
      item: {
        type: "user_message",
        id: "provider-user-without-token",
        messageId: "visible-user-without-token",
        text: "cannot revert",
      },
    });
    await expect.poll(() => manager.getTimeline(ROOT_ID).length).toBe(1);

    await expect(
      manager.rewind(ROOT_ID, "visible-user-without-token", "conversation"),
    ).rejects.toThrow("did not supply a revert token");
    expect(controlled.inputs.some((input) => input.type === "session.revert")).toBe(false);
  });

  it("settles a completed command without fabricating a turn", async () => {
    const controlled = provider();
    const manager = new AgentManager({
      providers: { boundary: new ProviderRuntime(controlled.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      logger: pino({ level: "silent" }),
      agentStreamCoalesceWindowMs: 0,
    });
    await manager.createAgent(
      { provider: "boundary", cwd: process.cwd(), model: "model-1" },
      ROOT_ID,
      { workspaceId: undefined },
    );
    const streamEventTypes: string[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_stream") streamEventTypes.push(event.event.type);
      },
      { agentId: ROOT_ID, replayState: false },
    );

    await expect(
      startAgentRun(manager, ROOT_ID, "/reset", pino({ level: "silent" }), {
        runOptions: { clientMessageId: "command-1" },
      }),
    ).resolves.toEqual({ disposition: "completed" });
    expect(manager.getAgent(ROOT_ID)?.lifecycle).toBe("idle");
    expect(manager.hasInFlightRun(ROOT_ID)).toBe(false);
    expect(streamEventTypes).not.toContain("turn_started");
  });

  it("runs and reloads through ProviderConnection while registering provider children as agents", async () => {
    const controlled = provider();
    const manager = new AgentManager({
      providers: { boundary: new ProviderRuntime(controlled.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      logger: pino({ level: "silent" }),
      agentStreamCoalesceWindowMs: 0,
    });
    const created = await manager.createAgent(
      { provider: "boundary", cwd: process.cwd(), model: "model-1" },
      ROOT_ID,
      { workspaceId: undefined },
    );
    const originalSession = created.session;

    await expect(
      manager.runAgent(ROOT_ID, "hello", { clientMessageId: "client-1" }),
    ).resolves.toMatchObject({
      finalText: "boundary answer",
    });
    await expect.poll(() => rootChildren(manager)).toHaveLength(1);
    const child = rootChildren(manager)[0]!;
    expect(child.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(child.id).not.toBe(CHILD_PROVIDER_ID);
    expect(child.persistence).toBeNull();
    expect(manager.getAgent(CHILD_PROVIDER_ID)).toBeNull();
    await manager.hydrateTimelineFromProvider(child.id);
    expect(manager.getTimeline(child.id)).toContainEqual(
      expect.objectContaining({ type: "assistant_message", text: "child answer" }),
    );

    await expect(manager.reloadAgentSession(ROOT_ID, { model: "broken" })).rejects.toThrow(
      "reload rejected",
    );
    expect(manager.getAgent(ROOT_ID)?.session).toBe(originalSession);
    expect(manager.getAgent(ROOT_ID)?.config.model).toBe("model-1");

    await manager.reloadAgentSession(ROOT_ID, { model: "model-2" });
    expect(manager.getAgent(ROOT_ID)?.session).toBe(originalSession);
    expect(manager.getAgent(ROOT_ID)?.config.model).toBe("model-2");
    expect(controlled.inputs.map((input) => input.type)).toContain("session.reload");
  });

  it.each(["session.closed", "session.runtime_failed"] as const)(
    "preserves a child %s emitted while child registration is awaiting storage",
    async (terminalType) => {
      const directory = mkdtempSync(join(tmpdir(), "paseo-child-registration-terminal-"));
      const storage = new HeldRegistrationStorage(
        join(directory, "agents"),
        pino({ level: "silent" }),
      );
      const controlled = provider();
      const manager = new AgentManager({
        providers: { boundary: new ProviderRuntime(controlled.registration) },
        providerDefinitions: { boundary: { enabled: true } },
        registry: storage,
        logger: pino({ level: "silent" }),
      });
      const childStates: Array<Extract<AgentManagerEvent, { type: "agent_state" }>["agent"]> = [];
      manager.subscribe(
        (event) => {
          if (
            event.type === "agent_state" &&
            event.agent.labels[PARENT_AGENT_ID_LABEL] === ROOT_ID
          ) {
            childStates.push(event.agent);
          }
        },
        { replayState: false },
      );
      try {
        await manager.createAgent(
          { provider: "boundary", cwd: directory, model: "model-1" },
          ROOT_ID,
          { workspaceId: undefined },
        );
        const registration = storage.holdNextGet();
        controlled.emit({
          type: "session.opened",
          sessionId: CHILD_PROVIDER_ID,
          parentSessionId: ROOT_ID,
          capabilities: [],
          restoration: "parent",
          cwd: directory,
        });
        await registration.entered;
        controlled.emit(
          terminalType === "session.closed"
            ? { type: terminalType, sessionId: CHILD_PROVIDER_ID }
            : {
                type: terminalType,
                sessionId: CHILD_PROVIDER_ID,
                error: { message: "child process exited" },
              },
        );
        registration.release();
        await manager.flush();

        expect(childStates.at(-1)?.lifecycle).toBe(
          terminalType === "session.closed" ? "closed" : "error",
        );
        expect(rootChildren(manager).some((child) => child.lifecycle === "idle")).toBe(false);
        if (terminalType === "session.closed") expect(rootChildren(manager)).toEqual([]);
      } finally {
        for (const agent of manager.listAgents()) {
          await manager.closeAgent(agent.id).catch(() => undefined);
        }
        rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("preserves root process failure emitted immediately after session.ready", async () => {
    const controlled = provider([], (emit, sessionId) => {
      emit({
        type: "session.runtime_failed",
        sessionId,
        error: { message: "root process exited" },
      });
    });
    const manager = new AgentManager({
      providers: { boundary: new ProviderRuntime(controlled.registration) },
      providerDefinitions: { boundary: { enabled: true } },
      logger: pino({ level: "silent" }),
    });
    try {
      const created = await manager.createAgent(
        { provider: "boundary", cwd: process.cwd(), model: "model-1" },
        ROOT_ID,
        { workspaceId: undefined },
      );

      expect(created).toMatchObject({ lifecycle: "error", lastError: "root process exited" });
      expect(manager.getAgent(ROOT_ID)).toMatchObject({
        lifecycle: "error",
        lastError: "root process exited",
      });
    } finally {
      await manager.closeAgent(ROOT_ID).catch(() => undefined);
    }
  });
});
