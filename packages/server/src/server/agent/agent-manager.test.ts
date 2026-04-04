import { describe, expect, test, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import { AgentManager } from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { buildConfigOverrides } from "../persistence-hooks.js";
import type {
  AgentClient,
  AgentFeature,
  AgentLaunchContext,
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

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
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
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnIdCounter = 0;
  private interrupted = false;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id ?? this.config.provider,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(): Promise<{ turnId: string }> {
    this.interrupted = false;
    const turnId = `turn-${++this.turnIdCounter}`;
    // Use setTimeout so events arrive after the caller sets up the foreground waiter
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      this.runtimeModel = "gpt-5.2-codex";
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  pushEvent(event: AgentStreamEvent): void {
    for (const cb of this.subscribers) {
      try {
        cb(event);
      } catch {
        // error isolation per design
      }
    }
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

  async interrupt(): Promise<void> {
    this.interrupted = true;
  }

  async close(): Promise<void> {}
}

function createFeature(overrides: Partial<AgentFeature> = {}): AgentFeature {
  return {
    type: "toggle",
    id: "fast_mode",
    label: "Fast mode",
    value: false,
    ...overrides,
  };
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

  test("createAgent passes daemon launch env through the provider launch context", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class CaptureClient extends TestAgentClient {
      lastConfig: AgentSessionConfig | null = null;
      lastLaunchContext: AgentLaunchContext | undefined;

      override async createSession(
        config: AgentSessionConfig,
        launchContext?: AgentLaunchContext,
      ): Promise<AgentSession> {
        this.lastConfig = config;
        this.lastLaunchContext = launchContext;
        return new TestAgentSession(config);
      }
    }

    const client = new CaptureClient();
    const manager = new AgentManager({
      clients: {
        codex: client,
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000103",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    expect(client.lastConfig).toEqual({
      provider: "codex",
      cwd: workdir,
    });
    expect(client.lastLaunchContext).toEqual({
      env: {
        PASEO_AGENT_ID: snapshot.id,
      },
    });
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
      }),
    ).rejects.toThrow("Working directory does not exist");
  });

  test("resumeAgentFromPersistence keeps metadata config, applies overrides, and passes launch env", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-resume-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class ResumeCaptureClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      lastResumeOverrides: Partial<AgentSessionConfig> | undefined;
      lastResumeLaunchContext: AgentLaunchContext | undefined;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new TestAgentSession(config);
      }

      async resumeSession(
        handle: AgentPersistenceHandle,
        overrides?: Partial<AgentSessionConfig>,
        launchContext?: AgentLaunchContext,
      ): Promise<AgentSession> {
        this.lastResumeOverrides = overrides;
        this.lastResumeLaunchContext = launchContext;
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
    expect(client.lastResumeLaunchContext).toEqual({
      env: {
        PASEO_AGENT_ID: resumed.id,
      },
    });
  });

  test("reloadAgentSession passes daemon launch env through the provider launch context", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-context-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class ReloadCaptureClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      lastCreateLaunchContext: AgentLaunchContext | undefined;
      lastResumeLaunchContext: AgentLaunchContext | undefined;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(
        config: AgentSessionConfig,
        launchContext?: AgentLaunchContext,
      ): Promise<AgentSession> {
        this.lastCreateLaunchContext = launchContext;
        return new TestAgentSession(config);
      }

      async resumeSession(
        handle: AgentPersistenceHandle,
        overrides?: Partial<AgentSessionConfig>,
        launchContext?: AgentLaunchContext,
      ): Promise<AgentSession> {
        this.lastResumeLaunchContext = launchContext;
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

    const client = new ReloadCaptureClient();
    const manager = new AgentManager({
      clients: {
        codex: client,
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000108",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    expect(client.lastCreateLaunchContext).toEqual({
      env: {
        PASEO_AGENT_ID: snapshot.id,
      },
    });

    await manager.reloadAgentSession(snapshot.id, {
      systemPrompt: "reloaded prompt",
    });

    expect(client.lastResumeLaunchContext).toEqual({
      env: {
        PASEO_AGENT_ID: snapshot.id,
      },
    });
  });

  test("resumeAgentFromPersistence passes featureValues through to the resumed session config", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-resume-features-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class ResumeFeatureCaptureClient implements AgentClient {
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
        overrides?: Partial<AgentSessionConfig>,
      ): Promise<AgentSession> {
        this.lastResumeOverrides = overrides;
        const metadata = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
        return new TestAgentSession({
          ...metadata,
          ...overrides,
          provider: "codex",
          cwd: overrides?.cwd ?? metadata.cwd ?? process.cwd(),
        });
      }
    }

    const now = new Date().toISOString();
    await storage.upsert({
      id: "00000000-0000-4000-8000-000000000138",
      provider: "codex",
      cwd: workdir,
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
      title: null,
      labels: {},
      lastStatus: "idle",
      lastModeId: "plan",
      config: {
        model: "gpt-5.1",
        modeId: "plan",
        featureValues: {
          fast_mode: true,
        },
      },
      persistence: {
        provider: "codex",
        sessionId: "resume-feature-session",
        metadata: {
          provider: "codex",
          cwd: workdir,
        },
      },
    });

    const record = await storage.get("00000000-0000-4000-8000-000000000138");
    expect(record).not.toBeNull();

    const client = new ResumeFeatureCaptureClient();
    const manager = new AgentManager({
      clients: {
        codex: client,
      },
      registry: storage,
      logger,
    });

    const resumed = await manager.resumeAgentFromPersistence(
      {
        provider: "codex",
        sessionId: "resume-feature-session",
        metadata: {
          provider: "codex",
          cwd: workdir,
        },
      },
      buildConfigOverrides(record!),
      record!.id,
    );

    expect(client.lastResumeOverrides?.featureValues).toEqual({
      fast_mode: true,
    });
    expect(resumed.config.featureValues).toEqual({
      fast_mode: true,
    });
  });

  test("reloadAgentSession preserves timeline and does not force history replay", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class HistoryProbeSession extends TestAgentSession {
      constructor(
        config: AgentSessionConfig,
        private readonly historyText: string | null,
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
        overrides?: Partial<AgentSessionConfig>,
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

  test("setAgentFeature calls session.setFeature and persists featureValues in config", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-set-feature-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class FeatureSession extends TestAgentSession {
      readonly features: AgentFeature[] = [createFeature()];
      readonly setFeature = vi.fn(async (featureId: string, value: unknown) => {
        const feature = this.features.find((item) => item.id === featureId);
        if (feature?.type === "toggle") {
          feature.value = Boolean(value);
        }
      });
    }

    class FeatureClient extends TestAgentClient {
      session: FeatureSession | null = null;

      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        this.session = new FeatureSession(config);
        return this.session;
      }
    }

    const client = new FeatureClient();
    const manager = new AgentManager({
      clients: { codex: client },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000128",
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    await manager.setAgentFeature(agent.id, "fast_mode", true);

    expect(client.session?.setFeature).toHaveBeenCalledWith("fast_mode", true);
    expect(manager.getAgent(agent.id)?.config.featureValues).toEqual({ fast_mode: true });
  });

  test("setAgentFeature throws when session does not support setFeature", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-set-feature-unsupported-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: { codex: new TestAgentClient() },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000129",
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    await expect(manager.setAgentFeature(agent.id, "fast_mode", true)).rejects.toThrow(
      "Agent session does not support setting features",
    );
  });

  test("emitState syncs features from session to agent", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-emit-state-features-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class FeatureSession extends TestAgentSession {
      readonly features: AgentFeature[] = [createFeature()];
    }

    class FeatureClient extends TestAgentClient {
      session: FeatureSession | null = null;

      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        this.session = new FeatureSession(config);
        return this.session;
      }
    }

    const client = new FeatureClient();
    const manager = new AgentManager({
      clients: { codex: client },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000130",
    });

    const events: AgentFeature[][] = [];
    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    manager.subscribe((event) => {
      if (event.type !== "agent_state" || event.agent.id !== agent.id) {
        return;
      }
      events.push(event.agent.features ?? []);
    });

    if (client.session?.features[0]?.type === "toggle") {
      client.session.features[0].value = true;
    }

    manager.notifyAgentState(agent.id);

    expect(manager.getAgent(agent.id)?.features).toEqual([createFeature({ value: true })]);
    expect(events.at(-1)).toEqual([createFeature({ value: true })]);
  });

  test("reloadAgentSession cancels active run and resumes existing session once thread_started is observed", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-active-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class DelayedPersistenceSession extends TestAgentSession {
      private persistenceReady = false;
      private delayedInterrupted = false;
      private releaseGate: (() => void) | null = null;
      private readonly gate = new Promise<void>((resolve) => {
        this.releaseGate = resolve;
      });
      private activeTurnId: string | null = null;

      constructor(
        config: AgentSessionConfig,
        private readonly stableSessionId: string,
        initiallyReady = false,
      ) {
        super(config);
        this.persistenceReady = initiallyReady;
      }

      override async startTurn(): Promise<{ turnId: string }> {
        this.delayedInterrupted = false;
        const turnId = `delayed-turn-${Date.now()}`;
        this.activeTurnId = turnId;
        // Push turn_started, then thread_started, then wait on gate
        setTimeout(async () => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          this.persistenceReady = true;
          this.pushEvent({
            type: "thread_started",
            provider: this.provider,
            sessionId: this.stableSessionId,
          });
          await this.gate;
          if (this.delayedInterrupted) {
            this.pushEvent({ type: "turn_canceled", provider: this.provider, reason: "Interrupted", turnId });
          } else {
            this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
          }
        }, 0);
        return { turnId };
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

      override async interrupt(): Promise<void> {
        this.delayedInterrupted = true;
        this.releaseGate?.();
      }

      async close(): Promise<void> {
        this.delayedInterrupted = true;
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
        overrides?: Partial<AgentSessionConfig>,
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

    // Wait for the thread_started event to propagate through subscribe
    // (it's a session-level event, not forwarded to the foreground stream)
    await vi.waitFor(() => {
      const active = manager.getAgent(snapshot.id);
      expect(active?.persistence?.sessionId).toBe("delayed-session-1");
    });

    const active = manager.getAgent(snapshot.id);
    expect(active?.lifecycle).toBe("running");

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
      { agentId: snapshot.id, replayState: false },
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
      }),
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
        "not-a-uuid",
      ),
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

  test("waitForAgentEvent does not resolve idle until foreground turn is finalized", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-wait-coherence-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const releaseTurnCompleted = deferred<void>();

    class SlowTerminalSession extends TestAgentSession {
      override async startTurn(): Promise<{ turnId: string }> {
        this.interrupted = false;
        const turnId = `turn-${++this.turnIdCounter}`;
        void (async () => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          await releaseTurnCompleted.promise;
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        })();
        return { turnId };
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

    const stream = manager.streamAgent(snapshot.id, "hello");
    const consumePromise = (async () => {
      for await (const _event of stream) {
        // Drain events so manager lifecycle progresses naturally.
      }
    })();

    // Wait for the turn to start
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    const waitPromise = manager.waitForAgentEvent(snapshot.id);

    // Should still be pending because turn_completed hasn't arrived
    const earlyResolution = await Promise.race([
      waitPromise.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(earlyResolution).toBe("pending");

    // Release the turn_completed event
    releaseTurnCompleted.resolve();
    const waited = await waitPromise;
    expect(waited.status).toBe("idle");

    await consumePromise;
  });

  test("waitForAgentRunStart resolves while a foreground run is still only pending", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-fast-start-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000124",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const run = manager.streamAgent(snapshot.id, "fast");
    const drainRun = (async () => {
      for await (const _event of run) {
        // Drain the fast foreground turn.
      }
    })();

    await expect(manager.waitForAgentRunStart(snapshot.id)).resolves.toBeUndefined();

    await drainRun;
    expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("idle");
  });

  test("replaceAgentRun does not emit idle or resolve waiters between interrupted and replacement runs", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-replace-run-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const allowFirstRunToEnd = deferred<void>();
    const allowSecondRunToEnd = deferred<void>();

    class ReplaceRunSession extends TestAgentSession {
      override async startTurn(): Promise<{ turnId: string }> {
        this.interrupted = false;
        const turnId = `turn-${++this.turnIdCounter}`;
        const turnNum = this.turnIdCounter;

        void (async () => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          if (turnNum === 1) {
            await allowFirstRunToEnd.promise;
            this.pushEvent({ type: "turn_canceled", provider: this.provider, reason: "interrupted", turnId });
          } else {
            await allowSecondRunToEnd.promise;
            this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
          }
        })();
        return { turnId };
      }

      override async interrupt(): Promise<void> {
        this.interrupted = true;
        allowFirstRunToEnd.resolve();
      }
    }

    class ReplaceRunClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new ReplaceRunSession(config);
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new ReplaceRunClient(),
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
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type !== "agent_state" || event.agent.id !== snapshot.id) {
          return;
        }
        lifecycleUpdates.push(event.agent.lifecycle);
      },
      { agentId: snapshot.id, replayState: false },
    );

    const firstRun = manager.streamAgent(snapshot.id, "first run");
    const firstRunDrain = (async () => {
      for await (const _event of firstRun) {
        // Drain events so lifecycle updates are applied.
      }
    })();

    await manager.waitForAgentRunStart(snapshot.id);

    const waitPromise = manager.waitForAgentEvent(snapshot.id);
    const secondRun = manager.replaceAgentRun(snapshot.id, "second run");
    const secondRunDrain = (async () => {
      for await (const _event of secondRun) {
        // Drain replacement run.
      }
    })();

    await manager.waitForAgentRunStart(snapshot.id);

    const prematureResolution = await Promise.race([
      waitPromise.then(() => "resolved"),
      new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    expect(prematureResolution).toBe("pending");

    const runningIndexes = lifecycleUpdates.reduce<number[]>((indexes, status, index) => {
      if (status === "running") {
        indexes.push(index);
      }
      return indexes;
    }, []);
    expect(runningIndexes.length).toBeGreaterThanOrEqual(2);

    const firstReplacementRunningIndex = runningIndexes[1]!;
    expect(lifecycleUpdates.slice(0, firstReplacementRunningIndex).includes("idle")).toBe(false);

    allowSecondRunToEnd.resolve();

    const waited = await waitPromise;
    expect(waited.status).toBe("idle");

    await firstRunDrain;
    await secondRunDrain;
    unsubscribe();
  });

  test("replaceAgentRun stays running when a stale old terminal arrives before the replacement turn is current", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-replace-stale-terminal-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const secondStartEntered = deferred<void>();
    const allowSecondStartToResolve = deferred<void>();
    let capturedSession: StaleReplacementSession | null = null;

    class StaleReplacementSession extends TestAgentSession {
      private localTurnCounter = 0;

      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = `turn-${++this.localTurnCounter}`;
        const turnNum = this.localTurnCounter;

        if (turnNum === 1) {
          setTimeout(() => {
            this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          }, 0);
          return { turnId };
        }

        secondStartEntered.resolve();
        await allowSecondStartToResolve.promise;
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }, 0);
        return { turnId };
      }

      override async interrupt(): Promise<void> {
        this.pushEvent({
          type: "turn_canceled",
          provider: this.provider,
          reason: "Interrupted",
          turnId: "turn-1",
        });
      }
    }

    class StaleReplacementClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        capturedSession = new StaleReplacementSession(config);
        return capturedSession;
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new StaleReplacementClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000126",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const lifecycleUpdates: string[] = [];
    const unsubscribe = manager.subscribe(
      (event) => {
        if (event.type !== "agent_state" || event.agent.id !== snapshot.id) {
          return;
        }
        lifecycleUpdates.push(event.agent.lifecycle);
      },
      { agentId: snapshot.id, replayState: false },
    );

    const firstRun = manager.streamAgent(snapshot.id, "first run");
    const firstRunDrain = (async () => {
      for await (const _event of firstRun) {
        // Drain events so lifecycle updates are applied.
      }
    })();

    await manager.waitForAgentRunStart(snapshot.id);

    const secondRun = manager.replaceAgentRun(snapshot.id, "replacement run");
    const secondRunDrain = (async () => {
      for await (const _event of secondRun) {
        // Drain replacement run.
      }
    })();

    await secondStartEntered.promise;

    const replaceGapSnapshot = manager.getAgent(snapshot.id) as
      | ({ pendingReplacement: boolean; activeForegroundTurnId: string | null; lifecycle: string })
      | undefined;
    expect(replaceGapSnapshot?.pendingReplacement).toBe(false);
    expect(replaceGapSnapshot?.activeForegroundTurnId).toBeNull();
    expect(replaceGapSnapshot?.lifecycle).toBe("running");

    capturedSession!.pushEvent({ type: "turn_completed", provider: "codex", turnId: "turn-1" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // eslint-disable-next-line no-console
    console.log("replace-gap-lifecycle", lifecycleUpdates, manager.getAgent(snapshot.id));
    expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("running");
    expect(lifecycleUpdates.at(-1)).toBe("running");

    allowSecondStartToResolve.resolve();

    await manager.waitForAgentRunStart(snapshot.id);
    await firstRunDrain;
    await secondRunDrain;
    unsubscribe();
  });

  test("applies live autonomous events while no foreground run is active", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-events-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    let capturedSession: TestAgentSession | null = null;

    class LiveEventClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        capturedSession = new TestAgentSession(config);
        return capturedSession;
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
      { agentId: snapshot.id, replayState: false },
    );

    // Push autonomous events through the session's subscribe() callbacks
    const autonomousTurnId = "autonomous-turn-1";
    capturedSession!.pushEvent({ type: "turn_started", provider: "codex", turnId: autonomousTurnId });
    capturedSession!.pushEvent({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "AUTONOMOUS_PUMP_MESSAGE" },
      turnId: autonomousTurnId,
    });
    capturedSession!.pushEvent({ type: "turn_completed", provider: "codex", turnId: autonomousTurnId });
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

  test("cancelAgentRun can interrupt autonomous running state without a foreground activeForegroundTurnId", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-cancel-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class LiveInterruptSession extends TestAgentSession {
      public interruptCount = 0;

      override async interrupt(): Promise<void> {
        this.interruptCount += 1;
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

    const capturedSession = client.lastSession!;

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
        { agentId: snapshot.id, replayState: false },
      );
      capturedSession.pushEvent({ type: "turn_started", provider: "codex", turnId: "autonomous-cancel-1" });
    });

    const beforeCancel = manager.getAgent(snapshot.id);
    expect(beforeCancel?.lifecycle).toBe("running");
    expect(beforeCancel?.activeForegroundTurnId).toBeNull();

    const cancelled = await manager.cancelAgentRun(snapshot.id);
    expect(cancelled).toBe(true);
    expect(client.lastSession?.interruptCount).toBe(1);
  });

  test("waitForAgentEvent waitForActive resolves for autonomous live-event run", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-wait-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    let capturedSession: TestAgentSession | null = null;

    class LiveEventClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = new TestAgentSession(config);
        capturedSession = session;
        return session;
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

    const autonomousTurnId = "autonomous-wait-1";
    const waitPromise = manager.waitForAgentEvent(snapshot.id, { waitForActive: true });
    capturedSession!.pushEvent({ type: "turn_started", provider: "codex", turnId: autonomousTurnId });
    capturedSession!.pushEvent({ type: "turn_completed", provider: "codex", turnId: autonomousTurnId });

    const result = await waitPromise;
    expect(result.status).toBe("idle");
  });

  test("autonomous events arriving during foreground run are processed via subscribe", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-during-fg-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const releaseForeground = deferred<void>();

    let capturedSession: TestAgentSession | null = null;

    class ForegroundSession extends TestAgentSession {
      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = "fg-turn-1";
        setTimeout(async () => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          await releaseForeground.promise;
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }, 0);
        return { turnId };
      }
    }

    class ForegroundClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = new ForegroundSession(config);
        capturedSession = session;
        return session;
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new ForegroundClient(),
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
    const foregroundResults = (async () => {
      const events: AgentStreamEvent[] = [];
      for await (const event of foreground) {
        events.push(event);
      }
      return events;
    })();

    // Wait for the foreground turn to start (lifecycle -> running)
    await new Promise<void>((resolve) => {
      const unsub = manager.subscribe(
        (event) => {
          if (event.type === "agent_state" && event.agent.id === snapshot.id && event.agent.lifecycle === "running") {
            unsub();
            resolve();
          }
        },
        { agentId: snapshot.id, replayState: true },
      );
    });

    // Push autonomous events while foreground is active
    const autonomousTurnId = "autonomous-during-fg-1";
    capturedSession!.pushEvent({ type: "turn_started", provider: "codex", turnId: autonomousTurnId });
    capturedSession!.pushEvent({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "AUTONOMOUS_DURING_FOREGROUND" },
      turnId: autonomousTurnId,
    });
    capturedSession!.pushEvent({ type: "turn_completed", provider: "codex", turnId: autonomousTurnId });

    releaseForeground.resolve();
    const foregroundEvents = await foregroundResults;

    // Foreground stream should contain its own turn events but NOT autonomous events
    expect(foregroundEvents.some((event) => event.type === "turn_completed")).toBe(true);
    expect(
      foregroundEvents.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "assistant_message" &&
          event.item.text.includes("AUTONOMOUS_DURING_FOREGROUND"),
      ),
    ).toBe(false);

    // Autonomous timeline item should still be recorded in the agent timeline
    expect(manager.getTimeline(snapshot.id)).toContainEqual({
      type: "assistant_message",
      text: "AUTONOMOUS_DURING_FOREGROUND",
    });
  });

  test("subscribe error isolation: throwing subscriber does not break event flow", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-subscribe-isolation-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    let capturedSession: TestAgentSession | null = null;

    class IsolationClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        const session = new TestAgentSession(config);
        capturedSession = session;
        return session;
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new IsolationClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000128",
    });

    const snapshot = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
    });

    const receivedEvents: string[] = [];
    const settled = new Promise<void>((resolve) => {
      manager.subscribe(
        (event) => {
          if (event.type === "agent_state" && event.agent.id === snapshot.id && event.agent.lifecycle === "idle") {
            resolve();
          }
          if (event.type === "agent_stream" && event.agentId === snapshot.id) {
            receivedEvents.push(event.event.type);
          }
        },
        { agentId: snapshot.id, replayState: false },
      );
    });

    const autonomousTurnId = "autonomous-isolation-1";
    capturedSession!.pushEvent({ type: "turn_started", provider: "codex", turnId: autonomousTurnId });
    capturedSession!.pushEvent({
      type: "timeline",
      provider: "codex",
      item: { type: "assistant_message", text: "EVENT_AFTER_ERROR" },
      turnId: autonomousTurnId,
    });
    capturedSession!.pushEvent({ type: "turn_completed", provider: "codex", turnId: autonomousTurnId });

    await settled;

    expect(receivedEvents).toContain("turn_started");
    expect(receivedEvents).toContain("timeline");
    expect(receivedEvents).toContain("turn_completed");
    expect(manager.getTimeline(snapshot.id)).toContainEqual({
      type: "assistant_message",
      text: "EVENT_AFTER_ERROR",
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
      // Advance the generator so startTurn runs and lifecycle transitions to running
      await stream.next();
      const afterRunStart = manager.getAgent(snapshot.id);
      expect(afterRunStart).toBeDefined();
      expect(afterRunStart!.updatedAt.getTime()).toBeGreaterThan(messageUpdatedAt);

      // Drain the rest of the stream
      while (true) {
        const next = await stream.next();
        if (next.done) break;
      }
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
      '```json\n{"message":"Reserve space for archive button in sidebar agent list"}\n```';

    class ChunkedAssistantSession implements AgentSession {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      readonly id = randomUUID();
      private subs = new Set<(event: AgentStreamEvent) => void>();
      private turnCounter = 0;

      async run(): Promise<AgentRunResult> {
        return {
          sessionId: this.id,
          finalText: "",
          timeline: [],
        };
      }

      async startTurn(): Promise<{ turnId: string }> {
        const turnId = `chunked-turn-${++this.turnCounter}`;
        setTimeout(() => {
          for (const cb of this.subs) {
            cb({ type: "turn_started", provider: this.provider, turnId });
            cb({
              type: "timeline",
              provider: this.provider,
              item: {
                type: "assistant_message",
                text: '```json\n{"message":"Reserve space for archive button in side',
              },
              turnId,
            });
            cb({
              type: "timeline",
              provider: this.provider,
              item: {
                type: "assistant_message",
                text: 'bar agent list"}\n```',
              },
              turnId,
            });
            cb({ type: "turn_completed", provider: this.provider, turnId });
          }
        }, 0);
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subs.add(callback);
        return () => { this.subs.delete(callback); };
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
      { agentId: internalAgentId, replayState: false },
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
      }),
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

      override async startTurn(): Promise<{ turnId: string }> {
        this.attempt += 1;
        const attempt = this.attempt;
        const turnId = `fail-turn-${attempt}`;
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          this.pushEvent({ type: "turn_failed", provider: this.provider, error: `boom-${attempt}`, turnId });
        }, 0);
        return { turnId };
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

  test("archiveAgent persists archivedAt and updatedAt before emitting closed state", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archive-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const manager = new AgentManager({
      clients: {
        codex: new TestAgentClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000131",
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Archive target",
    });

    const lifecycles: string[] = [];
    manager.subscribe(
      (event) => {
        if (event.type === "agent_state" && event.agent.id === agent.id) {
          lifecycles.push(event.agent.lifecycle);
        }
      },
      { agentId: agent.id, replayState: false },
    );

    const { archivedAt } = await manager.archiveAgent(agent.id);
    const stored = await storage.get(agent.id);

    expect(stored).toMatchObject({
      id: agent.id,
      archivedAt,
      updatedAt: archivedAt,
      lastStatus: "idle",
      requiresAttention: false,
      attentionReason: null,
      attentionTimestamp: null,
    });
    expect(lifecycles.slice(-2)).toEqual(["idle", "closed"]);
  });

  test("turn_failed emits a system error assistant timeline message and keeps error lifecycle", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-turn-failed-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class TurnFailedSession extends TestAgentSession {
      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = "turn-failed-1";
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          this.pushEvent({ type: "turn_failed", provider: this.provider, error: "invalid model id", turnId });
        }, 0);
        return { turnId };
      }
    }

    class TurnFailedClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new TurnFailedSession(config);
      }

      async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
        return new TurnFailedSession({
          provider: "codex",
          cwd: config?.cwd ?? process.cwd(),
        });
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new TurnFailedClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000131",
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Turn failed test",
    });

    await expect(manager.runAgent(agent.id, "hello")).rejects.toThrow("invalid model id");

    const snapshot = manager.getAgent(agent.id);
    expect(snapshot?.lifecycle).toBe("error");
    expect(snapshot?.lastError).toBe("invalid model id");

    const systemErrors = manager
      .getTimeline(agent.id)
      .filter(
        (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
          item.type === "assistant_message" && item.text.includes("[System Error]"),
      );
    expect(systemErrors).toHaveLength(1);
    expect(systemErrors[0]?.text).toContain("invalid model id");
  });

  test("turn_failed surfaces provider code and diagnostic in system error message", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-turn-failed-detail-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    class DetailedFailureSession extends TestAgentSession {
      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = "turn-detailed-fail-1";
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          this.pushEvent({
            type: "turn_failed",
            provider: this.provider,
            error: "Provider execution failed",
            code: "126",
            diagnostic: "No preset version installed for command claude",
            turnId,
          });
        }, 0);
        return { turnId };
      }
    }

    class DetailedFailureClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;

      async isAvailable(): Promise<boolean> {
        return true;
      }

      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new DetailedFailureSession(config);
      }

      async resumeSession(config?: Partial<AgentSessionConfig>): Promise<AgentSession> {
        return new DetailedFailureSession({
          provider: "codex",
          cwd: config?.cwd ?? process.cwd(),
        });
      }
    }

    const manager = new AgentManager({
      clients: {
        codex: new DetailedFailureClient(),
      },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000132",
    });

    const agent = await manager.createAgent({
      provider: "codex",
      cwd: workdir,
      title: "Detailed failure test",
    });

    await expect(manager.runAgent(agent.id, "hello")).rejects.toThrow("Provider execution failed");

    const systemError = manager
      .getTimeline(agent.id)
      .find(
        (item): item is Extract<AgentTimelineItem, { type: "assistant_message" }> =>
          item.type === "assistant_message" && item.text.includes("[System Error]"),
      );
    expect(systemError?.text).toContain("Provider execution failed");
    expect(systemError?.text).toContain("code: 126");
    expect(systemError?.text).toContain("No preset version installed for command claude");
  });

  test("permission request notifies once without forcing unread attention state", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-attention-permission-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    const releasePermissionResolution = deferred<void>();

    class PermissionSession extends TestAgentSession {
      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = "turn-perm-1";
        setTimeout(async () => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          this.pushEvent({
            type: "permission_requested",
            provider: this.provider,
            request: {
              id: "perm-1",
              provider: this.provider,
              kind: "tool",
              name: "Read file",
            },
            turnId,
          });
          await releasePermissionResolution.promise;
          this.pushEvent({
            type: "permission_resolved",
            provider: this.provider,
            requestId: "perm-1",
            resolution: { behavior: "allow" },
            turnId,
          });
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }, 0);
        return { turnId };
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

    // Release permission resolution and drain the rest of the stream
    releasePermissionResolution.resolve();
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
      private subs = new Set<(event: AgentStreamEvent) => void>();
      private turnCounter = 0;

      async run(): Promise<AgentRunResult> {
        return { sessionId: this.id, finalText: "", timeline: [] };
      }

      async startTurn(): Promise<{ turnId: string }> {
        const turnId = `plan-turn-${++this.turnCounter}`;
        setTimeout(() => {
          for (const cb of this.subs) {
            cb({ type: "turn_started", provider: this.provider, turnId });
            cb({ type: "turn_completed", provider: this.provider, turnId });
          }
        }, 0);
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subs.add(callback);
        return () => { this.subs.delete(callback); };
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

      async respondToPermission(_requestId: string, response: { behavior: string }): Promise<void> {
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
      private closed = false;
      private subscribers = new Set<(event: AgentStreamEvent) => void>();
      private turnIdCounter = 0;

      async run(): Promise<AgentRunResult> {
        return { sessionId: this.id, finalText: "", timeline: [] };
      }

      async startTurn(): Promise<{ turnId: string }> {
        const turnId = `turn-${++this.turnIdCounter}`;
        // Push turn_started, then block until closed
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          // The turn will be canceled when close() is called
        }, 0);
        return { turnId };
      }

      subscribe(callback: (event: AgentStreamEvent) => void): () => void {
        this.subscribers.add(callback);
        return () => { this.subscribers.delete(callback); };
      }

      private pushEvent(event: AgentStreamEvent): void {
        for (const cb of this.subscribers) {
          try { cb(event); } catch { /* isolation */ }
        }
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

      async interrupt(): Promise<void> {
        this.closed = true;
        // Push turn_canceled for any active turn
        if (this.turnIdCounter > 0) {
          this.pushEvent({
            type: "turn_canceled",
            provider: this.provider,
            reason: "interrupted",
            turnId: `turn-${this.turnIdCounter}`,
          });
        }
      }

      async close(): Promise<void> {
        this.closed = true;
        this.threadId = null;
        // Push turn_canceled for any active turn
        if (this.turnIdCounter > 0) {
          this.pushEvent({
            type: "turn_canceled",
            provider: this.provider,
            reason: "closed",
            turnId: `turn-${this.turnIdCounter}`,
          });
        }
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
    const userMessagesBefore = beforeHydrate.filter((item) => item.type === "user_message");
    expect(userMessagesBefore).toHaveLength(2);

    // hydrateTimeline replays provider history which includes user_message
    // items. These should NOT create duplicate rows since recordUserMessage
    // already created canonical entries.
    await manager.hydrateTimelineFromProvider(snapshot.id);

    const afterHydrate = manager.getTimeline(snapshot.id);
    const userMessagesAfter = afterHydrate.filter((item) => item.type === "user_message");

    // Should still have exactly 2 user messages, not 4
    expect(userMessagesAfter).toHaveLength(2);

    // Non-user_message items from history should still be replayed
    const assistantMessages = afterHydrate.filter((item) => item.type === "assistant_message");
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
        (item) => (item as Extract<AgentTimelineItem, { type: "user_message" }>).messageId,
      ),
    ).toEqual(["msg_client_hello", "msg_provider_distinct"]);
    expect(userMessages.map((item) => item.text)).toEqual(["hello from user", "hello from user"]);
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
        item.type === "user_message",
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
        item.type === "user_message",
    );
    expect(userMsg).toBeDefined();
    expect(userMsg!.messageId).toBe(clientMsgId);

    // Dispatched stream event should also carry the messageId
    const streamEvent = events.find((e) => e.type === "timeline" && e.item.type === "user_message");
    expect(streamEvent).toBeDefined();
    if (streamEvent?.type === "timeline") {
      expect((streamEvent.item as { type: "user_message"; messageId?: string }).messageId).toBe(
        clientMsgId,
      );
    }
  });

  test("live provider user_message echo is suppressed when recordUserMessage was called first", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-echo-dedup-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);

    // Session whose live turn echoes the user message (as Claude does)
    class EchoUserMessageSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = "turn-echo-1";
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          // Provider echoes user message during live run
          this.pushEvent({
            type: "timeline",
            provider: this.provider,
            item: {
              type: "user_message",
              text: "hello from user",
              messageId: "msg_client_echo_1",
            },
            turnId,
          });
          this.pushEvent({
            type: "timeline",
            provider: this.provider,
            item: { type: "assistant_message", text: "hello from assistant" },
            turnId,
          });
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }, 0);
        return { turnId };
      }
    }

    class EchoClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new EchoUserMessageSession(config);
      }
      async resumeSession(): Promise<AgentSession> {
        throw new Error("unused");
      }
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

    // Run triggers startTurn(), which echoes user_message
    await manager.runAgent(snapshot.id, { text: "hello from user" });

    const timeline = manager.getTimeline(snapshot.id);
    const userMessages = timeline.filter((item) => item.type === "user_message");

    // Should be exactly 1 (canonical), not 2 (canonical + provider echo)
    expect(userMessages).toHaveLength(1);
    // The canonical one must carry the client messageId for optimistic matching
    expect(
      (userMessages[0] as Extract<AgentTimelineItem, { type: "user_message" }>).messageId,
    ).toBe("msg_client_echo_1");

    // Assistant messages from the run should still appear
    const assistantMessages = timeline.filter((item) => item.type === "assistant_message");
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

      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = "turn-diff-msgid-1";
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          this.pushEvent({
            type: "timeline",
            provider: this.provider,
            item: {
              type: "user_message",
              text: "hello from user",
              messageId: "msg_provider_other",
            },
            turnId,
          });
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }, 0);
        return { turnId };
      }
    }

    class DifferentMessageIdClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new DifferentMessageIdSession(config);
      }
      async resumeSession(): Promise<AgentSession> {
        throw new Error("unused");
      }
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
        item.type === "user_message",
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

      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = "turn-no-msgid-1";
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          this.pushEvent({
            type: "timeline",
            provider: this.provider,
            item: { type: "user_message", text: "hello from user" },
            turnId,
          });
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }, 0);
        return { turnId };
      }
    }

    class NoMessageIdClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new NoMessageIdSession(config);
      }
      async resumeSession(): Promise<AgentSession> {
        throw new Error("unused");
      }
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

    // Session whose live turn yields a user_message without prior canonical recording
    class UnexpectedUserMessageSession extends TestAgentSession {
      constructor(config: AgentSessionConfig) {
        super(config);
      }

      override async startTurn(): Promise<{ turnId: string }> {
        const turnId = "turn-unexpected-1";
        setTimeout(() => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          // Provider yields user_message (e.g., system continuation)
          this.pushEvent({
            type: "timeline",
            provider: this.provider,
            item: { type: "user_message", text: "continuation prompt" },
            turnId,
          });
          this.pushEvent({
            type: "timeline",
            provider: this.provider,
            item: { type: "assistant_message", text: "continuation reply" },
            turnId,
          });
          this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
        }, 0);
        return { turnId };
      }
    }

    class UnexpectedUserMsgClient implements AgentClient {
      readonly provider = "codex" as const;
      readonly capabilities = TEST_CAPABILITIES;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new UnexpectedUserMessageSession(config);
      }
      async resumeSession(): Promise<AgentSession> {
        throw new Error("unused");
      }
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
    const userMessages = timeline.filter((item) => item.type === "user_message");

    // Provider's user_message should be recorded (no canonical to dedup against)
    expect(userMessages).toHaveLength(1);
    expect((userMessages[0] as Extract<AgentTimelineItem, { type: "user_message" }>).text).toBe(
      "continuation prompt",
    );
  });

  test("replaceAgentRun succeeds when foreground turn terminal event is never delivered", async () => {
    const workdir = mkdtempSync(join(tmpdir(), "agent-manager-stale-fg-"));
    const storagePath = join(workdir, "agents");
    const storage = new AgentStorage(storagePath, logger);
    const allowSecondRunToEnd = deferred<void>();

    // Session where the first foreground turn never emits a terminal event
    // (simulates the claude-agent pendingInterruptAbort suppression bug),
    // and interrupt() does not produce events either.
    class StaleForegroundSession extends TestAgentSession {
      override async startTurn(): Promise<{ turnId: string }> {
        this.interrupted = false;
        const turnId = `turn-${++this.turnIdCounter}`;
        const turnNum = this.turnIdCounter;

        setTimeout(async () => {
          this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
          if (turnNum === 1) {
            // First turn: emit turn_started but NEVER emit a terminal event.
            // This simulates the provider suppressing the result.
          } else {
            // Subsequent turns: complete normally
            await allowSecondRunToEnd.promise;
            this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
          }
        }, 0);
        return { turnId };
      }

      override async interrupt(): Promise<void> {
        this.interrupted = true;
        // No events produced — the terminal event was suppressed
      }
    }

    class StaleForegroundClient extends TestAgentClient {
      override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
        return new StaleForegroundSession(config);
      }
    }

    const manager = new AgentManager({
      clients: { codex: new StaleForegroundClient() },
      registry: storage,
      logger,
      idFactory: () => "00000000-0000-4000-8000-000000000500",
    });

    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir });

    // Start first foreground run — it will hang (no terminal event)
    const firstRun = manager.streamAgent(snapshot.id, "hanging prompt");
    const firstRunDrain = (async () => {
      for await (const _event of firstRun) {
        // Draining — will hang until force-cleaned
      }
    })();

    await manager.waitForAgentRunStart(snapshot.id);

    const beforeReplace = manager.getAgent(snapshot.id);
    expect(beforeReplace?.lifecycle).toBe("running");
    expect(beforeReplace?.activeForegroundTurnId).toBe("turn-1");

    // Replace the hung run. cancelAgentRun will time out after 2s because
    // no terminal event arrives. After the fix, it should force-clear the
    // stale foreground state so streamAgent can proceed.
    const secondRun = manager.replaceAgentRun(snapshot.id, "replacement prompt");
    const collectedEvents: AgentStreamEvent[] = [];
    const secondRunDrain = (async () => {
      for await (const event of secondRun) {
        collectedEvents.push(event);
      }
    })();

    await manager.waitForAgentRunStart(snapshot.id);
    allowSecondRunToEnd.resolve();

    await secondRunDrain;
    await firstRunDrain;

    expect(collectedEvents.some((e) => e.type === "turn_completed")).toBe(true);
    expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("idle");
    expect(manager.getAgent(snapshot.id)?.activeForegroundTurnId).toBeNull();
  }, 10_000);
});
