import { describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import type {
  AgentClient,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
} from "./agent-sdk-types.js";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class EventPushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(value: IteratorResult<T, void>) => void> = [];
  private closed = false;

  push(value: T): void {
    if (this.closed) {
      return;
    }
    const resolver = this.resolvers.shift();
    if (resolver) {
      resolver({ value, done: false });
      return;
    }
    this.queue.push(value);
  }

  end(): void {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift();
      resolver?.({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

class TestAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new TestAgentSession(config);
  }

  async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
    return new TestAgentSession({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }
}

class TestAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private runtimeModel: string | null = null;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id ?? this.config.provider,
      finalText: "",
      timeline: [],
    };
  }

  async *stream(): AsyncGenerator<AgentStreamEvent> {
    yield { type: "turn_started", provider: this.provider };
    yield { type: "turn_completed", provider: this.provider };
    this.runtimeModel = "gpt-5.2-codex";
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.runtimeModel ?? this.config.model ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes() {
    return [];
  }

  async getCurrentMode() {
    return null;
  }

  async setMode(): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence() {
    return {
      provider: this.provider,
      sessionId: this.id,
    };
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {}
}

describe("AgentManager", () => {
  const logger = createTestLogger();

  test("normalizeConfig does not inject default model when omitted", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000101",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    expect(snapshot.model).toBeUndefined();
  });

  test("normalizeConfig strips legacy 'default' model id", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000102",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      model: "default",
    });

    expect(snapshot.model).toBeUndefined();
  });

  test("createAgent fails when cwd does not exist", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
    });

    await expect(
      manager.createAgent({
        provider: "codex",
        cwd: join(workdir, "does-not-exist"),
      })
    ).rejects.toThrow("Working directory does not exist");
  });

  test("resumeAgentFromPersistence keeps metadata config and applies systemPrompt/mcpServers overrides", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-resume-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class ResumeCaptureClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      lastResumeOverrides: Partial<AgentSessionConfig> | undefined;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new TestAgentSession(config);
      }

      async resumeSession(
        handle: AgentPersistenceHandle,
        overrides?: Partial<AgentSessionConfig>
      ): Promise<AgentSession> {
        this.lastResumeOverrides = overrides;
        const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
        const merged: AgentSessionConfig = {
          ...metadata,
          ...overrides,
          provider: "codex",
          cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
        };
        return new TestAgentSession(merged);
      }
    }

    const client = new ResumeCaptureClient();
    const manager = new AgentManager({
      clients: {
        codex: client,
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000106",
    });

    const handle: AgentPersistenceHandle = {
      provider: "codex",
      sessionId: "resume-session-1",
      metadata: {
        provider: "codex",
        cwd: workdir,
        systemPrompt: "old prompt",
        mcpServers: {
          legacy: {
            type: "stdio",
            command: "legacy-bridge",
            args: ["/tmp/legacy.sock"],
          },
        },
      },
    };

    const resumed = await manager.resumeAgentFromPersistence(handle, {
      cwd: workdir,
      systemPrompt: "new prompt",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "node",
          args: ["/tmp/mcp-bridge.mjs", "--socket", "/tmp/paseo.sock"],
        },
      },
    });

    expect(resumed.config.systemPrompt).toBe("new prompt");
    expect(resumed.config.mcpServers).toEqual({
      paseo: {
        type: "stdio",
        command: "node",
        args: ["/tmp/mcp-bridge.mjs", "--socket", "/tmp/paseo.sock"],
      },
    });
    expect(client.lastResumeOverrides).toMatchObject({
      systemPrompt: "new prompt",
      mcpServers: {
        paseo: {
          type: "stdio",
          command: "node",
          args: ["/tmp/mcp-bridge.mjs", "--socket", "/tmp/paseo.sock"],
        },
      },
    });
  });

  test("reloadAgentSession preserves timeline and does not force history replay", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class HistoryProbeSession extends TestAgentSession {
      constructor(
        config: AgentSessionConfig,
        private readonly historyText: string | null
      ) {
        super(config);
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        if (!this.historyText) {
          return;
        }
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: this.historyText },
        };
      }
    }

    class HistoryProbeClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new HistoryProbeSession(config, null);
      }

      async resumeSession(
        handle: AgentPersistenceHandle,
        overrides?: Partial<AgentSessionConfig>
      ): Promise<AgentSession> {
        const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
        const merged: AgentSessionConfig = {
          ...metadata,
          ...overrides,
          provider: "codex",
          cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
        };
        return new HistoryProbeSession(merged, "history replay from provider");
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new HistoryProbeClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000113",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "keep this timeline in memory",
    });
    await manager.hydrateTimelineFromProvider(snapshot.id);
    const beforeReload = manager.getTimeline(snapshot.id);
    expect(beforeReload).toHaveLength(1);

    await manager.reloadAgentSession(snapshot.id, {
      systemPrompt: "reloaded prompt",
    });
    const afterReload = manager.getTimeline(snapshot.id);
    expect(afterReload).toEqual(beforeReload);

    // If reload resets historyPrimed, this would replay provider history and append another item.
    await manager.hydrateTimelineFromProvider(snapshot.id);
    const afterHydrate = manager.getTimeline(snapshot.id);
    expect(afterHydrate).toEqual(beforeReload);
  });

  test("reloadAgentSession preserves current title when config title is unset", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-title-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000126",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });
    await manager.setTitle(snapshot.id, "Generated title");

    const beforeReload = await storage.get(snapshot.id);
    expect(beforeReload?.title).toBe("Generated title");
    expect(beforeReload?.config?.title).toBeUndefined();

    await manager.reloadAgentSession(snapshot.id);

    const afterReload = await storage.get(snapshot.id);
    expect(afterReload?.title).toBe("Generated title");
    expect(afterReload?.config?.title).toBeUndefined();
  });

  test("setTitle bumps updatedAt and persists title in the same snapshot write", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-set-title-updated-at-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000127",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const before = await storage.get(snapshot.id);
    expect(before).not.toBeNull();

    await manager.setTitle(snapshot.id, "Generated title");

    const after = await storage.get(snapshot.id);
    expect(after?.title).toBe("Generated title");
    expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));

    const live = manager.getAgent(snapshot.id);
    expect(live).not.toBeNull();
    expect(live!.updatedAt.getTime()).toBeGreaterThan(Date.parse(before!.updatedAt));
  });

  test("reloadAgentSession cancels active run and resumes existing session once thread_started is observed", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-active-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class DelayedPersistenceSession extends TestAgentSession {
      private persistenceReady = false;
      private interrupted = false;
      private releaseGate: (() => void) | null = null;
      private readonly gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve;
      });

      constructor(
        config: AgentSessionConfig,
        private readonly stableSessionId: string,
        initiallyReady = false
      ) {
        super(config);
        this.persistenceReady = initiallyReady;
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        this.persistenceReady = true;
        yield {
          type: "thread_started",
          provider: this.provider,
          sessionId: this.stableSessionId,
        };
        await this.gate;
        if (this.interrupted) {
          yield { type: "turn_canceled", provider: this.provider, reason: "Interrupted" };
          return;
        }
        yield { type: "turn_completed", provider: this.provider };
      }

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.persistenceReady ? this.stableSessionId : null,
          model: null,
          modeId: null,
        };
      }

      describePersistence() {
        if (!this.persistenceReady) {
          return null;
        }
        return {
          provider: this.provider,
          sessionId: this.stableSessionId,
        };
      }

      async interrupt(): Promise<void> {
        this.interrupted = true;
        this.releaseGate?.();
      }

      async close(): Promise<void> {
        this.interrupted = true;
        this.releaseGate?.();
      }
    }

    class DelayedPersistenceClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      createSessionCalls = 0;
      resumeSessionCalls = 0;
      private nextSessionNumber = 1;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        const sessionId = `delayed-session-${this.nextSessionNumber++}`;
        this.createSessionCalls += 1;
        return new DelayedPersistenceSession(config, sessionId);
      }

      async resumeSession(
        handle: AgentPersistenceHandle,
        overrides?: Partial<AgentSessionConfig>
      ): Promise<AgentSession> {
        this.resumeSessionCalls += 1;
        const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
        const merged: AgentSessionConfig = {
          ...metadata,
          ...overrides,
          provider: "codex",
          cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
        };
        return new DelayedPersistenceSession(merged, handle.sessionId, true);
      }
    }

    const client = new DelayedPersistenceClient();
    const manager = new AgentManager({
      clients: { codex: client },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000114",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });
    expect(snapshot.persistence).toBeNull();

    const stream = manager.streamAgent(snapshot.id, "hello");
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.type).toBe("turn_started");
    const second = await stream.next();
    expect(second.done).toBe(false);
    expect(second.value?.type).toBe("thread_started");

    const active = manager.getAgent(snapshot.id);
    expect(active?.lifecycle).toBe("running");
    expect(active?.persistence?.sessionId).toBe("delayed-session-1");

    const reloaded = await manager.reloadAgentSession(snapshot.id, {
      systemPrompt: "voice mode on",
    });

    expect(client.createSessionCalls).toBe(1);
    expect(client.resumeSessionCalls).toBe(1);
    expect(reloaded.persistence?.sessionId).toBe("delayed-session-1");

    // Drain stream after cancellation to ensure clean shutdown.
    while (true) {
      const next = await stream.next();
      if (next.done) {
        break;
      }
    }
  });

  test("fetchTimeline returns full timeline with reset when cursor epoch is stale", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-stale-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000118",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "one",
    });
    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "two",
    });
    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "three",
    });

    const baseline = manager.fetchTimeline(snapshot.id, {
      direction: "tail",
      limit: 2,
    });
    expect(baseline.rows).toHaveLength(2);

    const result = manager.fetchTimeline(snapshot.id, {
      direction: "after",
      cursor: {
        epoch: "stale-epoch",
        seq: baseline.rows[baseline.rows.length - 1]!.seq,
      },
      limit: 1,
    });

    expect(result.reset).toBe(true);
    expect(result.staleCursor).toBe(true);
    expect(result.gap).toBe(false);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]?.seq).toBe(1);
    expect(result.rows[result.rows.length - 1]?.seq).toBe(3);
  });

  test("emits live timeline updates without recording canonical timeline rows", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-timeline-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000120",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const streamEvents: Array<{
      seq?: number;
      epoch?: string;
      eventType?: string;
      itemType?: string;
    }> = [];
    manager.subscribe(
      (event) => {
        if (event.type !== "agent_stream") {
          return;
        }
        streamEvents.push({
          seq: event.seq,
          epoch: event.epoch,
          eventType: event.event.type,
          itemType: event.event.type === "timeline" ? event.event.item.type : undefined,
        });
      },
      { agentId: snapshot.id, replayState: false }
    );

    await manager.emitLiveTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "live-only update",
    });

    expect(streamEvents).toHaveLength(1);
    expect(streamEvents[0]).toMatchObject({
      eventType: "timeline",
      itemType: "assistant_message",
    });
    expect(streamEvents[0]?.seq).toBeUndefined();
    expect(streamEvents[0]?.epoch).toBeUndefined();

    expect(manager.getTimeline(snapshot.id)).toEqual([]);
    const fetched = manager.fetchTimeline(snapshot.id, {
      direction: "tail",
      limit: 0,
    });
    expect(fetched.rows).toEqual([]);
  });

  test("fetchTimeline returns full timeline with reset when cursor seq falls behind retention window", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-gap-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      maxTimelineItems: 2,
      idFactory: () => "00000000-0000-4000-8000-000000000119",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "first",
    });
    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "second",
    });
    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "third",
    });
    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "fourth",
    });

    const fresh = manager.fetchTimeline(snapshot.id, {
      direction: "tail",
      limit: 0,
    });
    expect(fresh.window.minSeq).toBe(3);
    expect(fresh.window.maxSeq).toBe(4);

    const result = manager.fetchTimeline(snapshot.id, {
      direction: "after",
      cursor: {
        epoch: fresh.epoch,
        seq: 1,
      },
      limit: 10,
    });

    expect(result.reset).toBe(true);
    expect(result.staleCursor).toBe(false);
    expect(result.gap).toBe(true);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]?.seq).toBe(3);
    expect(result.rows[1]?.seq).toBe(4);
  });

  test("does not trim timeline by default", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-unbounded-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000120",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "first",
    });
    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "second",
    });
    await manager.appendTimelineItem(snapshot.id, {
      type: "assistant_message",
      text: "third",
    });

    const fetched = manager.fetchTimeline(snapshot.id, {
      direction: "tail",
      limit: 0,
    });
    expect(fetched.rows).toHaveLength(3);
    expect(fetched.window.minSeq).toBe(1);
    expect(fetched.window.maxSeq).toBe(3);
  });

  test("createAgent fails when generated agent ID is not a UUID", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "not-a-uuid",
    });

    await expect(
      manager.createAgent({
        provider: "codex",
        cwd: workdir,
      })
    ).rejects.toThrow("createAgent: agentId must be a UUID");
  });

  test("createAgent fails when explicit agent ID is not a UUID", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
    });

    await expect(
      manager.createAgent(
        {
          provider: "codex",
          cwd: workdir,
        },
        "not-a-uuid"
      )
    ).rejects.toThrow("createAgent: agentId must be a UUID");
  });

  test("createAgent persists provided title before returning", async () => {
    const agentId = "00000000-0000-4000-8000-000000000102";
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => agentId,
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Fix Login Bug",
    });

    expect(snapshot.id).toBe(agentId);
    expect(snapshot.lifecycle).toBe("idle");

    const persisted = await storage.get(agentId);
    expect(persisted?.title).toBe("Fix Login Bug");
    expect(persisted?.id).toBe(agentId);
  });

  test("createAgent populates runtimeInfo after session creation", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000103",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.2-codex",
      modeId: "full-access",
    });

    expect(snapshot.runtimeInfo).toBeDefined();
    expect(snapshot.runtimeInfo?.model).toBe("gpt-5.2-codex");
    expect(snapshot.runtimeInfo?.sessionId).toBe(snapshot.persistence?.sessionId);
  });

  test("runAgent refreshes runtimeInfo after completion", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000104",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    expect(snapshot.runtimeInfo?.model ?? null).toBeNull();

    await manager.runAgent(snapshot.id, "hello");

    const refreshed = manager.getAgent(snapshot.id);
    expect(refreshed?.runtimeInfo?.model).toBe("gpt-5.2-codex");
  });

  test("waitForAgentEvent does not resolve idle until pendingRun is cleared", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-wait-coherence-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const releaseTurnCompleted = deferred<void>();
    const releaseStreamEnd = deferred<void>();

    class SlowTerminalSession extends TestAgentSession {
      override async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        await releaseTurnCompleted.promise;
        yield { type: "turn_completed", provider: this.provider };
        await releaseStreamEnd.promise;
      }
    }

    class SlowTerminalClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new SlowTerminalSession(config);
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new SlowTerminalClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000124",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const turnCompletedSeen = new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe(
        (event) => {
          if (
            event.type === "agent_stream" &&
            event.agentId === snapshot.id &&
            event.event.type === "turn_completed"
          ) {
            unsubscribe();
            resolve();
          }
        },
        { agentId: snapshot.id, replayState: false }
      );
    });

    const stream = manager.streamAgent(snapshot.id, "hello");
    const consumePromise = (async () => {
      for await (const _event of stream) {
        // Drain events so manager lifecycle progresses naturally.
      }
    })();

    await manager.waitForAgentRunStart(snapshot.id);
    const waitPromise = manager.waitForAgentEvent(snapshot.id);

    releaseTurnCompleted.resolve();
    await turnCompletedSeen;
    const earlyResolution = await Promise.race([
      waitPromise.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(earlyResolution).toBe("pending");

    releaseStreamEnd.resolve();
    const waited = await waitPromise;
    expect(waited.status).toBe("idle");

    await consumePromise;
  });

  test("applies live autonomous events while no foreground run is active", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-events-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const liveEvents = new EventPushable<AgentStreamEvent>();

    class LiveEventSession extends TestAgentSession {
      async *streamLiveEvents(): AsyncGenerator<AgentStreamEvent> {
        for await (const event of liveEvents) {
          yield event;
        }
      }

      override async close(): Promise<void> {
        liveEvents.end();
      }
    }

    class LiveEventClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new LiveEventSession(config);
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new LiveEventClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000125",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const lifecycleUpdates: string[] = [];
    let sawRunningState = false;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    manager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.id === snapshot.id) {
          lifecycleUpdates.push(event.agent.lifecycle);
          if (event.agent.lifecycle === "running") {
            sawRunningState = true;
          }
          if (sawRunningState && event.agent.lifecycle === "idle") {
            resolveSettled();
          }
        }
      },
      { agentId: snapshot.id, replayState: false }
    );

    liveEvents.push({ type: "turn_started", provider: "codex" });
    liveEvents.push({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "AUTONOMOUS_PUMP_MESSAGE" },
    });
    liveEvents.push({ type: "turn_completed", provider: "codex" });
    await settled;

    const updated = manager.getAgent(snapshot.id);
    expect(updated?.lifecycle).toBe("idle");
    expect(manager.getTimeline(snapshot.id)).toContainEqual({
      type: "assistant_message",
      text: "AUTONOMOUS_PUMP_MESSAGE",
    });
    expect(lifecycleUpdates).toContain("running");
    expect(lifecycleUpdates).toContain("idle");
  });

  test("cancelAgentRun can interrupt autonomous running state without a foreground pendingRun", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-cancel-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const liveEvents = new EventPushable<AgentStreamEvent>();

    class LiveInterruptSession extends TestAgentSession {
      public interruptCount = 0;

      async *streamLiveEvents(): AsyncGenerator<AgentStreamEvent> {
        for await (const event of liveEvents) {
          yield event;
        }
      }

      override async interrupt(): Promise<void> {
        this.interruptCount += 1;
      }

      override async close(): Promise<void> {
        liveEvents.end();
      }
    }

    class LiveInterruptClient extends TestAgentClient {
      lastSession: LiveInterruptSession | null = null;

      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = new LiveInterruptSession(config);
        this.lastSession = session;
        return session;
      }
    }

    const client = new LiveInterruptClient();
    const manager = new AgentManager({
      clients: {
        codex: client,
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000129",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    await new Promise<void>((resolve) => {
      const unsubscribe = manager.subscribe(
        (event) => {
          if (event.type !== "agent_state") {
            return;
          }
          if (event.agent.id !== snapshot.id) {
            return;
          }
          if (event.agent.lifecycle !== "running") {
            return;
          }
          unsubscribe();
          resolve();
        },
        { agentId: snapshot.id, replayState: false }
      );
      liveEvents.push({ type: "turn_started", provider: "codex" });
    });

    const beforeCancel = manager.getAgent(snapshot.id);
    expect(beforeCancel?.lifecycle).toBe("running");
    expect(Boolean(beforeCancel && "pendingRun" in beforeCancel && beforeCancel.pendingRun)).toBe(
      false
    );

    const cancelled = await manager.cancelAgentRun(snapshot.id);
    expect(cancelled).toBe(true);
    expect(client.lastSession?.interruptCount).toBe(1);
  });

  test("waitForAgentEvent waitForActive resolves for autonomous live-event run", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-wait-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const liveEvents = new EventPushable<AgentStreamEvent>();

    class LiveEventSession extends TestAgentSession {
      async *streamLiveEvents(): AsyncGenerator<AgentStreamEvent> {
        for await (const event of liveEvents) {
          yield event;
        }
      }

      override async close(): Promise<void> {
        liveEvents.end();
      }
    }

    class LiveEventClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new LiveEventSession(config);
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new LiveEventClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000126",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const waitPromise = manager.waitForAgentEvent(snapshot.id, { waitForActive: true });
    liveEvents.push({ type: "turn_started", provider: "codex" });
    liveEvents.push({ type: "turn_completed", provider: "codex" });

    const result = await waitPromise;
    expect(result.status).toBe("idle");
  });

  test("buffers autonomous live events during foreground run and flushes after run settles", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-buffer-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const liveEvents = new EventPushable<AgentStreamEvent>();
    const releaseForeground = deferred<void>();

    class BufferedLiveSession extends TestAgentSession {
      override async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        await releaseForeground.promise;
        yield { type: "turn_completed", provider: this.provider };
      }

      async *streamLiveEvents(): AsyncGenerator<AgentStreamEvent> {
        for await (const event of liveEvents) {
          yield event;
        }
      }

      override async close(): Promise<void> {
        liveEvents.end();
      }
    }

    class BufferedLiveClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new BufferedLiveSession(config);
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new BufferedLiveClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000127",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const foreground = manager.streamAgent(snapshot.id, "foreground run");
    const consumeForeground = (async () => {
      for await (const _event of foreground) {
        // Drain foreground stream.
      }
    })();

    await manager.waitForAgentRunStart(snapshot.id);

    liveEvents.push({ type: "turn_started", provider: "codex" });
    liveEvents.push({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "AUTONOMOUS_DURING_FOREGROUND" },
    });
    liveEvents.push({ type: "turn_completed", provider: "codex" });

    releaseForeground.resolve();
    await consumeForeground;

    const replaying = manager.getAgent(snapshot.id);
    expect(replaying?.lifecycle).toBe("running");
    const settled = await manager.waitForAgentEvent(snapshot.id);
    expect(settled.status).toBe("idle");
    expect(manager.getTimeline(snapshot.id)).toContainEqual({
      type: "assistant_message",
      text: "AUTONOMOUS_DURING_FOREGROUND",
    });
  });

  test("restarts live event pump after iterator failure", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-restart-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const liveEvents = new EventPushable<AgentStreamEvent>();

    class FlakyLiveSession extends TestAgentSession {
      private attempts = 0;

      async *streamLiveEvents(): AsyncGenerator<AgentStreamEvent> {
        this.attempts += 1;
        if (this.attempts === 1) {
          throw new Error("simulated live iterator failure");
        }
        for await (const event of liveEvents) {
          yield event;
        }
      }

      override async close(): Promise<void> {
        liveEvents.end();
      }
    }

    class FlakyLiveClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new FlakyLiveSession(config);
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new FlakyLiveClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000128",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    // Give the first failed stream a chance to restart.
    await new Promise((resolve) => setTimeout(resolve, 350));

    const assistantSeen = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error("Timed out waiting for restarted live event"));
      }, 2_000);
      const unsubscribe = manager.subscribe(
        (event) => {
          if (event.type !== "agent_stream" || event.agentId !== snapshot.id) {
            return;
          }
          if (
            event.event.type === "timeline" &&
            event.event.item.type === "assistant_message" &&
            event.event.item.text === "AUTONOMOUS_AFTER_RESTART"
          ) {
            clearTimeout(timeout);
            unsubscribe();
            resolve();
          }
        },
        { agentId: snapshot.id, replayState: false }
      );
    });

    liveEvents.push({ type: "turn_started", provider: "codex" });
    liveEvents.push({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "AUTONOMOUS_AFTER_RESTART" },
    });
    liveEvents.push({ type: "turn_completed", provider: "codex" });

    await assistantSeen;
    const result = await manager.waitForAgentEvent(snapshot.id);
    expect(result.status).toBe("idle");
    expect(manager.getTimeline(snapshot.id)).toContainEqual({
      type: "assistant_message",
      text: "AUTONOMOUS_AFTER_RESTART",
    });
  });

  test("keeps updatedAt monotonic when user message and run start happen in the same millisecond", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000120",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
    try {
      manager.recordUserMessage(snapshot.id, "hello");
      const afterMessage = manager.getAgent(snapshot.id);
      expect(afterMessage).toBeDefined();
      const messageUpdatedAt = afterMessage!.updatedAt.getTime();

      const stream = manager.streamAgent(snapshot.id, "hello");
      const afterRunStart = manager.getAgent(snapshot.id);
      expect(afterRunStart).toBeDefined();
      expect(afterRunStart!.updatedAt.getTime()).toBeGreaterThan(messageUpdatedAt);

      await stream.return(undefined);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test("recordUserMessage can skip emitting agent_state when run start will emit running", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000121",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const lifecycleUpdates: string[] = [];
    manager.subscribe((event) => {
      if (event.type !== "agent_state" || event.agent.id !== snapshot.id) {
        return;
      }
      lifecycleUpdates.push(event.agent.lifecycle);
    });
    lifecycleUpdates.length = 0;

    manager.recordUserMessage(snapshot.id, "hello", { emitState: false });

    expect(lifecycleUpdates).toEqual([]);
  });

  test("runAgent assembles finalText from trailing assistant chunks", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const expectedFinalText =
      "```json\n{\"message\":\"Reserve space for archive button in sidebar agent list\"}\n```";

    class ChunkedAssistantSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      readonly id = randomUUID();

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        yield {
          type: "timeline",
          provider: this.provider,
          item: {
            type: "assistant_message",
            text: "```json\n{\"message\":\"Reserve space for archive button in side",
          },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: {
            type: "assistant_message",
            text: "bar agent list\"}\n```",
          },
        };
        yield { type: "turn_completed", provider: this.provider };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.id,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes() {
        return [];
      }

      async getCurrentMode() {
        return null;
      }

      async setMode(): Promise<void> {}

      getPendingPermissions() {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence() {
        return {
          provider: this.provider,
          sessionId: this.id,
        };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {}
    }

    class ChunkedAssistantClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(): Promise<AgentSession> {
        return new ChunkedAssistantSession();
      }

      async resumeSession(): Promise<AgentSession> {
        return new ChunkedAssistantSession();
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new ChunkedAssistantClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000113",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const result = await manager.runAgent(snapshot.id, "generate commit message");
    expect(result.finalText).toBe(expectedFinalText);
  });

  test("listAgents excludes internal agents", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const generatedAgentIds = [
      "00000000-0000-4000-8000-000000000105",
      "00000000-0000-4000-8000-000000000106",
    ];
    let agentCounter = 0;
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => generatedAgentIds[agentCounter++] ?? randomUUID(),
    });

    // Create a normal agent
    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Normal Agent",
    });

    // Create an internal agent
    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    const agents = manager.listAgents();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.config.title).toBe("Normal Agent");
  });

  test("getAgent returns internal agents by ID", async () => {
    const internalAgentId = "00000000-0000-4000-8000-000000000107";
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => internalAgentId,
    });

    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    const agent = manager.getAgent(internalAgentId);
    expect(agent).not.toBeNull();
    expect(agent?.internal).toBe(true);
  });

  test("subscribe does not emit state events for internal agents to global subscribers", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const generatedAgentIds = [
      "00000000-0000-4000-8000-000000000108",
      "00000000-0000-4000-8000-000000000109",
    ];
    let agentCounter = 0;
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => generatedAgentIds[agentCounter++] ?? randomUUID(),
    });

    const receivedEvents: string[] = [];
    manager.subscribe((event) => {
      if (event.type === "agent_state") {
        receivedEvents.push(event.agent.id);
      }
    });

    // Create a normal agent - should emit
    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Normal Agent",
    });

    // Create an internal agent - should NOT emit to global subscriber
    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    // Should only have events from the normal agent
    expect(receivedEvents.filter((id) => id === generatedAgentIds[0]).length).toBeGreaterThan(0);
    expect(receivedEvents.filter((id) => id === generatedAgentIds[1]).length).toBe(0);
  });

  test("subscribe emits state events for internal agents when subscribed by agentId", async () => {
    const internalAgentId = "00000000-0000-4000-8000-000000000110";
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => internalAgentId,
    });

    const receivedEvents: string[] = [];
    // Subscribe specifically to the internal agent
    manager.subscribe(
      (event) => {
        if (event.type === "agent_state") {
          receivedEvents.push(event.agent.id);
        }
      },
      { agentId: internalAgentId, replayState: false }
    );

    await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    // Should receive events when subscribed by specific agentId
    expect(receivedEvents.filter((id) => id === internalAgentId).length).toBeGreaterThan(0);
  });

  test("subscribe fails when filter agentId is not a UUID", () => {
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      logger,
    });

    expect(() =>
      manager.subscribe(() => {}, {
        agentId: "invalid-agent-id",
      })
    ).toThrow("subscribe: agentId must be a UUID");
  });

  test("onAgentAttention is not called for internal agents", async () => {
    const internalAgentId = "00000000-0000-4000-8000-000000000111";
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const attentionCalls: string[] = [];
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => internalAgentId,
      onAgentAttention: ({ agentId }) => {
        attentionCalls.push(agentId);
      },
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    });

    // Run and complete the agent (which normally triggers attention)
    await manager.runAgent(agent.id, "hello");

    // Should NOT have triggered attention callback for internal agent
    expect(attentionCalls).toHaveLength(0);
  });

  test("clearAgentAttention on errored agent stays cleared until a new error transition", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-attention-error-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class FailingSession extends TestAgentSession {
      private attempt = 0;

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        this.attempt += 1;
        yield { type: "turn_started", provider: this.provider };
        throw new Error(`boom-${this.attempt}`);
      }
    }

    class FailingClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new FailingSession(config);
      }

      async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
        return new FailingSession({
          provider: "codex",
          cwd: config?.cwd ?? process.cwd(),
        });
      }
    }

    const attentionReasons: Array<"finished" | "error" | "permission"> = [];
    const manager = new AgentManager({
      clients: {
        codex: new FailingClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000130",
      onAgentAttention: ({ reason }) => {
        attentionReasons.push(reason);
      },
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Attention transition test",
    });

    await expect(manager.runAgent(agent.id, "fail once")).rejects.toThrow("boom-1");

    const afterFirstFailure = manager.getAgent(agent.id);
    expect(afterFirstFailure?.lifecycle).toBe("error");
    expect(afterFirstFailure?.attention.requiresAttention).toBe(true);
    expect(afterFirstFailure?.attention).toMatchObject({
      requiresAttention: true,
      attentionReason: "error",
    });

    await manager.clearAgentAttention(agent.id);
    manager.notifyAgentState(agent.id);

    const afterClear = manager.getAgent(agent.id);
    expect(afterClear?.lifecycle).toBe("error");
    expect(afterClear?.attention).toEqual({ requiresAttention: false });

    await expect(manager.runAgent(agent.id, "fail again")).rejects.toThrow("boom-2");

    const afterSecondFailure = manager.getAgent(agent.id);
    expect(afterSecondFailure?.lifecycle).toBe("error");
    expect(afterSecondFailure?.attention).toMatchObject({
      requiresAttention: true,
      attentionReason: "error",
    });
    expect(attentionReasons).toEqual(["error", "error"]);
  });

  test("permission request notifies once without forcing unread attention state", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-attention-permission-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class PermissionSession extends TestAgentSession {
      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        yield {
          type: "permission_requested",
          provider: this.provider,
          request: {
            id: "perm-1",
            provider: this.provider,
            kind: "tool",
            name: "Read file",
          },
        };
        yield {
          type: "permission_resolved",
          provider: this.provider,
          requestId: "perm-1",
          resolution: { behavior: "allow" },
        };
        yield { type: "turn_completed", provider: this.provider };
      }
    }

    class PermissionClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new PermissionSession(config);
      }

      async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
        return new PermissionSession({
          provider: "codex",
          cwd: config?.cwd ?? process.cwd(),
        });
      }
    }

    const attentionReasons: Array<"finished" | "error" | "permission"> = [];
    const manager = new AgentManager({
      clients: {
        codex: new PermissionClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000131",
      onAgentAttention: ({ reason }) => {
        attentionReasons.push(reason);
      },
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Permission transition test",
    });

    const stream = manager.streamAgent(agent.id, "permission flow");
    await stream.next(); // turn_started
    await stream.next(); // permission_requested

    const withPermissionPending = manager.getAgent(agent.id);
    expect(withPermissionPending?.pendingPermissions.size).toBe(1);
    expect(withPermissionPending?.attention).toEqual({ requiresAttention: false });

    // Drain the rest of the stream to close cleanly.
    while (!(await stream.next()).done) {
      // no-op
    }

    expect(attentionReasons).toContain("permission");
  });

  test("respondToPermission updates currentModeId after plan approval", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    // Create a session that simulates plan approval mode change
    let sessionMode = "plan";
    class PlanModeTestSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      readonly id = randomUUID();

      async run(): Promise<AgentRunResult> {
        return { sessionId: this.id, finalText: "", timeline: [] };
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        yield { type: "turn_completed", provider: this.provider };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return { provider: this.provider, sessionId: this.id, model: null, modeId: sessionMode };
      }

      async getAvailableModes() {
        return [
          { id: "plan", label: "Plan" },
          { id: "acceptEdits", label: "Accept Edits" },
        ];
      }

      async getCurrentMode() {
        return sessionMode;
      }

      async setMode(modeId: string): Promise<void> {
        sessionMode = modeId;
      }

      getPendingPermissions() {
        return [];
      }

      async respondToPermission(
        _requestId: string,
        response: { behavior: string }
      ): Promise<void> {
        // Simulate what claude-agent.ts does: when plan permission is approved,
        // it calls setMode("acceptEdits") internally
        if (response.behavior === "allow") {
          sessionMode = "acceptEdits";
        }
      }

      describePersistence() {
        return { provider: this.provider, sessionId: this.id };
      }

      async interrupt(): Promise<void> {}
      async close(): Promise<void> {}
    }

    class PlanModeTestClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(): Promise<AgentSession> {
        return new PlanModeTestSession();
      }

      async resumeSession(): Promise<AgentSession> {
        return new PlanModeTestSession();
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new PlanModeTestClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000112",
    });

    // Create agent in plan mode
    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      modeId: "plan",
    });

    expect(snapshot.currentModeId).toBe("plan");

    // Simulate a pending plan permission request
    const agent = manager.getAgent(snapshot.id)!;
    const permissionRequest = {
      id: "perm-123",
      provider: "codex" as const,
      name: "ExitPlanMode",
      kind: "plan" as const,
      input: { plan: "Test plan" },
    };
    agent.pendingPermissions.set(permissionRequest.id, permissionRequest);

    // Approve the plan permission
    await manager.respondToPermission(snapshot.id, "perm-123", {
      behavior: "allow",
    });

    // The session's mode has changed to "acceptEdits" internally
    // The manager should have updated currentModeId to reflect this
    const updatedAgent = manager.getAgent(snapshot.id);
    expect(updatedAgent?.currentModeId).toBe("acceptEdits");
  });

  test("close during in-flight stream does not clear persistence sessionId", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class CloseRaceSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      readonly id = randomUUID();
      private threadId: string | null = this.id;
      private releaseStream: (() => void) | null = null;
      private closed = false;

      async run(): Promise<AgentRunResult> {
        return { sessionId: this.id, finalText: "", timeline: [] };
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        if (!this.closed) {
          await new Promise<void>((resolve) => {
            this.releaseStream = resolve;
          });
        }
        yield { type: "turn_canceled", provider: this.provider, reason: "closed" };
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

      async getRuntimeInfo() {
        return {
          provider: this.provider,
          sessionId: this.threadId,
          model: null,
          modeId: null,
        };
      }

      async getAvailableModes() {
        return [];
      }

      async getCurrentMode() {
        return null;
      }

      async setMode(): Promise<void> {}

      getPendingPermissions() {
        return [];
      }

      async respondToPermission(): Promise<void> {}

      describePersistence() {
        if (!this.threadId) {
          return null;
        }
        return { provider: this.provider, sessionId: this.threadId };
      }

      async interrupt(): Promise<void> {}

      async close(): Promise<void> {
        this.closed = true;
        this.threadId = null;
        this.releaseStream?.();
      }
    }

    class CloseRaceClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(): Promise<AgentSession> {
        return new CloseRaceSession();
      }

      async resumeSession(): Promise<AgentSession> {
        return new CloseRaceSession();
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new CloseRaceClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000113",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const stream = manager.streamAgent(snapshot.id, "hello");
    await stream.next();

    await manager.closeAgent(snapshot.id);

    // Drain stream finalizer path after close().
    while (true) {
      const next = await stream.next();
      if (next.done) {
        break;
      }
    }

    await manager.flush();
    await storage.flush();

    const persisted = await storage.get(snapshot.id);
    expect(persisted?.persistence?.sessionId).toBe(snapshot.persistence?.sessionId);
  });

  test("hydrateTimeline skips provider user_message items to prevent duplicates with recordUserMessage", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-dedup-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    // Session whose streamHistory yields user_message + assistant_message items.
    // This simulates Codex provider replaying its thread history on resume.
    class HistoryWithUserMessagesSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "user_message", text: "hello from user", messageId: "msg_client_1" },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "hi there" },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "user_message", text: "second question", messageId: "msg_client_2" },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "second answer" },
        };
      }
    }

    class HistoryUserMessageClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        // Fresh session yields history with user messages (simulates Codex resume)
        return new HistoryWithUserMessagesSession(config);
      }

      async resumeSession(): Promise<AgentSession> {
        throw new Error("Not used in this test");
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new HistoryUserMessageClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000200",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    // Simulate canonical user messages already recorded by recordUserMessage
    // (the path that session.ts takes when user sends a message)
    manager.recordUserMessage(snapshot.id, "hello from user", {
      messageId: "msg_client_1",
    });
    manager.recordUserMessage(snapshot.id, "second question", {
      messageId: "msg_client_2",
    });

    const beforeHydrate = manager.getTimeline(snapshot.id);
    const userMessagesBefore = beforeHydrate.filter(
      (item) => item.type === "user_message"
    );
    expect(userMessagesBefore).toHaveLength(2);

    // hydrateTimeline replays provider history which includes user_message
    // items. These should NOT create duplicate rows since recordUserMessage
    // already created canonical entries.
    await manager.hydrateTimelineFromProvider(snapshot.id);

    const afterHydrate = manager.getTimeline(snapshot.id);
    const userMessagesAfter = afterHydrate.filter(
      (item) => item.type === "user_message"
    );

    // Should still have exactly 2 user messages, not 4
    expect(userMessagesAfter).toHaveLength(2);

    // Non-user_message items from history should still be replayed
    const assistantMessages = afterHydrate.filter(
      (item) => item.type === "assistant_message"
    );
    expect(assistantMessages).toHaveLength(2);
  });

  test("hydrateTimeline keeps provider user_message items when no canonical user history exists", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-keep-user-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class HistoryWithUserMessagesSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "user_message", text: "hello from user", messageId: "msg_history_1" },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "hi there" },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "user_message", text: "second question", messageId: "msg_history_2" },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "second answer" },
        };
      }
    }

    class HistoryUserMessageClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new HistoryWithUserMessagesSession(config);
      }

      async resumeSession(): Promise<AgentSession> {
        throw new Error("Not used in this test");
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new HistoryUserMessageClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000203",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    await manager.hydrateTimelineFromProvider(snapshot.id);

    const timeline = manager.getTimeline(snapshot.id);
    const userMessages = timeline.filter((item) => item.type === "user_message");
    const assistantMessages = timeline.filter((item) => item.type === "assistant_message");
    expect(userMessages).toHaveLength(2);
    expect(assistantMessages).toHaveLength(2);
  });

  test("hydrateTimeline suppresses only matching canonical user_message messageId", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-partial-dedup-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class HistoryWithMixedUserMessagesSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
        yield {
          type: "timeline",
          provider: this.provider,
          item: {
            type: "user_message",
            text: "hello from user",
            messageId: "msg_client_hello",
          },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "hi there" },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: {
            type: "user_message",
            text: "hello from user",
            messageId: "msg_provider_distinct",
          },
        };
      }
    }

    class HistoryMixedClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new HistoryWithMixedUserMessagesSession(config);
      }
      async resumeSession(): Promise<AgentSession> {
        throw new Error("Not used in this test");
      }
    }

    const manager = new AgentManager({
      clients: { codex: new HistoryMixedClient() },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000204",
    });

    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir });

    // Canonical user message that should dedupe the matching history item.
    manager.recordUserMessage(snapshot.id, "hello from user", {
      messageId: "msg_client_hello",
    });

    await manager.hydrateTimelineFromProvider(snapshot.id);

    const timeline = manager.getTimeline(snapshot.id);
    const userMessages = timeline.filter((item) => item.type === "user_message");
    expect(userMessages).toHaveLength(2);
    expect(
      userMessages.map(
        (item) =>
          (item as Extract<AgentTimelineItem, { type: "user_message" }>).messageId
      )
    ).toEqual([
      "msg_client_hello",
      "msg_provider_distinct",
    ]);
    expect(userMessages.map((item) => item.text)).toEqual([
      "hello from user",
      "hello from user",
    ]);
  });

  test("recordUserMessage normalizes blank/whitespace messageId to undefined", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-blank-msgid-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000201",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    // Empty string should be treated as missing
    manager.recordUserMessage(snapshot.id, "test empty", {
      messageId: "",
    });

    // Whitespace-only should be treated as missing
    manager.recordUserMessage(snapshot.id, "test whitespace", {
      messageId: "   ",
    });

    // Valid messageId should be preserved
    manager.recordUserMessage(snapshot.id, "test valid", {
      messageId: "msg_valid_123",
    });

    const timeline = manager.getTimeline(snapshot.id);
    const userMessages = timeline.filter(
      (item): item is Extract<AgentTimelineItem, { type: "user_message" }> =>
        item.type === "user_message"
    );

    expect(userMessages).toHaveLength(3);
    // Empty string → undefined (not empty string)
    expect(userMessages[0]!.messageId).toBeUndefined();
    // Whitespace → undefined
    expect(userMessages[1]!.messageId).toBeUndefined();
    // Valid → preserved
    expect(userMessages[2]!.messageId).toBe("msg_valid_123");
  });

  test("recordUserMessage preserves provided messageId in timeline item and dispatched event", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-msgid-passthrough-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000202",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const events: AgentStreamEvent[] = [];
    manager.subscribe((event) => {
      if (event.type === "agent_stream") {
        events.push(event.event);
      }
    });

    const clientMsgId = "msg_abc_123_def";
    manager.recordUserMessage(snapshot.id, "hello", {
      messageId: clientMsgId,
    });

    // Timeline item should have the messageId
    const timeline = manager.getTimeline(snapshot.id);
    const userMsg = timeline.find(
      (item): item is Extract<AgentTimelineItem, { type: "user_message" }> =>
        item.type === "user_message"
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.messageId).toBe(clientMsgId);

    // Dispatched stream event should also carry the messageId
    const streamEvent = events.find(
      (e) => e.type === "timeline" && e.item.type === "user_message"
    );
    expect(streamEvent).toBeDefined();
    if (streamEvent?.type === "timeline") {
      expect(
        (streamEvent.item as { type: "user_message"; messageId?: string }).messageId
      ).toBe(clientMsgId);
    }
  });

  test("live provider user_message echo is suppressed when recordUserMessage was called first", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-echo-dedup-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    // Session whose stream() echoes the user message (as Claude provider does)
    class EchoUserMessageSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        // Provider echoes user message during live run
        yield {
          type: "timeline",
          provider: this.provider,
          item: {
            type: "user_message",
            text: "hello from user",
            messageId: "msg_client_echo_1",
          },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "hello from assistant" },
        };
        yield { type: "turn_completed", provider: this.provider };
      }
    }

    class EchoClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> { return true; }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new EchoUserMessageSession(config);
      }
      async resumeSession(): Promise<AgentSession> { throw new Error("unused"); }
    }

    const manager = new AgentManager({
      clients: { codex: new EchoClient() },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000400",
    });

    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir });

    // Canonical recording (what session.ts does before starting stream)
    manager.recordUserMessage(snapshot.id, "hello from user", {
      messageId: "msg_client_echo_1",
    });

    // Run triggers stream() which echoes user_message
    await manager.runAgent(snapshot.id, { text: "hello from user" });

    const timeline = manager.getTimeline(snapshot.id);
    const userMessages = timeline.filter(
      (item) => item.type === "user_message"
    );

    // Should be exactly 1 (canonical), not 2 (canonical + provider echo)
    expect(userMessages).toHaveLength(1);
    // The canonical one must carry the client messageId for optimistic matching
    expect(
      (userMessages[0] as Extract<AgentTimelineItem, { type: "user_message" }>).messageId
    ).toBe("msg_client_echo_1");

    // Assistant messages from the run should still appear
    const assistantMessages = timeline.filter(
      (item) => item.type === "assistant_message"
    );
    expect(assistantMessages).toHaveLength(1);
  });

  test("live provider user_message with different messageId is NOT suppressed", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-different-msgid-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class DifferentMessageIdSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        yield {
          type: "timeline",
          provider: this.provider,
          item: {
            type: "user_message",
            text: "hello from user",
            messageId: "msg_provider_other",
          },
        };
        yield { type: "turn_completed", provider: this.provider };
      }
    }

    class DifferentMessageIdClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> { return true; }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new DifferentMessageIdSession(config);
      }
      async resumeSession(): Promise<AgentSession> { throw new Error("unused"); }
    }

    const manager = new AgentManager({
      clients: { codex: new DifferentMessageIdClient() },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000402",
    });

    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir });

    manager.recordUserMessage(snapshot.id, "hello from user", {
      messageId: "msg_client_echo_2",
    });

    await manager.runAgent(snapshot.id, { text: "hello from user" });

    const timeline = manager.getTimeline(snapshot.id);
    const userMessages = timeline.filter(
      (item): item is Extract<AgentTimelineItem, { type: "user_message" }> =>
        item.type === "user_message"
    );
    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((item) => item.messageId)).toEqual([
      "msg_client_echo_2",
      "msg_provider_other",
    ]);
  });

  test("live provider user_message without messageId is NOT suppressed", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-no-msgid-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class NoMessageIdSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "user_message", text: "hello from user" },
        };
        yield { type: "turn_completed", provider: this.provider };
      }
    }

    class NoMessageIdClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> { return true; }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new NoMessageIdSession(config);
      }
      async resumeSession(): Promise<AgentSession> { throw new Error("unused"); }
    }

    const manager = new AgentManager({
      clients: { codex: new NoMessageIdClient() },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000403",
    });

    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir });

    manager.recordUserMessage(snapshot.id, "hello from user", {
      messageId: "msg_client_echo_3",
    });

    await manager.runAgent(snapshot.id, { text: "hello from user" });

    const timeline = manager.getTimeline(snapshot.id);
    const userMessages = timeline.filter((item) => item.type === "user_message");
    expect(userMessages).toHaveLength(2);
  });

  test("provider user_message is NOT suppressed when no prior recordUserMessage", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-no-prior-record-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    // Session whose stream() yields a user_message without prior canonical recording
    class UnexpectedUserMessageSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      async *stream(): AsyncGenerator<AgentStreamEvent> {
        yield { type: "turn_started", provider: this.provider };
        // Provider yields user_message (e.g., system continuation)
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "user_message", text: "continuation prompt" },
        };
        yield {
          type: "timeline",
          provider: this.provider,
          item: { type: "assistant_message", text: "continuation reply" },
        };
        yield { type: "turn_completed", provider: this.provider };
      }
    }

    class UnexpectedUserMsgClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> { return true; }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new UnexpectedUserMessageSession(config);
      }
      async resumeSession(): Promise<AgentSession> { throw new Error("unused"); }
    }

    const manager = new AgentManager({
      clients: { codex: new UnexpectedUserMsgClient() },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000401",
    });

    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir });

    // No recordUserMessage — run directly
    await manager.runAgent(snapshot.id, { text: "do something" });

    const timeline = manager.getTimeline(snapshot.id);
    const userMessages = timeline.filter(
      (item) => item.type === "user_message"
    );

    // Provider's user_message should be recorded (no canonical to dedup against)
    expect(userMessages).toHaveLength(1);
    expect(
      (userMessages[0] as Extract<AgentTimelineItem, { type: "user_message" }>).text
    ).toBe("continuation prompt");
  });
});
