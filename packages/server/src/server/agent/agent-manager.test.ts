import { expect, test, vi } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  AgentManager,
  AgentManagerShuttingDownError,
  commandMayHaveChangedExternalState,
  type AgentManagerEvent,
  type ManagedAgent,
} from "./agent-manager.js";
import { AgentStorage } from "./agent-storage.js";
import { toAgentPayload } from "./agent-projections.js";
import { PARENT_AGENT_ID_LABEL } from "@getpaseo/protocol/agent-labels";
import { formatSystemNotificationPrompt } from "./agent-prompt.js";
import { ensureAgentLoaded, ensureUnarchivedAgentLoaded } from "./agent-loading.js";
import type { StoredAgentRecord } from "./agent-storage.js";
import type {
  AgentClient,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentPromptInput,
  AgentProvider,
  AgentPersistenceHandle,
  AgentRunOptions,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  ImportProviderSessionInput,
  ResolveAgentDefaultModeInput,
} from "./agent-sdk-types.js";
import type { PaseoToolCatalog } from "./tools/types.js";
import type { ProviderDefinition } from "./provider-registry.js";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function waitForAgentLifecycle(
  manager: AgentManager,
  agentId: string,
  lifecycle: ManagedAgent["lifecycle"],
): Promise<void> {
  return new Promise<void>((resolve) => {
    const unsubscribe = manager.subscribe(
      (event) => {
        if (
          event.type === "agent_state" &&
          event.agent.id === agentId &&
          event.agent.lifecycle === lifecycle
        ) {
          unsubscribe();
          resolve();
        }
      },
      { agentId, replayState: false },
    );
  });
}

const TEST_CAPABILITIES = {
  supportsStreaming: false,
  supportsSessionPersistence: false,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
} as const;

function createFeature(args: { id: string; label: string; value: boolean }): AgentFeature {
  return {
    type: "toggle",
    id: args.id,
    label: args.label,
    value: args.value,
  };
}

function expectArchivedAgentRecord(
  record: StoredAgentRecord | null,
  expectedLastStatus: "closed" | "idle",
): void {
  expect(record).not.toBeNull();
  expect(record?.archivedAt).toEqual(
    expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
  );
  expect(record?.lastStatus).toBe(expectedLastStatus);
  expect(record?.requiresAttention).toBe(false);
  expect(record?.attentionReason).toBeNull();
  expect(record?.attentionTimestamp).toBeNull();
}

class TestAgentClient implements AgentClient {
  readonly provider: AgentProvider;
  readonly capabilities = TEST_CAPABILITIES;
  readonly createdConfigs: AgentSessionConfig[] = [];
  readonly resumeOverrides: Array<Partial<AgentSessionConfig> | undefined> = [];

  constructor(provider: AgentProvider = "codex") {
    this.provider = provider;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.createdConfigs.push(config);
    return new TestAgentSession(config);
  }

  async fetchCatalog() {
    return {
      models: [
        {
          provider: this.provider,
          id: "gpt-5.4",
          label: "GPT-5.4",
          isDefault: true,
        },
        {
          provider: this.provider,
          id: "gpt-5.4-mini",
          label: "GPT-5.4 Mini",
        },
        {
          provider: this.provider,
          id: "gpt-5.2-codex",
          label: "GPT-5.2 Codex",
        },
      ],
      modes: [],
    };
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumeOverrides.push(config);
    return new TestAgentSession({
      provider: this.provider,
      cwd: config?.cwd ?? process.cwd(),
      daemonAppendSystemPrompt: config?.daemonAppendSystemPrompt,
    });
  }
}

class HeldAgentCreationClient extends TestAgentClient {
  private readonly creationStarted = deferred<void>();
  private readonly creationAllowed = deferred<void>();
  createdSessionClosed = false;

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const recordSessionClosed = () => {
      this.createdSessionClosed = true;
    };
    const session = new (class extends TestAgentSession {
      override async close(): Promise<void> {
        recordSessionClosed();
      }
    })(config);
    this.creationStarted.resolve();
    await this.creationAllowed.promise;
    return session;
  }

  waitForCreationToStart(): Promise<void> {
    return this.creationStarted.promise;
  }

  finishCreating(): void {
    this.creationAllowed.resolve();
  }
}

class HeldAgentCreationAndCloseClient extends TestAgentClient {
  private readonly creationStarted = deferred<void>();
  private readonly creationAllowed = deferred<void>();
  private readonly closeStarted = deferred<void>();
  private readonly closeAllowed = deferred<void>();

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.creationStarted.resolve();
    await this.creationAllowed.promise;
    const signalCloseStarted = () => this.closeStarted.resolve();
    const waitForClose = () => this.closeAllowed.promise;
    return new (class extends TestAgentSession {
      override async close(): Promise<void> {
        signalCloseStarted();
        await waitForClose();
      }
    })(config);
  }

  waitForCreationToStart(): Promise<void> {
    return this.creationStarted.promise;
  }

  finishCreating(): void {
    this.creationAllowed.resolve();
  }

  waitForCloseToStart(): Promise<void> {
    return this.closeStarted.promise;
  }

  finishClosing(): void {
    this.closeAllowed.resolve();
  }
}

class HeldReloadCloseClient extends TestAgentClient {
  private readonly closeStarted = deferred<void>();
  private readonly closeAllowed = deferred<void>();
  originalSessionClosed = false;
  replacementSessionClosed = false;

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const signalCloseStarted = () => this.closeStarted.resolve();
    const waitForClose = () => this.closeAllowed.promise;
    const recordOriginalClosed = () => {
      this.originalSessionClosed = true;
    };
    return new (class extends TestAgentSession {
      override async close(): Promise<void> {
        signalCloseStarted();
        await waitForClose();
        recordOriginalClosed();
      }
    })(config);
  }

  override async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    const recordReplacementClosed = () => {
      this.replacementSessionClosed = true;
    };
    return new (class extends TestAgentSession {
      override async close(): Promise<void> {
        recordReplacementClosed();
      }
    })({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }

  waitForCloseToStart(): Promise<void> {
    return this.closeStarted.promise;
  }

  finishClosing(): void {
    this.closeAllowed.resolve();
  }
}

class NativeArchiveRecordingClient extends TestAgentClient {
  readonly archivedHandles: AgentPersistenceHandle[] = [];
  readonly unarchivedHandles: AgentPersistenceHandle[] = [];
  readArchivedAtDuringUnarchive: (() => Promise<string | null | undefined>) | null = null;
  archivedAtDuringUnarchive: string | null | undefined;
  unarchiveFailure: Error | null = null;

  async archiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    this.archivedHandles.push(handle);
  }

  async unarchiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    this.unarchivedHandles.push(handle);
    if (this.readArchivedAtDuringUnarchive) {
      this.archivedAtDuringUnarchive = await this.readArchivedAtDuringUnarchive();
    }
    if (this.unarchiveFailure) {
      throw this.unarchiveFailure;
    }
  }
}

class EnvProbeAgentClient extends TestAgentClient {
  probe: Promise<{ probe: string | null; agentId: string | null }> | null = null;

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const script = `
      process.stdout.write(JSON.stringify({
        probe: process.env.CHUNK14_PROBE ?? null,
        agentId: process.env.PASEO_AGENT_ID ?? null
      }));
    `;
    const child = spawn(process.execPath, ["-e", script], {
      cwd: config.cwd,
      env: { ...process.env, ...launchContext?.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.probe = new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) {
          reject(new Error(`env probe exited ${code}: ${stderr}`));
          return;
        }
        resolve(JSON.parse(stdout) as { probe: string | null; agentId: string | null });
      });
    });
    return new TestAgentSession(config);
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

class ControlledInterruptSession extends TestAgentSession {
  interruptCalled = false;

  constructor(
    config: AgentSessionConfig,
    readonly turnId: string,
    private readonly interruptBehavior: (session: ControlledInterruptSession) => Promise<void>,
  ) {
    super(config);
  }

  override async startTurn(): Promise<{ turnId: string }> {
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId: this.turnId });
    }, 0);
    return { turnId: this.turnId };
  }

  override async interrupt(): Promise<void> {
    this.interruptCalled = true;
    await this.interruptBehavior(this);
  }
}

interface ControlledInterruptFixture {
  agentId: string;
  manager: AgentManager;
  session: ControlledInterruptSession;
  startForegroundRun(): Promise<void>;
  cleanup(): void;
}

async function createControlledInterruptFixture(options: {
  name: string;
  agentId: string;
  turnId: string;
  interrupt: (session: ControlledInterruptSession) => Promise<void>;
}): Promise<ControlledInterruptFixture> {
  const workdir = mkdtempSync(join(tmpdir(), `agent-manager-${options.name}-`));
  const session = new ControlledInterruptSession(
    { provider: "codex", cwd: workdir },
    options.turnId,
    options.interrupt,
  );
  const client = new (class extends TestAgentClient {
    override async createSession(): Promise<AgentSession> {
      return session;
    }
  })();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: new AgentStorage(join(workdir, "agents"), logger),
    logger,
    rescueTimeouts: { interruptSessionMs: 10 },
    idFactory: () => options.agentId,
  });
  const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  return {
    agentId: agent.id,
    manager,
    session,
    async startForegroundRun() {
      const run = manager.streamAgent(agent.id, "exercise cancellation");
      void (async () => {
        for await (const _event of run) {
          // Keep the foreground stream subscribed until the controlled turn settles.
        }
      })();
      await manager.waitForAgentRunStart(agent.id);
    },
    cleanup: () => rmSync(workdir, { recursive: true, force: true }),
  };
}

class HeldRuntimeInfoSession extends TestAgentSession {
  private readonly runtimeInfoRequested = deferred<void>();
  private readonly runtimeInfoAllowed = deferred<void>();

  override async getRuntimeInfo() {
    this.runtimeInfoRequested.resolve();
    await this.runtimeInfoAllowed.promise;
    return await super.getRuntimeInfo();
  }

  waitForRuntimeInfo(): Promise<void> {
    return this.runtimeInfoRequested.promise;
  }

  finishRuntimeInfo(): void {
    this.runtimeInfoAllowed.resolve();
  }
}

class HeldRuntimeInfoClient extends TestAgentClient {
  private readonly sessionCreated = deferred<HeldRuntimeInfoSession>();
  private session: HeldRuntimeInfoSession | null = null;

  override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    this.session = new HeldRuntimeInfoSession(config);
    this.sessionCreated.resolve(this.session);
    return this.session;
  }

  async waitForRuntimeInfo(): Promise<void> {
    const session = await this.sessionCreated.promise;
    await session.waitForRuntimeInfo();
  }

  finishRuntimeInfo(): void {
    this.requireSession().finishRuntimeInfo();
  }

  private requireSession(): HeldRuntimeInfoSession {
    if (!this.session) {
      throw new Error("Expected a created session");
    }
    return this.session;
  }
}

class StreamingAssistantSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;
  readonly id = randomUUID();
  private subscribers = new Set<(event: AgentStreamEvent) => void>();
  private turnIdCounter = 0;

  constructor(private readonly config: AgentSessionConfig) {}

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: this.id,
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(): Promise<{ turnId: string }> {
    const turnId = `turn-${++this.turnIdCounter}`;
    setTimeout(() => {
      this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
      this.pushEvent({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: "final " },
      });
      this.pushEvent({
        type: "timeline",
        provider: this.provider,
        turnId,
        item: { type: "assistant_message", text: "reply" },
      });
      this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
    }, 0);
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  private pushEvent(event: AgentStreamEvent): void {
    for (const callback of this.subscribers) {
      callback(event);
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: this.config.model ?? null,
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

class StreamingAssistantClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities = TEST_CAPABILITIES;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    return new StreamingAssistantSession(config);
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    config?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    return new StreamingAssistantSession({
      provider: "codex",
      cwd: config?.cwd ?? process.cwd(),
    });
  }
}

interface FakeCodexEmitterArgs {
  turnItems?: AgentTimelineItem[];
  historyItems?: AgentTimelineItem[];
}

function fakeCodexEmitting(args: FakeCodexEmitterArgs): AgentClient {
  const turnItems = args.turnItems ?? [];
  const historyItems = args.historyItems ?? [];

  class FakeCodexSession extends TestAgentSession {
    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "turn-fake-codex";
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        for (const item of turnItems) {
          this.pushEvent({ type: "timeline", provider: this.provider, item, turnId });
        }
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }

    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      for (const item of historyItems) {
        yield { type: "timeline", provider: this.provider, item };
      }
    }
  }

  return {
    provider: "codex",
    capabilities: TEST_CAPABILITIES,
    async isAvailable() {
      return true;
    },
    async createSession(config: AgentSessionConfig) {
      return new FakeCodexSession(config);
    },
    async resumeSession() {
      throw new Error("unused");
    },
  };
}

const logger = createTestLogger();

test("does not register a session that finishes starting after shutdown begins", async () => {
  const client = new HeldAgentCreationClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000100",
  });

  const creation = manager.createAgent(
    {
      provider: "codex",
      cwd: process.cwd(),
    },
    undefined,
    { workspaceId: undefined },
  );
  await client.waitForCreationToStart();

  manager.prepareForShutdown();
  client.finishCreating();

  await expect(creation).rejects.toThrow("Agent manager is shutting down");
  expect({ agents: manager.listAgents(), sessionClosed: client.createdSessionClosed }).toEqual({
    agents: [],
    sessionClosed: true,
  });
});

test("flush waits for rejected session cleanup that starts after shutdown", async () => {
  const client = new HeldAgentCreationAndCloseClient();
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000098",
  });

  const creation = manager
    .createAgent(
      {
        provider: "codex",
        cwd: process.cwd(),
      },
      undefined,
      { workspaceId: undefined },
    )
    .catch((error: unknown) => error);
  await client.waitForCreationToStart();

  manager.prepareForShutdown();
  let flushResolved = false;
  const flushing = manager.flushForShutdown().then(() => {
    flushResolved = true;
    return undefined;
  });
  client.finishCreating();
  await client.waitForCloseToStart();

  try {
    expect(flushResolved).toBe(false);
  } finally {
    client.finishClosing();
  }

  expect(await creation).toBeInstanceOf(AgentManagerShuttingDownError);
  await flushing;
  expect(manager.listAgents()).toEqual([]);
});

test("does not persist an initializing session after shutdown closes it", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-shutdown-register-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new HeldRuntimeInfoClient();
  const agentId = "00000000-0000-4000-8000-000000000099";
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });

  try {
    const creation = manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );
    await client.waitForRuntimeInfo();

    manager.prepareForShutdown();
    const closing = manager.closeAgent(agentId);
    client.finishRuntimeInfo();

    await expect(creation).rejects.toBeInstanceOf(AgentManagerShuttingDownError);
    await closing;
    await storage.flush();
    expect({ agents: manager.listAgents(), record: await storage.get(agentId) }).toMatchObject({
      agents: [],
      record: { lastStatus: "closed" },
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("reload leaves a closed durable snapshot when shutdown starts during the swap", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-shutdown-reload-test-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new HeldReloadCloseClient();
  const agentId = "00000000-0000-4000-8000-000000000097";
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });

  try {
    await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );
    const reload = manager.reloadAgentSession(agentId).catch((error: unknown) => error);
    await client.waitForCloseToStart();

    manager.prepareForShutdown();
    const closing = Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id)));
    client.finishClosing();

    await closing;
    expect(await reload).toBeInstanceOf(AgentManagerShuttingDownError);
    await manager.flush();
    await storage.flush();
    expect({
      agents: manager.listAgents(),
      record: await storage.get(agentId),
      replacementSessionClosed: client.replacementSessionClosed,
    }).toMatchObject({
      agents: [],
      record: { lastStatus: "closed" },
      replacementSessionClosed: true,
    });
  } finally {
    client.finishClosing();
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("reload closes both sessions when the closed snapshot cannot be persisted", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-persist-failure-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new HeldReloadCloseClient();
  const agentId = "00000000-0000-4000-8000-000000000096";
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => agentId,
  });

  try {
    await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );
    await storage.flush();
    rmSync(storagePath, { recursive: true, force: true });
    writeFileSync(storagePath, "blocks the storage directory");

    const reload = manager.reloadAgentSession(agentId).catch((error: unknown) => error);
    await client.waitForCloseToStart();
    client.finishClosing();

    expect(await reload).toBeInstanceOf(Error);
    await manager.flushForShutdown();
    expect({
      agents: manager.listAgents(),
      originalSessionClosed: client.originalSessionClosed,
      replacementSessionClosed: client.replacementSessionClosed,
    }).toEqual({
      agents: [],
      originalSessionClosed: true,
      replacementSessionClosed: true,
    });
  } finally {
    client.finishClosing();
    await manager.flushForShutdown().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("normalizeConfig injects the provider default model when omitted", async () => {
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.config.model).toBe("gpt-5.4");
  expect(snapshot.config.modeId).toBe("auto-review");
});

test("normalizeConfig injects Claude's automatic approval default when omitted", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-claude-default-test-"));
  const manager = new AgentManager({
    clients: { claude: new TestAgentClient("claude") },
    logger,
  });

  const snapshot = await manager.createAgent({ provider: "claude", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  expect(snapshot.config.modeId).toBe("auto");
});

test("normalizeConfig uses a capability-aware provider mode default", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-mode-default-test-"));
  class CapabilityAwareClient extends TestAgentClient {
    override async resolveDefaultModeId(input: ResolveAgentDefaultModeInput): Promise<string> {
      return input.env?.CLAUDE_CODE_USE_BEDROCK === "1" ? "default" : "auto";
    }
  }
  const manager = new AgentManager({
    clients: { codex: new CapabilityAwareClient() },
    logger,
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
    env: { CLAUDE_CODE_USE_BEDROCK: "1" },
  });

  expect(snapshot.config.modeId).toBe("default");
});

test("createAgent forwards request env into the spawned provider process", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-env-test-"));
  const client = new EnvProbeAgentClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    logger,
    idFactory: () => "00000000-0000-4000-8000-00000000e001",
  });

  try {
    await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      {
        env: {
          CHUNK14_PROBE: "expected",
        },
        workspaceId: undefined,
      },
    );

    await expect(client.probe).resolves.toEqual({
      probe: "expected",
      agentId: "00000000-0000-4000-8000-00000000e001",
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      model: "default",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.config.model).toBe("gpt-5.4");
  expect(snapshot.config.modeId).toBe("auto-review");
});

test("listDraftCommands returns no commands without guessing a missing model", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-draft-commands-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  class DraftCommandClient extends TestAgentClient {
    fetchCatalogCalls = 0;
    createSessionCalls = 0;
    availabilityCalls = 0;

    override async isAvailable(): Promise<boolean> {
      this.availabilityCalls += 1;
      return true;
    }

    override async fetchCatalog() {
      this.fetchCatalogCalls += 1;
      return await super.fetchCatalog();
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }
  }
  const client = new DraftCommandClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  await expect(manager.listDraftCommands({ provider: "codex", cwd: workdir })).resolves.toEqual([]);

  expect(client.fetchCatalogCalls).toBe(0);
  expect(client.createSessionCalls).toBe(0);
  expect(client.availabilityCalls).toBe(0);
});

test("listDraftCommands uses explicit model config without default model fetching", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-draft-commands-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const draftCommand: AgentSlashCommand = {
    name: "review",
    description: "Review changes",
    argumentHint: "",
    kind: "command",
  };
  class DraftCommandSession extends TestAgentSession {
    override async listCommands(): Promise<AgentSlashCommand[]> {
      return [draftCommand];
    }
  }
  class DraftCommandClient extends TestAgentClient {
    fetchCatalogCalls = 0;
    createSessionCalls = 0;
    readonly commandConfigs: AgentSessionConfig[] = [];

    override async fetchCatalog() {
      this.fetchCatalogCalls += 1;
      return await super.fetchCatalog();
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      this.commandConfigs.push(config);
      return new DraftCommandSession(config);
    }
  }
  const client = new DraftCommandClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  const commands = await manager.listDraftCommands({
    provider: "codex",
    cwd: workdir,
    model: "gpt-5.4",
  });

  expect(commands).toEqual([draftCommand]);
  expect(client.fetchCatalogCalls).toBe(0);
  expect(client.createSessionCalls).toBe(1);
  expect(client.commandConfigs).toEqual([
    {
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.4",
      modeId: "auto-review",
    },
  ]);
});

test("listDraftFeatures returns no features without guessing a missing model", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-draft-features-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  class DraftFeatureClient extends TestAgentClient {
    fetchCatalogCalls = 0;
    createSessionCalls = 0;
    availabilityCalls = 0;
    readonly featureConfigs: AgentSessionConfig[] = [];

    override async isAvailable(): Promise<boolean> {
      this.availabilityCalls += 1;
      return true;
    }

    override async fetchCatalog() {
      this.fetchCatalogCalls += 1;
      return await super.fetchCatalog();
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }

    async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
      this.featureConfigs.push(config);
      return [createFeature({ id: "fast_mode", label: "Fast mode", value: false })];
    }
  }
  const client = new DraftFeatureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  await expect(manager.listDraftFeatures({ provider: "codex", cwd: workdir })).resolves.toEqual([]);

  expect(client.fetchCatalogCalls).toBe(0);
  expect(client.createSessionCalls).toBe(0);
  expect(client.availabilityCalls).toBe(0);
  expect(client.featureConfigs).toEqual([]);
});

test("listDraftFeatures uses explicit model config without default model fetching", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-draft-features-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const draftFeature = createFeature({ id: "fast_mode", label: "Fast mode", value: false });
  class DraftFeatureClient extends TestAgentClient {
    fetchCatalogCalls = 0;
    createSessionCalls = 0;
    readonly featureConfigs: AgentSessionConfig[] = [];

    override async fetchCatalog() {
      this.fetchCatalogCalls += 1;
      return await super.fetchCatalog();
    }

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }

    async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
      this.featureConfigs.push(config);
      return [draftFeature];
    }
  }
  const client = new DraftFeatureClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  const features = await manager.listDraftFeatures({
    provider: "codex",
    cwd: workdir,
    model: "gpt-5.4",
  });

  expect(features).toEqual([draftFeature]);
  expect(client.fetchCatalogCalls).toBe(0);
  expect(client.createSessionCalls).toBe(0);
  expect(client.featureConfigs).toEqual([
    {
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.4",
      modeId: "auto-review",
    },
  ]);
});

test("createAgent injects daemon append system prompt at runtime only", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    appendSystemPrompt: "  Daemon instructions.  ",
    idFactory: () => "00000000-0000-4000-8000-000000000103",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      systemPrompt: "Agent instructions.",
    },
    undefined,
    { workspaceId: undefined },
  );
  const record = await storage.get(snapshot.id);

  expect(client.createdConfigs[0]?.systemPrompt).toBe("Agent instructions.");
  expect(client.createdConfigs[0]?.daemonAppendSystemPrompt).toBe("Daemon instructions.");
  expect(snapshot.config).not.toHaveProperty("daemonAppendSystemPrompt");
  expect(record?.config?.systemPrompt).toBe("Agent instructions.");
  expect(record?.config).not.toHaveProperty("daemonAppendSystemPrompt");
});

test("daemon append system prompt is injected into Pi configs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: {
      pi: client as unknown as AgentClient,
    },
    providerDefinitions: {
      pi: { enabled: true },
    },
    registry: storage,
    logger,
    appendSystemPrompt: "Daemon instructions.",
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  await manager.createAgent(
    {
      provider: "pi",
      cwd: workdir,
      systemPrompt: "Agent instructions.",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.createdConfigs[0]?.daemonAppendSystemPrompt).toBe("Daemon instructions.");
});

test("setAgentMode persists the selected mode across session reload", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class ModeAwareSession implements AgentSession {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    readonly id = randomUUID();
    private currentMode: string | null;

    constructor(private readonly config: AgentSessionConfig) {
      this.currentMode = config.modeId ?? null;
    }

    async run(): Promise<AgentRunResult> {
      return { sessionId: this.id, finalText: "", timeline: [] };
    }

    async startTurn(): Promise<{ turnId: string }> {
      return { turnId: "turn-1" };
    }

    subscribe(): () => void {
      return () => {};
    }

    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

    async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.id,
        model: this.config.model ?? null,
        modeId: this.currentMode,
      };
    }

    async getAvailableModes() {
      return [];
    }

    async getCurrentMode() {
      return this.currentMode;
    }

    async setMode(modeId: string): Promise<void> {
      this.currentMode = modeId;
    }

    getPendingPermissions() {
      return [];
    }

    async respondToPermission(): Promise<void> {}

    describePersistence() {
      return { provider: this.provider, sessionId: this.id };
    }

    async interrupt(): Promise<void> {}
    async close(): Promise<void> {}
  }

  class ModeAwareClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ModeAwareSession(config);
    }

    async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new ModeAwareSession({
        provider: "codex",
        cwd: config?.cwd ?? workdir,
        modeId: config?.modeId,
        model: config?.model,
      });
    }

    async fetchCatalog() {
      return {
        models: [{ provider: "codex", id: "gpt-5.4", label: "GPT-5.4", isDefault: true }],
        modes: [],
      };
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ModeAwareClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000301",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      modeId: "auto",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.setAgentMode(snapshot.id, "full-access");

  const beforeReload = manager.getAgent(snapshot.id);
  expect(beforeReload?.config.modeId).toBe("full-access");
  expect(beforeReload?.currentModeId).toBe("full-access");

  const reloaded = await manager.reloadAgentSession(snapshot.id);
  expect(reloaded.config.modeId).toBe("full-access");
  expect(reloaded.currentModeId).toBe("full-access");
});

test("reloadAgentSession completes when the previous session close hangs", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-reload-close-timeout-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class HangingCloseSession extends TestAgentSession {
    closeCalled = false;

    override async close(): Promise<void> {
      this.closeCalled = true;
      await new Promise(() => {});
    }
  }

  class HangingCloseClient extends TestAgentClient {
    readonly firstSession = new HangingCloseSession({
      provider: "codex",
      cwd: workdir,
    });
    resumeSessionCalls = 0;

    override async createSession(): Promise<AgentSession> {
      return this.firstSession;
    }

    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      this.resumeSessionCalls += 1;
      return new TestAgentSession({
        provider: "codex",
        cwd: config?.cwd ?? workdir,
      });
    }
  }

  const client = new HangingCloseClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    rescueTimeouts: { reloadSessionCloseMs: 10 },
    idFactory: () => "00000000-0000-4000-8000-000000000302",
  });

  try {
    const snapshot = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );

    const reloaded = await manager.reloadAgentSession(snapshot.id);

    expect(reloaded.id).toBe(snapshot.id);
    expect(client.firstSession.closeCalled).toBe(true);
    expect(client.resumeSessionCalls).toBe(1);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("cancelAgentRun preserves running state when the provider interrupt hangs", async () => {
  const fixture = await createControlledInterruptFixture({
    name: "interrupt-timeout",
    agentId: "00000000-0000-4000-8000-000000000303",
    turnId: "hanging-interrupt-turn",
    interrupt: async () => await new Promise(() => {}),
  });

  try {
    const running = waitForAgentLifecycle(fixture.manager, fixture.agentId, "running");
    fixture.session.pushEvent({
      type: "turn_started",
      provider: "codex",
      turnId: "hanging-interrupt-turn",
    });
    await running;

    await expect(fixture.manager.cancelAgentRun(fixture.agentId)).resolves.toEqual({
      status: "refused",
    });
    expect(fixture.session.interruptCalled).toBe(true);
    expect(fixture.manager.getAgent(fixture.agentId)?.lifecycle).toBe("running");
  } finally {
    fixture.cleanup();
  }
});

test("cancelAgentRun preserves the active turn when the provider rejects the interrupt", async () => {
  const fixture = await createControlledInterruptFixture({
    name: "interrupt-rejected",
    agentId: "00000000-0000-4000-8000-000000000304",
    turnId: "provider-still-active-turn",
    interrupt: async () => {
      throw new Error("A foreground turn is already active");
    },
  });

  try {
    await fixture.startForegroundRun();

    await expect(fixture.manager.cancelAgentRun(fixture.agentId)).resolves.toEqual({
      status: "refused",
    });
    expect(fixture.manager.getAgent(fixture.agentId)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: "provider-still-active-turn",
    });

    fixture.session.pushEvent({
      type: "turn_completed",
      provider: "codex",
      turnId: "provider-still-active-turn",
    });
  } finally {
    fixture.cleanup();
  }
});

test("cancelAgentRun succeeds when the foreground turn finishes before the provider rejects the interrupt", async () => {
  let fixture!: ControlledInterruptFixture;
  fixture = await createControlledInterruptFixture({
    name: "interrupt-after-completion",
    agentId: "00000000-0000-4000-8000-000000000305",
    turnId: "naturally-completed-turn",
    interrupt: async (session) => {
      const settled = waitForAgentLifecycle(fixture.manager, fixture.agentId, "idle");
      session.pushEvent({
        type: "turn_completed",
        provider: session.provider,
        turnId: "naturally-completed-turn",
      });
      await settled;
      throw new Error("turn already completed");
    },
  });

  try {
    await fixture.startForegroundRun();

    await expect(fixture.manager.cancelAgentRun(fixture.agentId)).resolves.toEqual({
      status: "settled",
    });
    expect(fixture.manager.getAgent(fixture.agentId)).toMatchObject({
      lifecycle: "idle",
      activeForegroundTurnId: null,
    });
  } finally {
    fixture.cleanup();
  }
});

test("cancelAgentRun succeeds when the provider queues completion before rejecting the interrupt", async () => {
  const fixture = await createControlledInterruptFixture({
    name: "interrupt-queued-completion",
    agentId: "00000000-0000-4000-8000-000000000306",
    turnId: "queued-completion-turn",
    interrupt: async (session) => {
      session.pushEvent({
        type: "turn_completed",
        provider: session.provider,
        turnId: "queued-completion-turn",
      });
      throw new Error("turn already completed");
    },
  });

  try {
    await fixture.startForegroundRun();

    await expect(fixture.manager.cancelAgentRun(fixture.agentId)).resolves.toEqual({
      status: "settled",
    });
    expect(fixture.manager.getAgent(fixture.agentId)).toMatchObject({
      lifecycle: "idle",
      activeForegroundTurnId: null,
    });
  } finally {
    fixture.cleanup();
  }
});

test("listProviderAvailability uses registered client keys, including custom providers", async () => {
  const customClient: AgentClient = {
    provider: "zai",
    capabilities: TEST_CAPABILITIES,
    async isAvailable() {
      return true;
    },
    async createSession() {
      throw new Error("not implemented");
    },
    async resumeSession() {
      throw new Error("not implemented");
    },
  };

  const manager = new AgentManager({
    clients: {
      zai: customClient,
    },
    logger,
  });

  await expect(manager.listProviderAvailability()).resolves.toEqual([
    {
      provider: "zai",
      available: true,
      error: null,
    },
  ]);
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.lastConfig).toEqual({
    provider: "codex",
    cwd: workdir,
    model: "gpt-5.4",
    modeId: "auto-review",
  });
  expect(client.lastLaunchContext).toEqual({
    agentId: snapshot.id,
    env: {
      PASEO_AGENT_ID: snapshot.id,
    },
  });
});

test("createAgent passes persistSession to provider create options", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastCreateOptions: AgentCreateSessionOptions | undefined;

    override async createSession(
      config: AgentSessionConfig,
      _launchContext?: AgentLaunchContext,
      options?: AgentCreateSessionOptions,
    ): Promise<AgentSession> {
      this.lastCreateOptions = options;
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
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { persistSession: false, workspaceId: undefined },
  );

  expect(client.lastCreateOptions).toEqual({ persistSession: false });

  rmSync(workdir, { recursive: true, force: true });
});

test("createAgent persists workspaceId on the stored record and emits it in the snapshot", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-0000000000a1",
  });

  try {
    const agent = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: "wks_owner" },
    );

    expect(agent.workspaceId).toBe("wks_owner");
    expect(toAgentPayload(agent).workspaceId).toBe("wks_owner");

    const record = await storage.get(agent.id);
    expect(record?.workspaceId).toBe("wks_owner");
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("createAgent injects paseo MCP server only into provider launch config", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.lastConfig = config;
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
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    idFactory: () => "00000000-0000-4000-8000-000000000103",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      mcpServers: {
        custom: {
          type: "stdio",
          command: "custom-mcp",
        },
      },
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.config.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
  expect(client.lastConfig?.mcpServers).toEqual({
    paseo: {
      type: "http",
      url: `http://127.0.0.1:6767/mcp/agents?callerAgentId=${snapshot.id}`,
    },
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });

  const stored = await storage.get(snapshot.id);
  expect(stored?.config?.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
});

test("createAgent passes native Paseo tools through launch context without internal MCP", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  const paseoTools: PaseoToolCatalog = {
    tools: new Map(),
    getTool: () => undefined,
    executeTool: async () => {
      throw new Error("No tools registered in test catalog");
    },
  };

  class NativeToolsClient extends TestAgentClient {
    override readonly capabilities = {
      ...TEST_CAPABILITIES,
      supportsMcpServers: true,
      supportsNativePaseoTools: true,
    };
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

  const client = new NativeToolsClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    paseoToolCatalogFactory: () => paseoTools,
    idFactory: () => "00000000-0000-4000-8000-000000000106",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      mcpServers: {
        custom: {
          type: "stdio",
          command: "custom-mcp",
        },
      },
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.lastLaunchContext?.paseoTools).toBe(paseoTools);
  expect(client.lastConfig?.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
  expect(snapshot.config.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });

  const stored = await storage.get(snapshot.id);
  expect(stored?.config?.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
});

test("createAgent injects the MCP auth token as a bearer header into the launch config", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.lastConfig = config;
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
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    mcpAuthToken: "cap-token",
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(manager.getMcpAuthToken()).toBe("cap-token");
  expect(client.lastConfig?.mcpServers?.paseo).toEqual({
    type: "http",
    url: `http://127.0.0.1:6767/mcp/agents?callerAgentId=${snapshot.id}`,
    headers: { Authorization: "Bearer cap-token" },
  });

  rmSync(workdir, { recursive: true, force: true });
});

test("resumeAgentFromPersistence replaces stored internal paseo MCP with current runtime URL", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
    mcpBaseUrl: "http://127.0.0.1:6768/mcp/agents",
    idFactory: () => "00000000-0000-4000-8000-000000000105",
  });
  const handle: AgentPersistenceHandle = {
    provider: "codex",
    sessionId: "session-123",
    metadata: {
      cwd: workdir,
    },
  };

  const snapshot = await manager.resumeAgentFromPersistence(handle, {
    cwd: workdir,
    mcpServers: {
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=stale-agent",
      },
      custom: {
        type: "stdio",
        command: "custom-mcp",
      },
    },
  });

  expect(client.resumeOverrides[0]?.mcpServers).toEqual({
    paseo: {
      type: "http",
      url: `http://127.0.0.1:6768/mcp/agents?callerAgentId=${snapshot.id}`,
    },
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
  expect(snapshot.config.mcpServers).toEqual({
    custom: {
      type: "stdio",
      command: "custom-mcp",
    },
  });
});

test("resumeAgentFromPersistence drops stored internal paseo MCP when runtime injection is disabled", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });
  const handle: AgentPersistenceHandle = {
    provider: "codex",
    sessionId: "session-123",
    metadata: {
      cwd: workdir,
    },
  };

  const snapshot = await manager.resumeAgentFromPersistence(handle, {
    cwd: workdir,
    mcpServers: {
      paseo: {
        type: "http",
        url: "http://127.0.0.1:6767/mcp/agents?callerAgentId=stale-agent",
      },
    },
  });

  expect(client.resumeOverrides[0]?.mcpServers).toBeUndefined();
  expect(snapshot.config.mcpServers).toBeUndefined();
});

test("createAgent preserves a user-provided paseo MCP config", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class CaptureClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.lastConfig = config;
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
    mcpBaseUrl: "http://127.0.0.1:6767/mcp/agents",
    idFactory: () => "00000000-0000-4000-8000-000000000104",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      mcpServers: {
        paseo: {
          type: "http",
          url: "https://example.com/custom-paseo",
        },
      },
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.config.mcpServers).toEqual({
    paseo: {
      type: "http",
      url: "https://example.com/custom-paseo",
    },
  });
  expect(client.lastConfig?.mcpServers).toEqual(snapshot.config.mcpServers);
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
    manager.createAgent(
      {
        provider: "codex",
        cwd: join(workdir, "does-not-exist"),
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("Working directory does not exist");
});

test("createAgent reports configured providers when provider is unknown", async () => {
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
        provider: "missing-provider",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("Unknown provider 'missing-provider'. Configured providers: codex.");
});

test("createAgent reports available providers when selected provider is unavailable", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class UnavailableCodexClient extends TestAgentClient {
    override async isAvailable(): Promise<boolean> {
      return false;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new UnavailableCodexClient(),
      claude: new TestAgentClient(),
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
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow(
    "Provider 'codex' is not available. Available providers: claude. Use one of those providers, or install/configure 'codex'.",
  );
});

test("createAgent rejects a disabled provider without creating a session", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class DisabledCodexClient extends TestAgentClient {
    createSessionCalls = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }
  }

  const disabledClient = new DisabledCodexClient();
  const providerDefinitions = {
    codex: {
      enabled: false,
    },
  } satisfies Partial<Record<AgentProvider, Pick<ProviderDefinition, "enabled">>>;
  const manager = new AgentManager({
    clients: {
      codex: disabledClient,
    },
    providerDefinitions,
    registry: storage,
    logger,
  });

  await expect(
    manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    ),
  ).rejects.toThrow("Provider 'codex' is disabled");
  expect(disabledClient.createSessionCalls).toBe(0);
  expect(await storage.list()).toHaveLength(0);
});

test("updateProviderRegistry re-enables a previously disabled provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: { codex: client },
    providerDefinitions: {
      codex: { enabled: false },
    },
    registry: storage,
    logger,
  });

  await expect(
    manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    }),
  ).rejects.toThrow("Provider 'codex' is disabled");

  manager.updateProviderRegistry({
    providerDefinitions: { codex: { enabled: true } },
    clients: { codex: client },
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  expect(snapshot.config.provider).toBe("codex");
});

test("updateProviderRegistry disables a previously enabled provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new TestAgentClient();
  const manager = new AgentManager({
    clients: { codex: client },
    providerDefinitions: {
      codex: { enabled: true },
    },
    registry: storage,
    logger,
  });

  manager.updateProviderRegistry({
    providerDefinitions: { codex: { enabled: false } },
    clients: { codex: client },
  });

  await expect(
    manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    }),
  ).rejects.toThrow("Provider 'codex' is disabled");
});

test("updateProviderRegistry registers a previously unknown provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {},
    providerDefinitions: {},
    registry: storage,
    logger,
  });

  expect(manager.getRegisteredProviderIds()).not.toContain("codex");

  manager.updateProviderRegistry({
    providerDefinitions: { codex: { enabled: true } },
    clients: { codex: new TestAgentClient() },
  });

  expect(manager.getRegisteredProviderIds()).toContain("codex");
  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  expect(snapshot.config.provider).toBe("codex");
});

test("updateProviderRegistry removes providers omitted from the next registry", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const removedProvider = "zai-claude" as AgentProvider;
  class RemovedProviderClient extends TestAgentClient {
    createSessionCalls = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.createSessionCalls += 1;
      return await super.createSession(config);
    }
  }

  const removedClient = new RemovedProviderClient();
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient(), [removedProvider]: removedClient },
    providerDefinitions: {
      codex: { enabled: true },
      [removedProvider]: { enabled: true },
    },
    registry: storage,
    logger,
  });

  expect(manager.getRegisteredProviderIds()).toContain(removedProvider);

  manager.updateProviderRegistry({
    providerDefinitions: { codex: { enabled: true } },
    clients: { codex: new TestAgentClient() },
  });

  expect(manager.getRegisteredProviderIds()).not.toContain(removedProvider);
  await expect(
    manager.createAgent({ provider: removedProvider, cwd: workdir }, undefined, {
      workspaceId: undefined,
    }),
  ).rejects.toThrow("Unknown provider 'zai-claude'");
  expect(removedClient.createSessionCalls).toBe(0);
});

test("createAgent passes explicit model strings through to the provider", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  class CaptureModelClient extends TestAgentClient {
    lastConfig: AgentSessionConfig | null = null;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      this.lastConfig = config;
      return new TestAgentSession(config);
    }
  }
  const client = new CaptureModelClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });

  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      model: "not-a-real-model",
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.lastConfig?.model).toBe("not-a-real-model");
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

    async fetchCatalog() {
      return {
        models: [
          {
            provider: "codex",
            id: "gpt-5.4",
            label: "GPT-5.4",
            isDefault: true,
          },
        ],
        modes: [],
      };
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
    model: "gpt-5.4",
    modeId: "auto-review",
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
    agentId: resumed.id,
    env: {
      PASEO_AGENT_ID: resumed.id,
    },
  });
});

test("importProviderSession imports the selected session without listing and publishes ready state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-import-session-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const session = new TestAgentSession({ provider: "codex", cwd: workdir });
  const events: AgentManagerEvent[] = [];

  class ImportClient extends TestAgentClient {
    listCalls = 0;
    importInput: unknown = null;

    async listImportableSessions() {
      this.listCalls += 1;
      return [];
    }

    async importSession(input: ImportProviderSessionInput) {
      this.importInput = input;
      return {
        session,
        config: { provider: "codex" as const, cwd: workdir },
        persistence: {
          provider: "codex" as const,
          sessionId: input.providerHandleId,
          nativeHandle: input.providerHandleId,
          metadata: { provider: "codex", cwd: workdir },
        },
        timeline: [
          {
            item: { type: "user_message" as const, text: "Trace provider imports" },
            timestamp: "2026-01-02T00:00:00.000Z",
          },
          {
            item: { type: "assistant_message" as const, text: "Done" },
            timestamp: "2026-01-02T00:00:01.000Z",
          },
          {
            item: {
              type: "tool_call" as const,
              callId: "large-shell-result",
              name: "shell",
              status: "completed" as const,
              error: null,
              detail: {
                type: "shell" as const,
                command: "print output",
                output: "x".repeat(1024 * 1024),
                exitCode: 0,
              },
            },
            timestamp: "2026-01-02T00:00:02.000Z",
          },
        ],
        providerSubagentEvents: [
          {
            type: "provider_subagent" as const,
            provider: "codex" as const,
            event: {
              type: "upsert" as const,
              id: "thread-child",
              title: "Imported child",
              status: "completed" as const,
            },
          },
          {
            type: "provider_subagent" as const,
            provider: "codex" as const,
            event: {
              type: "timeline" as const,
              id: "thread-child",
              item: { type: "assistant_message" as const, text: "Child result" },
            },
          },
        ],
      };
    }
  }

  const client = new ImportClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });
  manager.subscribe((event) => events.push(event), { replayState: false });

  const imported = await manager.importProviderSession({
    provider: "codex",
    providerHandleId: "thread-selected",
    cwd: workdir,
    workspaceId: "ws-imported",
  });

  expect(client.listCalls).toBe(0);
  expect(client.importInput).toEqual({ providerHandleId: "thread-selected", cwd: workdir });
  expect(imported.lifecycle).toBe("idle");
  expect(imported.historyPrimed).toBe(true);
  expect(manager.getTimeline(imported.id)).toEqual([
    { type: "user_message", text: "Trace provider imports" },
    { type: "assistant_message", text: "Done" },
    {
      type: "tool_call",
      callId: "large-shell-result",
      name: "shell",
      status: "completed",
      error: null,
      detail: {
        type: "shell",
        command: "print output",
        output: "x".repeat(64 * 1024),
        exitCode: 0,
      },
    },
  ]);
  expect(manager.listProviderSubagents(imported.id)).toEqual([
    expect.objectContaining({ id: "thread-child", title: "Imported child", status: "completed" }),
  ]);
  expect(manager.fetchProviderSubagentTimeline(imported.id, "thread-child").rows).toEqual([
    expect.objectContaining({ item: { type: "assistant_message", text: "Child result" } }),
  ]);
  expect(events).toHaveLength(3);
  expect(events[0]).toMatchObject({
    type: "agent_state",
    agent: {
      id: imported.id,
      lifecycle: "idle",
      persistence: { nativeHandle: "thread-selected" },
    },
  });
  expect((await storage.get(imported.id))?.title).toBe("Trace provider imports");
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(client.lastCreateLaunchContext).toEqual({
    agentId: snapshot.id,
    env: {
      PASEO_AGENT_ID: snapshot.id,
    },
  });

  await manager.reloadAgentSession(snapshot.id, {
    systemPrompt: "reloaded prompt",
  });

  expect(client.lastResumeLaunchContext).toEqual({
    agentId: snapshot.id,
    env: {
      PASEO_AGENT_ID: snapshot.id,
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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

test("reloadAgentSession clears provider children before rehydrating from disk", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-child-reload-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  let activeSession: TestAgentSession | null = null;
  class ProviderChildClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      activeSession = new TestAgentSession(config);
      return activeSession;
    }

    override async resumeSession(
      _handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      return new TestAgentSession({
        provider: "codex",
        cwd: config?.cwd ?? workdir,
      });
    }
  }
  const manager = new AgentManager({
    clients: { codex: new ProviderChildClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000116",
  });
  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  activeSession?.pushEvent({
    type: "provider_subagent",
    provider: "codex",
    event: { type: "upsert", id: "stale-child", title: "Stale child", status: "running" },
  });
  await vi.waitFor(() => expect(manager.listProviderSubagents(snapshot.id)).toHaveLength(1));

  await manager.reloadAgentSession(snapshot.id, undefined, { rehydrateFromDisk: true });

  expect(manager.listProviderSubagents(snapshot.id)).toEqual([]);
});

test("hydrateTimelineFromProvider restores and broadcasts provider children from session history", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-child-history-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  class ProviderChildHistorySession extends TestAgentSession {
    override async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "provider_subagent",
        provider: "codex",
        event: {
          type: "upsert",
          id: "restored-child",
          title: "Restored child",
          status: "completed",
        },
      };
    }
  }
  class ProviderChildHistoryClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ProviderChildHistorySession(config);
    }
  }
  const manager = new AgentManager({
    clients: { codex: new ProviderChildHistoryClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000117",
  });
  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), {
    agentId: snapshot.id,
    replayState: false,
  });

  await manager.hydrateTimelineFromProvider(snapshot.id, { broadcast: true });

  expect(manager.listProviderSubagents(snapshot.id)).toEqual([
    expect.objectContaining({
      id: "restored-child",
      parentAgentId: snapshot.id,
      title: "Restored child",
      status: "completed",
    }),
  ]);
  expect(events).toContainEqual({
    type: "provider_subagent",
    event: {
      type: "upsert",
      subagent: expect.objectContaining({
        id: "restored-child",
        parentAgentId: snapshot.id,
      }),
    },
  });
});

test("force provider hydration removes children absent from current history", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provider-child-force-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  let session: TestAgentSession | null = null;
  class ProviderChildForceClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      session = new TestAgentSession(config);
      return session;
    }
  }
  const manager = new AgentManager({
    clients: { codex: new ProviderChildForceClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000118",
  });
  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });
  session?.pushEvent({
    type: "provider_subagent",
    provider: "codex",
    event: { type: "upsert", id: "removed-by-rewind", status: "completed" },
  });
  await vi.waitFor(() => expect(manager.listProviderSubagents(snapshot.id)).toHaveLength(1));
  const events: AgentManagerEvent[] = [];
  manager.subscribe((event) => events.push(event), {
    agentId: snapshot.id,
    replayState: false,
  });

  await manager.hydrateTimelineFromProvider(snapshot.id, { force: true, broadcast: true });

  expect(manager.listProviderSubagents(snapshot.id)).toEqual([]);
  expect(events).toContainEqual({
    type: "provider_subagent",
    event: {
      type: "remove",
      parentAgentId: snapshot.id,
      subagentId: "removed-by-rewind",
    },
  });
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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

test("updateAgentMetadata bumps updatedAt for stored agents", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-stored-metadata-updated-at-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000128",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.closeAgent(snapshot.id);

  const closed = await storage.get(snapshot.id);
  expect(closed).not.toBeNull();
  const before = { ...closed!, labels: { surface: "mobile" } };
  await storage.upsert(before);
  expect(manager.getAgent(snapshot.id)).toBeNull();

  const upsertSpy = vi.spyOn(storage, "upsert");

  await manager.updateAgentMetadata(snapshot.id, {
    title: "Stored title",
    labels: { role: "worker" },
  });

  expect(upsertSpy).toHaveBeenCalledTimes(1);
  const after = await storage.get(snapshot.id);
  expect(after?.title).toBe("Stored title");
  expect(after?.labels).toEqual({ surface: "mobile", role: "worker" });
  expect(Date.parse(after!.updatedAt)).toBeGreaterThan(Date.parse(before!.updatedAt));
});

test("persists live mode, model, and thinking changes without an external snapshot subscriber", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-persist-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000132",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      modeId: "plan",
      model: "gpt-5.2-codex",
      thinkingOptionId: "low",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.setAgentMode(snapshot.id, "build");
  await manager.setAgentModel(snapshot.id, "gpt-5.4");
  await manager.setAgentThinkingOption(snapshot.id, "high");
  await manager.flush();

  const persisted = await storage.get(snapshot.id);
  expect(persisted).not.toBeNull();
  expect(persisted?.lastModeId).toBe("build");
  expect(persisted?.config?.model).toBe("gpt-5.4");
  expect(persisted?.config?.thinkingOptionId).toBe("high");
  expect(persisted?.runtimeInfo?.modeId).toBe("build");
  expect(persisted?.runtimeInfo?.model).toBe("gpt-5.4");
});

test("session config drift events update state through the stream channel", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-session-config-events-"));
  let capturedSession: TestAgentSession | null = null;
  class ConfigEventClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      capturedSession = new TestAgentSession(config);
      return capturedSession;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ConfigEventClient(),
    },
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000133",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      modeId: "plan",
      model: "gpt-5.2-codex",
      thinkingOptionId: "low",
    },
    undefined,
    { workspaceId: undefined },
  );
  const streams: AgentStreamEvent[] = [];
  manager.subscribe(
    (event) => {
      if (event.type === "agent_stream") {
        streams.push(event.event);
      }
    },
    { agentId: snapshot.id, replayState: false },
  );

  capturedSession?.pushEvent({
    type: "mode_changed",
    provider: "codex",
    currentModeId: "build",
    availableModes: [
      { id: "plan", label: "Plan" },
      { id: "build", label: "Build" },
    ],
  });
  capturedSession?.pushEvent({
    type: "model_changed",
    provider: "codex",
    runtimeInfo: {
      provider: "codex",
      sessionId: capturedSession.id,
      model: "gpt-5.4",
      modeId: "build",
      thinkingOptionId: "low",
    },
  });
  capturedSession?.pushEvent({
    type: "thinking_option_changed",
    provider: "codex",
    thinkingOptionId: "high",
  });
  await manager.flush();

  const agent = manager.getAgent(snapshot.id);
  expect(agent?.currentModeId).toBe("build");
  expect(agent?.availableModes).toEqual([
    { id: "plan", label: "Plan" },
    { id: "build", label: "Build" },
  ]);
  expect(agent?.runtimeInfo).toMatchObject({
    model: "gpt-5.4",
    modeId: "build",
    thinkingOptionId: "high",
  });
  expect(streams.map((event) => event.type)).toEqual([]);
});

test("setLabels merges and persists labels", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-set-labels-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000133",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Label test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.setLabels(snapshot.id, { surface: "mobile" });
  await manager.setLabels(snapshot.id, { phase: "1a" });

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.labels).toEqual({
    surface: "mobile",
    phase: "1a",
  });
});

test("detachAgent removes only the parent label from a live agent and emits state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-detach-live-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Child",
    },
    undefined,
    {
      labels: {
        [PARENT_AGENT_ID_LABEL]: parent.id,
        team: "infra",
      },
      workspaceId: undefined,
    },
  );
  const emittedLabels: Array<Record<string, string>> = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.id === child.id) {
        emittedLabels.push(event.agent.labels);
      }
    },
    { agentId: child.id, replayState: false },
  );

  const result = await manager.detachAgent(child.id);
  await manager.flush();
  unsubscribe();

  expect(result.previousParentAgentId).toBe(parent.id);
  expect(result.live).toBe(true);
  expect(result.record.labels).toEqual({ team: "infra" });
  expect(manager.getAgent(child.id)?.labels).toEqual({ team: "infra" });
  expect((await storage.get(child.id))?.labels).toEqual({ team: "infra" });
  expect(emittedLabels).toContainEqual({ team: "infra" });
});

test("detachAgent removes the parent label from a stored-only agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-detach-stored-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Stored child",
    },
    undefined,
    {
      labels: {
        [PARENT_AGENT_ID_LABEL]: parent.id,
        role: "reviewer",
      },
      workspaceId: undefined,
    },
  );
  await manager.closeAgent(child.id);

  const result = await manager.detachAgent(child.id);

  expect(result.previousParentAgentId).toBe(parent.id);
  expect(result.live).toBe(false);
  expect(result.record.labels).toEqual({ role: "reviewer" });
  expect((await storage.get(child.id))?.labels).toEqual({ role: "reviewer" });
});

test("archiveAgent does not cascade to a detached former child", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-detach-cascade-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );

  await manager.detachAgent(child.id);
  await manager.archiveAgent(parent.id);

  expect((await storage.get(parent.id))?.archivedAt).toEqual(expect.any(String));
  expect((await storage.get(child.id))?.archivedAt).toBeFalsy();
});

test("runAgent persists finished attention and idle status without an external snapshot subscriber", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-finished-attention-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000134",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Finished attention test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.runAgent(snapshot.id, "say hello");
  await manager.flush();

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.lastStatus).toBe("idle");
  expect(persisted?.requiresAttention).toBe(true);
  expect(persisted?.attentionReason).toBe("finished");
  expect(persisted?.attentionTimestamp).toEqual(expect.any(String));
});

test("archiveSnapshot clears persisted attention and normalizes running status", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archive-attention-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000135",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Archive attention test",
    },
    undefined,
    { workspaceId: undefined },
  );

  const live = manager.getAgent(snapshot.id);
  expect(live).not.toBeNull();
  live!.lifecycle = "running";
  live!.attention = {
    requiresAttention: true,
    attentionReason: "finished",
    attentionTimestamp: new Date("2025-01-02T00:00:00.000Z"),
  };

  const archivedAt = "2025-01-03T00:00:00.000Z";
  const archivedRecord = await manager.archiveSnapshot(snapshot.id, archivedAt);

  expect(archivedRecord.archivedAt).toBe(archivedAt);
  expect(archivedRecord.lastStatus).toBe("idle");
  expect(archivedRecord.requiresAttention).toBe(false);
  expect(archivedRecord.attentionReason).toBeNull();
  expect(archivedRecord.attentionTimestamp).toBeNull();

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.archivedAt).toBe(archivedAt);
  expect(persisted?.lastStatus).toBe("idle");
  expect(persisted?.requiresAttention).toBe(false);
  expect(persisted?.attentionReason).toBeNull();
  expect(persisted?.attentionTimestamp).toBeNull();
});

test("archiveSnapshot dispatches archived state for stored-only agents", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archive-snapshot-dispatch-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });

  const created = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Stored archive dispatch",
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.closeAgent(created.id);

  const events: ManagedAgent[] = [];
  manager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.id === created.id) {
        events.push(event.agent);
      }
    },
    { agentId: created.id, replayState: false },
  );

  await manager.archiveSnapshot(created.id, new Date().toISOString());

  expect(events.length).toBeGreaterThanOrEqual(1);
  const last = events[events.length - 1];
  expect(last.id).toBe(created.id);
  expect(last.lifecycle).toBe("closed");
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
          this.pushEvent({
            type: "turn_canceled",
            provider: this.provider,
            reason: "Interrupted",
            turnId,
          });
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );
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

test("fetchTimeline returns a bounded reset window when cursor epoch is stale", async () => {
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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
      seq: baseline.rows[baseline.rows.length - 1].seq,
    },
    limit: 1,
  });

  expect(result.reset).toBe(true);
  expect(result.staleCursor).toBe(true);
  expect(result.gap).toBe(false);
  expect(result.rows).toHaveLength(1);
  expect(result.rows[0]?.seq).toBe(3);
  expect(result.rows[result.rows.length - 1]?.seq).toBe(3);
  expect(result.hasOlder).toBe(true);

  const older = manager.fetchTimeline(snapshot.id, {
    direction: "before",
    cursor: {
      epoch: result.epoch,
      seq: result.rows[0]?.seq ?? 0,
    },
    limit: 1,
  });

  expect(older.reset).toBe(false);
  expect(older.rows).toHaveLength(1);
  expect(older.rows[0]?.seq).toBe(2);
  expect(older.hasOlder).toBe(true);
});

test("getTimelineRows falls back to the in-memory timeline when no durable store is configured", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-rows-fallback-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000140",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "row one",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "row two",
  });

  await expect(manager.getTimelineRows(snapshot.id)).resolves.toEqual([
    {
      seq: 1,
      timestamp: expect.any(String),
      item: {
        type: "assistant_message",
        text: "row one",
      },
    },
    {
      seq: 2,
      timestamp: expect.any(String),
      item: {
        type: "assistant_message",
        text: "row two",
      },
    },
  ]);
});

test("getAgent does not expose committed history internals once manager owns the seam", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-boundary-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000138",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.appendTimelineItem(snapshot.id, {
    type: "user_message",
    text: "hello boundary",
    messageId: "msg-boundary-1",
  });
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "history stays behind manager",
  });

  const live = manager.getAgent(snapshot.id) as Record<string, unknown>;
  expect(live).not.toBeNull();
  expect("timeline" in live).toBe(false);
  expect("timelineRows" in live).toBe(false);
  expect("timelineNextSeq" in live).toBe(false);

  expect(manager.getTimeline(snapshot.id)).toEqual([
    {
      type: "user_message",
      text: "hello boundary",
      messageId: "msg-boundary-1",
    },
    {
      type: "assistant_message",
      text: "history stays behind manager",
    },
  ]);

  const fetched = await manager.fetchTimeline(snapshot.id, {
    direction: "tail",
    limit: 0,
  });
  expect(fetched.rows.map((row) => row.seq)).toEqual([1, 2]);
});

test("coalesces assistant chunks and persists the canonical row", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-provisional-timeline-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new StreamingAssistantClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000120",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const streamEvents: Array<{
    seq?: number;
    epoch?: string;
    eventType?: string;
    itemType?: string;
    text?: string;
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
        text:
          event.event.type === "timeline" && event.event.item.type === "assistant_message"
            ? event.event.item.text
            : undefined,
      });
    },
    { agentId: snapshot.id, replayState: false },
  );

  const stream = manager.streamAgent(snapshot.id, "hello");
  while (true) {
    const next = await stream.next();
    if (next.done) {
      break;
    }
  }

  const assistantTimelineEvents = streamEvents.filter(
    (event) => event.itemType === "assistant_message",
  );
  expect(assistantTimelineEvents).toHaveLength(1);
  expect(assistantTimelineEvents[0]).toMatchObject({
    eventType: "timeline",
    itemType: "assistant_message",
    text: "final reply",
    seq: 1,
    epoch: expect.any(String),
  });

  expect(manager.getTimeline(snapshot.id)).toEqual([
    {
      type: "assistant_message",
      text: "final reply",
    },
  ]);
  const fetched = await manager.fetchTimeline(snapshot.id, {
    direction: "tail",
    limit: 0,
  });
  expect(fetched.rows).toHaveLength(1);
  expect(assistantTimelineEvents[0]?.epoch).toBe(fetched.epoch);
  expect(fetched.rows[0]?.item).toEqual({
    type: "assistant_message",
    text: "final reply",
  });
});

test("fetchTimeline supports older-history pagination with before seq", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-timeline-before-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000119",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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
  await manager.appendTimelineItem(snapshot.id, {
    type: "assistant_message",
    text: "fifth",
  });

  const result = await manager.fetchTimeline(snapshot.id, {
    direction: "before",
    cursor: {
      seq: 5,
    },
    limit: 2,
  });

  expect(result.rows).toHaveLength(2);
  expect(result.rows[0]?.seq).toBe(3);
  expect(result.rows[1]?.seq).toBe(4);
  expect(result.hasOlder).toBe(true);
  expect(result.hasNewer).toBe(true);
});

test("does not trim committed history", async () => {
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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

  const fetched = await manager.fetchTimeline(snapshot.id, {
    direction: "tail",
    limit: 0,
  });
  expect(fetched.rows).toHaveLength(3);
  expect(fetched.window.minSeq).toBe(1);
  expect(fetched.window.maxSeq).toBe(3);
});

test("hydrateTimeline preserves assistant chunk, reasoning, and tool timeline history", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-canonical-assistant-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class ChunkedAssistantHistorySession extends TestAgentSession {
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "chunk one " },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "chunk two" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "reasoning", text: "internal" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: {
          type: "tool_call",
          callId: "call-history-1",
          name: "shell",
          status: "completed",
          detail: {
            type: "shell",
            command: "echo hi",
            output: "hi\n",
            exitCode: 0,
          },
          error: null,
        },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "final answer" },
      };
    }
  }

  class ChunkedAssistantHistoryClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ChunkedAssistantHistorySession(config);
    }

    async resumeSession(): Promise<AgentSession> {
      throw new Error("Not used in this test");
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ChunkedAssistantHistoryClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000121",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.hydrateTimelineFromProvider(snapshot.id);

  expect(manager.getTimeline(snapshot.id)).toEqual([
    { type: "assistant_message", text: "chunk one " },
    { type: "assistant_message", text: "chunk two" },
    { type: "reasoning", text: "internal" },
    {
      type: "tool_call",
      callId: "call-history-1",
      name: "shell",
      status: "completed",
      detail: {
        type: "shell",
        command: "echo hi",
        output: "hi\n",
        exitCode: 0,
      },
      error: null,
    },
    { type: "assistant_message", text: "final answer" },
  ]);
});

test("hydrateTimeline preserves reasoning between assistant chunks", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-reasoning-interleave-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class ReasoningInterleavedHistorySession extends TestAgentSession {
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "before reasoning " },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "reasoning", text: "internal step" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "after reasoning" },
      };
    }
  }

  class ReasoningInterleavedHistoryClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new ReasoningInterleavedHistorySession(config);
    }

    async resumeSession(): Promise<AgentSession> {
      throw new Error("Not used in this test");
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new ReasoningInterleavedHistoryClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000122",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.hydrateTimelineFromProvider(snapshot.id);

  expect(manager.getTimeline(snapshot.id)).toEqual([
    {
      type: "assistant_message",
      text: "before reasoning ",
    },
    { type: "reasoning", text: "internal step" },
    { type: "assistant_message", text: "after reasoning" },
  ]);
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
    manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    ),
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
      { workspaceId: undefined },
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Fix Login Bug",
    },
    undefined,
    { workspaceId: undefined },
  );

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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      model: "gpt-5.2-codex",
      modeId: "full-access",
    },
    undefined,
    { workspaceId: undefined },
  );

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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  expect(snapshot.runtimeInfo?.model).toBe("gpt-5.4");

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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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
          this.pushEvent({
            type: "turn_canceled",
            provider: this.provider,
            reason: "interrupted",
            turnId,
          });
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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
  const secondRun = await manager.replaceAgentRun(snapshot.id, "second run");
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

  const firstReplacementRunningIndex = runningIndexes[1];
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
  const interruptStarted = deferred<void>();
  const allowInterruptToFinish = deferred<void>();
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
      interruptStarted.resolve();
      await allowInterruptToFinish.promise;
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const stateUpdates: Array<{ lifecycle: string; updatedAt: number }> = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type !== "agent_state" || event.agent.id !== snapshot.id) {
        return;
      }
      stateUpdates.push({
        lifecycle: event.agent.lifecycle,
        updatedAt: event.agent.updatedAt.getTime(),
      });
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

  const replaceUpdatesStart = stateUpdates.length;
  const beforeReplaceUpdatedAt = manager.getAgent(snapshot.id)?.updatedAt.getTime() ?? 0;
  const secondRunPromise = manager.replaceAgentRun(snapshot.id, "replacement run");

  await interruptStarted.promise;
  const replacementUpdates = stateUpdates.slice(replaceUpdatesStart);
  expect(
    replacementUpdates.some(
      (update) => update.lifecycle === "running" && update.updatedAt > beforeReplaceUpdatedAt,
    ),
  ).toBe(true);
  expect(replacementUpdates.map((update) => update.lifecycle)).not.toContain("idle");
  allowInterruptToFinish.resolve();

  const secondRun = await secondRunPromise;
  const secondRunDrain = (async () => {
    for await (const _event of secondRun) {
      // Drain replacement run.
    }
  })();
  await secondStartEntered.promise;

  const replaceGapSnapshot = manager.getAgent(snapshot.id) as
    | { pendingReplacement: boolean; activeForegroundTurnId: string | null; lifecycle: string }
    | undefined;
  expect(replaceGapSnapshot?.pendingReplacement).toBe(true);
  expect(replaceGapSnapshot?.activeForegroundTurnId).toBeNull();
  expect(replaceGapSnapshot?.lifecycle).toBe("running");

  const replacementStart = manager.waitForAgentRunStart(snapshot.id);
  const prematureStart = await Promise.race([
    replacementStart.then(() => "resolved"),
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 50)),
  ]);
  expect(prematureStart).toBe("pending");

  capturedSession!.pushEvent({ type: "turn_completed", provider: "codex", turnId: "turn-1" });
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("running");
  expect(stateUpdates.at(-1)?.lifecycle).toBe("running");
  expect(stateUpdates.slice(replaceUpdatesStart).map((update) => update.lifecycle)).not.toContain(
    "idle",
  );

  allowSecondStartToResolve.resolve();

  await replacementStart;
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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
  capturedSession!.pushEvent({
    type: "turn_started",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "timeline",
    provider: "codex",
    item: { type: "assistant_message", text: "AUTONOMOUS_PUMP_MESSAGE" },
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: autonomousTurnId,
  });
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

test("cancelAgentRun waits for an acknowledged autonomous interrupt to settle", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-cancel-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class LiveInterruptSession extends TestAgentSession {
    public interruptCount = 0;
    readonly interruptCalled = deferred<void>();

    override async interrupt(): Promise<void> {
      this.interruptCount += 1;
      this.interruptCalled.resolve(undefined);
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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
    capturedSession.pushEvent({
      type: "turn_started",
      provider: "codex",
      turnId: "autonomous-cancel-1",
    });
  });

  const beforeCancel = manager.getAgent(snapshot.id);
  expect(beforeCancel?.lifecycle).toBe("running");
  expect(beforeCancel?.activeForegroundTurnId).toBeNull();

  let cancelSettled = false;
  const cancelPromise = manager.cancelAgentRun(snapshot.id).finally(() => {
    cancelSettled = true;
  });
  await capturedSession.interruptCalled.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(cancelSettled).toBe(false);
  expect(client.lastSession?.interruptCount).toBe(1);

  capturedSession.pushEvent({
    type: "turn_canceled",
    provider: "codex",
    turnId: "autonomous-cancel-1",
    reason: "interrupted",
  });

  await expect(cancelPromise).resolves.toEqual({ status: "settled" });
  expect(manager.getAgent(snapshot.id)?.lifecycle).toBe("idle");
});

test("failed replacement cancellation preserves an autonomous running state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-live-replace-rejected-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);

  class RejectingLiveInterruptSession extends TestAgentSession {
    override async interrupt(): Promise<void> {
      throw new Error("provider still owns the autonomous turn");
    }
  }

  class RejectingLiveInterruptClient extends TestAgentClient {
    readonly session = new RejectingLiveInterruptSession({
      provider: "codex",
      cwd: workdir,
    });

    override async createSession(): Promise<AgentSession> {
      return this.session;
    }
  }

  const client = new RejectingLiveInterruptClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    rescueTimeouts: { interruptSessionMs: 10 },
    idFactory: () => "00000000-0000-4000-8000-000000000130",
  });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const running = waitForAgentLifecycle(manager, agent.id, "running");

    client.session.pushEvent({
      type: "turn_started",
      provider: "codex",
      turnId: "autonomous-replace-1",
    });
    await running;

    await expect(manager.replaceAgentRun(agent.id, "replacement prompt")).rejects.toThrow(
      `Cannot replace agent ${agent.id} because its active run cancellation was not acknowledged`,
    );
    expect(manager.getAgent(agent.id)).toMatchObject({
      lifecycle: "running",
      activeForegroundTurnId: null,
    });
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const autonomousTurnId = "autonomous-wait-1";
  const waitPromise = manager.waitForAgentEvent(snapshot.id, { waitForActive: true });
  capturedSession!.pushEvent({
    type: "turn_started",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: autonomousTurnId,
  });

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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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
        if (
          event.type === "agent_state" &&
          event.agent.id === snapshot.id &&
          event.agent.lifecycle === "running"
        ) {
          unsub();
          resolve();
        }
      },
      { agentId: snapshot.id, replayState: true },
    );
  });

  // Push autonomous events while foreground is active
  const autonomousTurnId = "autonomous-during-fg-1";
  capturedSession!.pushEvent({
    type: "turn_started",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "timeline",
    provider: "codex",
    item: { type: "assistant_message", text: "AUTONOMOUS_DURING_FOREGROUND" },
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: autonomousTurnId,
  });

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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const receivedEvents: string[] = [];
  const settled = new Promise<void>((resolve) => {
    manager.subscribe(
      (event) => {
        if (
          event.type === "agent_state" &&
          event.agent.id === snapshot.id &&
          event.agent.lifecycle === "idle"
        ) {
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
  capturedSession!.pushEvent({
    type: "turn_started",
    provider: "codex",
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "timeline",
    provider: "codex",
    item: { type: "assistant_message", text: "EVENT_AFTER_ERROR" },
    turnId: autonomousTurnId,
  });
  capturedSession!.pushEvent({
    type: "turn_completed",
    provider: "codex",
    turnId: autonomousTurnId,
  });

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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const nowSpy = vi.spyOn(Date, "now").mockReturnValue(1_750_000_000_000);
  try {
    await manager.appendTimelineItem(snapshot.id, { type: "user_message", text: "hello" });
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
      return () => {
        this.subs.delete(callback);
      };
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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
  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Normal Agent",
    },
    undefined,
    { workspaceId: undefined },
  );

  // Create an internal agent
  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

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

  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

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
  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Normal Agent",
    },
    undefined,
    { workspaceId: undefined },
  );

  // Create an internal agent - should NOT emit to global subscriber
  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

  // Should only have events from the normal agent
  expect(receivedEvents.filter((id) => id === generatedAgentIds[0]).length).toBeGreaterThan(0);
  expect(receivedEvents.filter((id) => id === generatedAgentIds[1]).length).toBe(0);
});

test("subscribe hides provider subagents of internal parents from global subscribers", async () => {
  const internalAgentId = "00000000-0000-4000-8000-000000000117";
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-internal-provider-child-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const sessionHolder: { current: TestAgentSession | null } = { current: null };
  class InternalProviderChildClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      sessionHolder.current = new TestAgentSession(config);
      return sessionHolder.current;
    }
  }
  const manager = new AgentManager({
    clients: { codex: new InternalProviderChildClient() },
    registry: storage,
    logger,
    idFactory: () => internalAgentId,
  });
  const globalEvents: AgentManagerEvent[] = [];
  const scopedEvents: AgentManagerEvent[] = [];
  manager.subscribe((event) => globalEvents.push(event), { replayState: false });
  await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Internal Agent", internal: true },
    undefined,
    { workspaceId: undefined },
  );
  manager.subscribe((event) => scopedEvents.push(event), {
    agentId: internalAgentId,
    replayState: false,
  });

  sessionHolder.current?.pushEvent({
    type: "provider_subagent",
    provider: "codex",
    event: { type: "upsert", id: "hidden-child", title: "Hidden child", status: "running" },
  });
  await manager.flush();

  expect(globalEvents.filter((event) => event.type === "provider_subagent")).toEqual([]);
  expect(scopedEvents).toContainEqual(
    expect.objectContaining({
      type: "provider_subagent",
      event: expect.objectContaining({
        type: "upsert",
        subagent: expect.objectContaining({
          id: "hidden-child",
          parentAgentId: internalAgentId,
        }),
      }),
    }),
  );
  expect(() => manager.listProviderSubagents(internalAgentId)).toThrow(
    `Unknown agent '${internalAgentId}'`,
  );
  expect(() => manager.getProviderSubagent(internalAgentId, "hidden-child")).toThrow(
    `Unknown agent '${internalAgentId}'`,
  );
  expect(() => manager.fetchProviderSubagentTimeline(internalAgentId, "hidden-child")).toThrow(
    `Unknown agent '${internalAgentId}'`,
  );
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

  await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

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

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Internal Agent",
      internal: true,
    },
    undefined,
    { workspaceId: undefined },
  );

  // Run and complete the agent (which normally triggers attention)
  await manager.runAgent(agent.id, "hello");

  // Should NOT have triggered attention callback for internal agent
  expect(attentionCalls).toHaveLength(0);
});

test("onAgentAttention is not called for delegated child agents", async () => {
  const childAgentId = "00000000-0000-4000-8000-000000000112";
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
    idFactory: () => childAgentId,
    onAgentAttention: ({ agentId }) => {
      attentionCalls.push(agentId);
    },
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Delegated Child Agent",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: "parent-agent" }, workspaceId: undefined },
  );

  await manager.runAgent(agent.id, "hello");

  expect(attentionCalls).toEqual([]);
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
        this.pushEvent({
          type: "turn_failed",
          provider: this.provider,
          error: `boom-${attempt}`,
          turnId,
        });
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

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Attention transition test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await expect(manager.runAgent(agent.id, "fail once")).rejects.toThrow("boom-1");
  await manager.flush();

  const afterFirstFailure = manager.getAgent(agent.id);
  expect(afterFirstFailure?.lifecycle).toBe("error");
  expect(afterFirstFailure?.attention.requiresAttention).toBe(true);
  expect(afterFirstFailure?.attention).toMatchObject({
    requiresAttention: true,
    attentionReason: "error",
  });

  const persistedAfterFirstFailure = await storage.get(agent.id);
  expect(persistedAfterFirstFailure?.lastStatus).toBe("error");
  expect(persistedAfterFirstFailure?.requiresAttention).toBe(true);
  expect(persistedAfterFirstFailure?.attentionReason).toBe("error");

  await manager.clearAgentAttention(agent.id);
  manager.notifyAgentState(agent.id);
  await manager.flush();

  const afterClear = manager.getAgent(agent.id);
  expect(afterClear?.lifecycle).toBe("error");
  expect(afterClear?.attention).toEqual({ requiresAttention: false });

  const persistedAfterClear = await storage.get(agent.id);
  expect(persistedAfterClear?.lastStatus).toBe("error");
  expect(persistedAfterClear?.requiresAttention).toBe(false);
  expect(persistedAfterClear?.attentionReason).toBeNull();

  await expect(manager.runAgent(agent.id, "fail again")).rejects.toThrow("boom-2");
  await manager.flush();

  const afterSecondFailure = manager.getAgent(agent.id);
  expect(afterSecondFailure?.lifecycle).toBe("error");
  expect(afterSecondFailure?.attention).toMatchObject({
    requiresAttention: true,
    attentionReason: "error",
  });
  expect(attentionReasons).toEqual(["error", "error"]);

  const persistedAfterSecondFailure = await storage.get(agent.id);
  expect(persistedAfterSecondFailure?.lastStatus).toBe("error");
  expect(persistedAfterSecondFailure?.requiresAttention).toBe(true);
  expect(persistedAfterSecondFailure?.attentionReason).toBe("error");
});

test("streamAgent clears pending run when startTurn fails before a turn id exists", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-start-turn-failure-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class FailsOnceBeforeTurnSession extends TestAgentSession {
    private attempt = 0;

    override async startTurn(): Promise<{ turnId: string }> {
      this.attempt += 1;
      if (this.attempt === 1) {
        throw new Error("Invalid request: missing field `text`");
      }
      return super.startTurn();
    }
  }

  class FailsOnceClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;
    readonly session = new FailsOnceBeforeTurnSession({
      provider: "codex",
      cwd: workdir,
    });

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(): Promise<AgentSession> {
      return this.session;
    }

    async resumeSession(): Promise<AgentSession> {
      return this.session;
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new FailsOnceClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000131",
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Start turn failure cleanup",
    },
    undefined,
    { workspaceId: undefined },
  );

  await expect(manager.runAgent(agent.id, "fail before turn id")).rejects.toThrow(
    "Invalid request: missing field `text`",
  );

  await expect(manager.runAgent(agent.id, "second turn")).resolves.toEqual(
    expect.objectContaining({
      sessionId: expect.any(String),
      canceled: false,
    }),
  );
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

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Archive target",
    },
    undefined,
    { workspaceId: undefined },
  );

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
    lastStatus: "closed",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  });
  expect(
    Math.abs(new Date(stored!.updatedAt).getTime() - new Date(archivedAt).getTime()),
  ).toBeLessThanOrEqual(5);
  expect(lifecycles.slice(-2)).toEqual(["idle", "closed"]);
});

test("fires onAgentArchived for archived parent and cascaded children", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-hook-cascade-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const archivedIds: string[] = [];
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  manager.setAgentArchivedCallback((agentId) => {
    archivedIds.push(agentId);
  });

  const liveParent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const liveChild = await manager.createAgent(
    { provider: "codex", cwd: workdir, title: "Child" },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: liveParent.id }, workspaceId: undefined },
  );

  await manager.archiveAgent(liveParent.id);
  expect([...archivedIds].sort()).toEqual([liveChild.id, liveParent.id].sort());
});

test("fires onAgentArchived for stored-only snapshot archives", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-hook-snapshot-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const archivedIds: string[] = [];
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });
  manager.setAgentArchivedCallback((agentId) => {
    archivedIds.push(agentId);
  });

  const storedOnly = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Stored only",
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.closeAgent(storedOnly.id);

  await manager.archiveSnapshot(storedOnly.id, new Date().toISOString());
  expect(archivedIds).toEqual([storedOnly.id]);
});

test("unarchiveSnapshot skips native provider unarchive for active records", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-unarchive-active-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Active unarchive target",
    },
    undefined,
    { workspaceId: undefined },
  );

  const unarchived = await manager.unarchiveSnapshot(agent.id);

  expect(unarchived).toBe(false);
  expect(client.unarchivedHandles).toEqual([]);
});

test("unarchiveSnapshot unarchives native provider storage before clearing archivedAt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-native-unarchive-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Native unarchive target",
    },
    undefined,
    {
      workspaceId: undefined,
      labels: { [PARENT_AGENT_ID_LABEL]: "archived-parent", retained: "yes" },
    },
  );
  await manager.archiveAgent(agent.id);
  client.readArchivedAtDuringUnarchive = async () => (await storage.get(agent.id))?.archivedAt;

  const unarchived = await manager.unarchiveSnapshot(agent.id, {
    workspaceId: "ws-restored",
    labels: { [PARENT_AGENT_ID_LABEL]: null, source: "reimport" },
  });
  const stored = await storage.get(agent.id);

  expect(unarchived).toBe(true);
  expect(client.archivedHandles).toHaveLength(1);
  expect(client.unarchivedHandles).toEqual(client.archivedHandles);
  expect(client.archivedAtDuringUnarchive).toEqual(expect.any(String));
  expect(stored?.archivedAt).toBeNull();
  expect(stored?.workspaceId).toBe("ws-restored");
  expect(stored?.labels).toEqual({ retained: "yes", source: "reimport" });
});

test("unarchiveSnapshotByHandle unarchives native provider storage for the matched snapshot", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-native-unarchive-handle-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Native unarchive by handle target",
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.archiveAgent(agent.id);
  const archived = await storage.get(agent.id);
  if (!archived?.persistence) {
    throw new Error("expected archived snapshot to have persistence");
  }

  await manager.unarchiveSnapshotByHandle(archived.persistence);

  const stored = await storage.get(agent.id);
  expect(client.unarchivedHandles).toEqual(client.archivedHandles);
  expect(stored?.archivedAt).toBeNull();
});

test("unarchiveSnapshot keeps the stored record archived when native unarchive fails", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-native-unarchive-failure-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const client = new NativeArchiveRecordingClient();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
  });

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Native unarchive failure target",
    },
    undefined,
    { workspaceId: undefined },
  );
  await manager.archiveAgent(agent.id);
  client.unarchiveFailure = new Error("provider still archived");

  await expect(manager.unarchiveSnapshot(agent.id)).rejects.toThrow("provider still archived");

  const stored = await storage.get(agent.id);
  expect(stored?.archivedAt).toEqual(expect.any(String));
  expect(client.unarchivedHandles).toHaveLength(1);
});

test("archiveAgent cascade archives in-memory children with the full archive contract", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-contract-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });

  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const unrelated = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Unrelated",
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.archiveAgent(parent.id);

  const storedParent = await storage.get(parent.id);
  const storedChild = await storage.get(child.id);
  const storedUnrelated = await storage.get(unrelated.id);

  expectArchivedAgentRecord(storedParent, "closed");
  expectArchivedAgentRecord(storedChild, "closed");
  expect(storedUnrelated?.archivedAt).toBeUndefined();
});

test("archiveAgent cascade closes a running child runtime", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-running-child-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const finishRun = deferred<void>();

  class RunningChildSession extends TestAgentSession {
    closeCalled = false;

    override async startTurn(): Promise<{ turnId: string }> {
      const turnId = "running-child-turn";
      void (async () => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        await finishRun.promise;
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      })();
      return { turnId };
    }

    override async close(): Promise<void> {
      this.closeCalled = true;
    }
  }

  class RunningChildClient extends TestAgentClient {
    readonly sessions: RunningChildSession[] = [];

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const session = new RunningChildSession(config);
      this.sessions.push(session);
      return session;
    }
  }

  const client = new RunningChildClient();
  const manager = new AgentManager({
    clients: {
      codex: client,
    },
    registry: storage,
    logger,
  });
  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Running Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const childSession = client.sessions[1];
  const childLifecycleEvents: string[] = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type === "agent_state" && event.agent.id === child.id) {
        childLifecycleEvents.push(event.agent.lifecycle);
      }
    },
    { agentId: child.id, replayState: false },
  );
  const childRun = manager.streamAgent(child.id, "keep running");
  const drainChildRun = (async () => {
    for await (const _event of childRun) {
      // Drain the foreground turn while archive closes it.
    }
  })();

  await manager.waitForAgentRunStart(child.id);

  await manager.archiveAgent(parent.id);
  finishRun.resolve();
  await drainChildRun;
  unsubscribe();

  expect(childSession?.closeCalled).toBe(true);
  expect(manager.getAgent(child.id)).toBeNull();
  expect(childLifecycleEvents).toContain("closed");
});

test("archiveAgent cascade archives off-memory children with the full archive contract", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-off-memory-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });
  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Off-memory Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const managerInternals = manager as unknown as {
    agents: Map<string, unknown>;
  };
  managerInternals.agents.delete(child.id);

  await manager.archiveAgent(parent.id);

  expectArchivedAgentRecord(await storage.get(child.id), "idle");
});

test("archiveAgent cascade notifies subscribers for in-memory and off-memory children", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-notifications-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });
  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const inMemoryChild = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "In-memory Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const offMemoryChild = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Off-memory Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  const managerInternals = manager as unknown as {
    agents: Map<string, unknown>;
  };
  managerInternals.agents.delete(offMemoryChild.id);
  const cascadedChildEvents: string[] = [];
  const unsubscribe = manager.subscribe(
    (event) => {
      if (event.type !== "agent_state") {
        return;
      }
      if (event.agent.id === inMemoryChild.id || event.agent.id === offMemoryChild.id) {
        cascadedChildEvents.push(event.agent.id);
      }
    },
    { replayState: false },
  );

  await manager.archiveAgent(parent.id);
  unsubscribe();

  expect({
    inMemoryChildNotified: cascadedChildEvents.includes(inMemoryChild.id),
    offMemoryChildNotified: cascadedChildEvents.includes(offMemoryChild.id),
  }).toEqual({
    inMemoryChildNotified: true,
    offMemoryChildNotified: true,
  });
});

test("archiveAgent cascade surfaces partial child archive failures", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-cascade-partial-failure-"));
  const storagePath = join(workdir, "agents");
  let failingChildId: string | null = null;

  class FailingChildArchiveStorage extends AgentStorage {
    override async upsert(record: StoredAgentRecord): Promise<void> {
      if (record.id === failingChildId && record.archivedAt) {
        throw new Error(`Injected cascade archive failure for ${record.id}`);
      }
      await super.upsert(record);
    }
  }

  const storage = new FailingChildArchiveStorage(storagePath, logger);
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
  });
  const parent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Parent",
    },
    undefined,
    { workspaceId: undefined },
  );
  const child = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Failing Child",
    },
    undefined,
    { labels: { [PARENT_AGENT_ID_LABEL]: parent.id }, workspaceId: undefined },
  );
  failingChildId = child.id;

  await expect(manager.archiveAgent(parent.id)).rejects.toThrow(
    `Injected cascade archive failure for ${child.id}`,
  );
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
        this.pushEvent({
          type: "turn_failed",
          provider: this.provider,
          error: "invalid model id",
          turnId,
        });
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

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Turn failed test",
    },
    undefined,
    { workspaceId: undefined },
  );

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

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Detailed failure test",
    },
    undefined,
    { workspaceId: undefined },
  );

  await expect(manager.runAgent(agent.id, "hello")).rejects.toThrow("Provider execution failed");

  expect(manager.getAgent(agent.id)?.lastError).toBe("Provider execution failed");

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

  const agent = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      title: "Permission transition test",
    },
    undefined,
    { workspaceId: undefined },
  );

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
      return () => {
        this.subs.delete(callback);
      };
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
  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
      modeId: "plan",
    },
    undefined,
    { workspaceId: undefined },
  );

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

  await manager.flush();
  const persisted = await storage.get(snapshot.id);
  expect(persisted?.lastModeId).toBe("acceptEdits");
});

test("respondToPermission refreshes features and runtime info after provider-managed plan approval", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-test-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class RefreshingPermissionSession extends TestAgentSession {
    private featureState: AgentFeature[] = [
      createFeature({ id: "fast_mode", label: "Fast", value: true }),
      createFeature({ id: "plan_mode", label: "Plan", value: true }),
    ];
    private modeId = "auto";
    private pending = [
      {
        id: "perm-plan-1",
        provider: "codex" as const,
        name: "CodexPlanApproval",
        kind: "plan" as const,
        input: { plan: "- Implement the feature" },
      },
    ];

    get features(): AgentFeature[] {
      return this.featureState;
    }

    override async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.id,
        model: "gpt-5.4",
        modeId: this.modeId,
        extra: { collaborationMode: this.features[1]?.value ? "Plan" : "Code" },
      };
    }

    override async getCurrentMode() {
      return this.modeId;
    }

    override getPendingPermissions() {
      return this.pending;
    }

    override async respondToPermission(): Promise<void> {
      this.modeId = "auto";
      this.pending = [];
      this.featureState = [
        createFeature({ id: "fast_mode", label: "Fast", value: true }),
        createFeature({ id: "plan_mode", label: "Plan", value: false }),
      ];
    }
  }

  class RefreshingPermissionClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new RefreshingPermissionSession(config);
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new RefreshingPermissionClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000133",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const agent = manager.getAgent(snapshot.id);
  if (!agent) {
    throw new Error("Expected managed agent");
  }
  agent.pendingPermissions.set("perm-plan-1", {
    id: "perm-plan-1",
    provider: "codex",
    name: "CodexPlanApproval",
    kind: "plan",
    input: { plan: "- Implement the feature" },
  });

  await manager.respondToPermission(snapshot.id, "perm-plan-1", {
    behavior: "allow",
    selectedActionId: "implement",
  });

  const updated = manager.getAgent(snapshot.id);
  expect(updated?.pendingPermissions.size).toBe(0);
  expect(updated?.features).toEqual([
    createFeature({ id: "fast_mode", label: "Fast", value: true }),
    createFeature({ id: "plan_mode", label: "Plan", value: false }),
  ]);
  expect(updated?.runtimeInfo).toMatchObject({
    model: "gpt-5.4",
    extra: { collaborationMode: "Code" },
  });

  const persisted = await storage.get(snapshot.id);
  expect(persisted?.features).toEqual([
    createFeature({ id: "fast_mode", label: "Fast", value: true }),
    createFeature({ id: "plan_mode", label: "Plan", value: false }),
  ]);
});

test("respondToPermission emits refreshed state before permission_resolved", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-permission-order-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class OrderedPermissionSession extends TestAgentSession {
    private featureState: AgentFeature[] = [
      createFeature({ id: "fast_mode", label: "Fast", value: true }),
    ];
    private modeId = "plan";
    private pending = [
      {
        id: "perm-order-1",
        provider: "codex" as const,
        name: "ExitPlanMode",
        kind: "plan" as const,
        input: { plan: "- Do the work" },
      },
    ];

    get features(): AgentFeature[] {
      return this.featureState;
    }

    override async getRuntimeInfo() {
      return {
        provider: this.provider,
        sessionId: this.id,
        model: "gpt-5.4",
        modeId: this.modeId,
      };
    }

    override async getCurrentMode() {
      return this.modeId;
    }

    override getPendingPermissions() {
      return this.pending;
    }

    override async respondToPermission(): Promise<void> {
      this.pushEvent({
        type: "permission_resolved",
        provider: this.provider,
        requestId: "perm-order-1",
        resolution: { behavior: "allow" },
      });
      this.modeId = "acceptEdits";
      this.featureState = [createFeature({ id: "fast_mode", label: "Fast", value: false })];
      this.pending = [];
    }
  }

  class OrderedPermissionClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new OrderedPermissionSession(config);
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new OrderedPermissionClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000134",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  const seen: string[] = [];
  manager.subscribe((event) => {
    if ("agentId" in event && event.agentId !== snapshot.id) {
      return;
    }
    if (event.type === "agent_state" && event.agent.id === snapshot.id) {
      const fastMode = event.agent.features?.find((feature) => feature.id === "fast_mode");
      seen.push(
        `state:${event.agent.currentModeId}:${String(fastMode?.type === "toggle" ? fastMode.value : null)}`,
      );
      return;
    }
    if (event.type === "agent_stream" && event.event.type === "permission_resolved") {
      seen.push(`resolved:${event.event.requestId}`);
    }
  });

  await manager.respondToPermission(snapshot.id, "perm-order-1", {
    behavior: "allow",
  });

  const refreshedStateIndex = seen.findIndex((entry) => entry === "state:acceptEdits:false");
  const resolvedIndex = seen.findIndex((entry) => entry === "resolved:perm-order-1");
  expect(refreshedStateIndex).toBeGreaterThanOrEqual(0);
  expect(resolvedIndex).toBeGreaterThan(refreshedStateIndex);
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
      return () => {
        this.subscribers.delete(callback);
      };
    }

    private pushEvent(event: AgentStreamEvent): void {
      for (const cb of this.subscribers) {
        try {
          cb(event);
        } catch {
          /* isolation */
        }
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

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

test("closeAgent persists one final closed snapshot", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-close-no-persist-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const applySnapshotSpy = vi.spyOn(storage, "applySnapshot");
  const manager = new AgentManager({
    clients: {
      codex: new TestAgentClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000112",
  });

  try {
    const snapshot = await manager.createAgent(
      {
        provider: "codex",
        cwd: workdir,
      },
      undefined,
      { workspaceId: undefined },
    );

    await manager.flush();
    const persistCountBeforeClose = applySnapshotSpy.mock.calls.length;

    await manager.closeAgent(snapshot.id);
    await manager.flush();

    expect(applySnapshotSpy).toHaveBeenCalledTimes(persistCountBeforeClose + 1);
  } finally {
    applySnapshotSpy.mockRestore();
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("collectIdleAgents releases an idle runtime and resumes the same agent and timeline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-idle-collection-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  let activeSession: TestAgentSession | null = null;
  const client = new (class extends NativeArchiveRecordingClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      activeSession = new TestAgentSession(config);
      return activeSession;
    }
  })();
  const manager = new AgentManager({
    clients: { codex: client },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000210",
  });

  try {
    const created = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: "workspace-idle-collection",
    });
    await manager.appendTimelineItem(created.id, {
      type: "user_message",
      text: "Keep this timeline",
    });
    activeSession?.pushEvent({
      type: "provider_subagent",
      provider: "codex",
      event: {
        type: "upsert",
        id: "retained-provider-child",
        title: "Retained provider child",
        status: "completed",
      },
    });
    await manager.flush();
    const timelineBeforeCollection = manager.getTimeline(created.id);

    const collection = await manager.collectIdleAgents({
      cutoff: new Date(Date.now() + 1_000),
      protectedAgentIds: new Set(),
    });

    expect(collection).toEqual({
      collected: [
        {
          agentId: created.id,
          provider: "codex",
          sessionId: created.persistence?.sessionId,
        },
      ],
      failures: [],
    });
    expect(manager.getAgent(created.id)).toBeNull();
    expect(client.archivedHandles).toEqual([]);
    const stored = await storage.get(created.id);
    expect(stored).toMatchObject({
      id: created.id,
      lastStatus: "closed",
      workspaceId: "workspace-idle-collection",
    });
    expect(stored?.archivedAt).toBeFalsy();

    const resumed = await ensureAgentLoaded(created.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });

    expect(resumed.id).toBe(created.id);
    expect(resumed.persistence).toEqual(created.persistence);
    expect(manager.getTimeline(created.id)).toEqual(timelineBeforeCollection);
    expect(manager.listProviderSubagents(created.id)).toEqual([
      expect.objectContaining({
        id: "retained-provider-child",
        title: "Retained provider child",
        status: "completed",
      }),
    ]);
    const idleBeforeOpen = resumed.updatedAt;
    await ensureAgentLoaded(created.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await expect(
      manager.collectIdleAgents({ cutoff: idleBeforeOpen, protectedAgentIds: new Set() }),
    ).resolves.toMatchObject({ collected: [] });
    await expect(manager.runAgent(created.id, "Continue the same agent")).resolves.toMatchObject({
      finalText: "",
      canceled: false,
    });
    expect(manager.getAgent(created.id)?.id).toBe(created.id);
  } finally {
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("archiving an idle-collected parent still cascades to its managed children", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-collected-parent-archive-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });

  try {
    const parent = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Collected parent" },
      undefined,
      { workspaceId: undefined },
    );
    const child = await manager.createAgent(
      { provider: "codex", cwd: workdir, title: "Managed child" },
      undefined,
      {
        labels: { [PARENT_AGENT_ID_LABEL]: parent.id },
        workspaceId: undefined,
      },
    );

    await manager.collectIdleAgents({
      cutoff: new Date(Date.now() + 1_000),
      protectedAgentIds: new Set([child.id]),
    });
    await manager.archiveSnapshot(parent.id, new Date().toISOString());

    expect((await storage.get(parent.id))?.archivedAt).toEqual(expect.any(String));
    expect((await storage.get(child.id))?.archivedAt).toEqual(expect.any(String));
    expect(manager.getAgent(child.id)).toBeNull();
  } finally {
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ensureUnarchivedAgentLoaded does not resume an archived agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-load-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const manager = new AgentManager({
    clients: { codex: new TestAgentClient() },
    registry: storage,
    logger,
  });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.collectIdleAgents({
      cutoff: new Date(Date.now() + 1_000),
      protectedAgentIds: new Set(),
    });
    await manager.archiveSnapshot(agent.id, new Date().toISOString());

    await expect(
      ensureUnarchivedAgentLoaded(agent.id, {
        agentManager: manager,
        agentStorage: storage,
        logger,
      }),
    ).rejects.toThrow(`Agent is archived: ${agent.id}`);
    expect(manager.getAgent(agent.id)).toBeNull();
  } finally {
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ensureUnarchivedAgentLoaded closes a runtime archived while it resumes", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-resume-race-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const resumeStarted = deferred<void>();
  const resumeAllowed = deferred<void>();
  const client = new (class extends TestAgentClient {
    override async resumeSession(
      handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      resumeStarted.resolve();
      await resumeAllowed.promise;
      return super.resumeSession(handle, config, launchContext);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.collectIdleAgents({
      cutoff: new Date(Date.now() + 1_000),
      protectedAgentIds: new Set(),
    });

    const load = ensureUnarchivedAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await resumeStarted.promise;
    await manager.archiveSnapshot(agent.id, new Date().toISOString());
    resumeAllowed.resolve();

    await expect(load).rejects.toThrow(`Agent is archived: ${agent.id}`);
    expect(manager.getAgent(agent.id)).toBeNull();
    expect((await storage.get(agent.id))?.archivedAt).toEqual(expect.any(String));
  } finally {
    resumeAllowed.resolve();
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("ensureUnarchivedAgentLoaded fences an archived agent after joining a shared resume", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-archived-shared-resume-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const resumeStarted = deferred<void>();
  const resumeAllowed = deferred<void>();
  const client = new (class extends TestAgentClient {
    override async resumeSession(
      handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
      launchContext?: AgentLaunchContext,
    ): Promise<AgentSession> {
      resumeStarted.resolve();
      await resumeAllowed.promise;
      return super.resumeSession(handle, config, launchContext);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const agent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    await manager.collectIdleAgents({
      cutoff: new Date(Date.now() + 1_000),
      protectedAgentIds: new Set(),
    });

    const sharedLoad = ensureAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await resumeStarted.promise;
    const protectedLoad = ensureUnarchivedAgentLoaded(agent.id, {
      agentManager: manager,
      agentStorage: storage,
      logger,
    });
    await manager.archiveSnapshot(agent.id, new Date().toISOString());
    resumeAllowed.resolve();

    await sharedLoad;
    await expect(protectedLoad).rejects.toThrow(`Agent is archived: ${agent.id}`);
    expect(manager.getAgent(agent.id)).toBeNull();
    expect((await storage.get(agent.id))?.archivedAt).toEqual(expect.any(String));
  } finally {
    resumeAllowed.resolve();
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("collectIdleAgents leaves recent, protected, internal, running, and error agents resident", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-idle-eligibility-"));
  const client = new (class extends TestAgentClient {
    readonly sessions: TestAgentSession[] = [];

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      const session = new TestAgentSession(config);
      this.sessions.push(session);
      return session;
    }
  })();
  const ids = [
    "00000000-0000-4000-8000-000000000211",
    "00000000-0000-4000-8000-000000000212",
    "00000000-0000-4000-8000-000000000213",
    "00000000-0000-4000-8000-000000000214",
    "00000000-0000-4000-8000-000000000215",
  ];
  const manager = new AgentManager({
    clients: { codex: client },
    logger,
    idFactory: () => ids.shift()!,
  });

  try {
    const recent = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const protectedAgent = await manager.createAgent(
      { provider: "codex", cwd: workdir },
      undefined,
      { workspaceId: undefined },
    );
    const internal = await manager.createAgent(
      { provider: "codex", cwd: workdir, internal: true },
      undefined,
      { workspaceId: undefined },
    );
    const running = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    const failed = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });
    client.sessions[3]!.pushEvent({
      type: "turn_started",
      provider: "codex",
      turnId: "autonomous-running",
    });
    client.sessions[4]!.pushEvent({
      type: "turn_failed",
      provider: "codex",
      turnId: "autonomous-failed",
      error: "provider failed",
    });
    await manager.flush();

    const recentSweep = await manager.collectIdleAgents({
      cutoff: new Date(recent.updatedAt.getTime() - 1),
      protectedAgentIds: new Set(),
    });
    const protectedSweep = await manager.collectIdleAgents({
      cutoff: new Date(Date.now() + 1_000),
      protectedAgentIds: new Set([protectedAgent.id, recent.id]),
    });

    expect(recentSweep.collected).toEqual([]);
    expect(protectedSweep.collected).toEqual([]);
    expect(manager.getAgent(recent.id)?.lifecycle).toBe("idle");
    expect(manager.getAgent(protectedAgent.id)?.lifecycle).toBe("idle");
    expect(manager.getAgent(internal.id)?.lifecycle).toBe("idle");
    expect(manager.getAgent(running.id)?.lifecycle).toBe("running");
    expect(manager.getAgent(failed.id)?.lifecycle).toBe("error");
  } finally {
    await Promise.all(manager.listAgents().map((agent) => manager.closeAgent(agent.id))).catch(
      () => undefined,
    );
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("load waits for an in-flight collection close and creates only one resumed runtime", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-idle-close-race-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const closeStarted = deferred<void>();
  const closeAllowed = deferred<void>();
  const client = new (class extends TestAgentClient {
    resumeCount = 0;

    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          closeStarted.resolve();
          await closeAllowed.promise;
        }
      })(config);
    }

    override async resumeSession(
      handle: AgentPersistenceHandle,
      config?: Partial<AgentSessionConfig>,
    ): Promise<AgentSession> {
      this.resumeCount += 1;
      return super.resumeSession(handle, config);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const created = await manager.createAgent(
      { provider: "codex", cwd: workdir },
      "00000000-0000-4000-8000-000000000216",
      { workspaceId: undefined },
    );
    const collection = manager.collectIdleAgents({
      cutoff: new Date(Date.now() + 1_000),
      protectedAgentIds: new Set(),
    });
    await closeStarted.promise;
    const loads = Promise.all([
      ensureAgentLoaded(created.id, { agentManager: manager, agentStorage: storage, logger }),
      ensureAgentLoaded(created.id, { agentManager: manager, agentStorage: storage, logger }),
    ]);

    expect(client.resumeCount).toBe(0);
    closeAllowed.resolve();
    const [first, second] = await loads;
    await collection;

    expect(first.id).toBe(created.id);
    expect(second.id).toBe(created.id);
    expect(client.resumeCount).toBe(1);
  } finally {
    await manager.closeAgent("00000000-0000-4000-8000-000000000216").catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("provider close failure still persists and emits a resumable closed agent", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-close-failure-"));
  const storage = new AgentStorage(join(workdir, "agents"), logger);
  const client = new (class extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new (class extends TestAgentSession {
        override async close(): Promise<void> {
          throw new Error("provider cleanup failed");
        }
      })(config);
    }
  })();
  const manager = new AgentManager({ clients: { codex: client }, registry: storage, logger });

  try {
    const created = await manager.createAgent(
      { provider: "codex", cwd: workdir },
      "00000000-0000-4000-8000-000000000217",
      { workspaceId: undefined },
    );
    const closed = waitForAgentLifecycle(manager, created.id, "closed");

    const collection = await manager.collectIdleAgents({
      cutoff: new Date(Date.now() + 1_000),
      protectedAgentIds: new Set(),
    });
    await closed;
    expect(collection.collected).toEqual([]);
    expect(collection.failures).toHaveLength(1);
    expect(collection.failures[0]).toMatchObject({
      agentId: created.id,
      provider: "codex",
      error: expect.objectContaining({ message: "provider cleanup failed" }),
    });
    const stored = await storage.get(created.id);
    expect(stored).toMatchObject({ lastStatus: "closed" });
    expect(stored?.archivedAt).toBeFalsy();

    await expect(
      ensureAgentLoaded(created.id, { agentManager: manager, agentStorage: storage, logger }),
    ).resolves.toMatchObject({ id: created.id, lifecycle: "idle" });
  } finally {
    await manager.closeAgent("00000000-0000-4000-8000-000000000217").catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
});

test("hydrateTimeline keeps provider user_message items when no canonical user history exists", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-keep-user-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class HistoryWithUserMessagesSession extends TestAgentSession {
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

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.hydrateTimelineFromProvider(snapshot.id);

  const timeline = manager.getTimeline(snapshot.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");
  const assistantMessages = timeline.filter((item) => item.type === "assistant_message");
  expect(userMessages).toHaveLength(2);
  expect(assistantMessages).toHaveLength(2);
});

test("hydrateTimeline preserves provider replay timestamps and marks missing ones untrusted", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-history-timestamps-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class TimestampedHistorySession extends TestAgentSession {
    async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
      yield {
        type: "timeline",
        provider: this.provider,
        timestamp: "2026-05-01T10:00:00.000Z",
        item: { type: "user_message", text: "hello", messageId: "msg_history_1" },
      };
      yield {
        type: "timeline",
        provider: this.provider,
        item: { type: "assistant_message", text: "no original timestamp" },
      };
    }
  }

  class TimestampedHistoryClient implements AgentClient {
    readonly provider = "codex" as const;
    readonly capabilities = TEST_CAPABILITIES;

    async isAvailable(): Promise<boolean> {
      return true;
    }

    async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new TimestampedHistorySession(config);
    }

    async resumeSession(): Promise<AgentSession> {
      throw new Error("Not used in this test");
    }
  }

  const manager = new AgentManager({
    clients: {
      codex: new TimestampedHistoryClient(),
    },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000204",
  });

  const snapshot = await manager.createAgent(
    {
      provider: "codex",
      cwd: workdir,
    },
    undefined,
    { workspaceId: undefined },
  );

  await manager.hydrateTimelineFromProvider(snapshot.id);
  const timeline = manager.fetchTimeline(snapshot.id, { direction: "tail", limit: 0 }).rows;

  expect(timeline).toHaveLength(2);
  expect(timeline[0]).toMatchObject({
    timestamp: "2026-05-01T10:00:00.000Z",
    item: { type: "user_message", text: "hello", messageId: "msg_history_1" },
  });
  expect(timeline[1]?.timestamp).toEqual(expect.any(String));
});

test("provider user_message is recorded from the live stream", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-no-prior-record-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  // Session whose live turn yields a user_message without prior canonical recording
  class UnexpectedUserMessageSession extends TestAgentSession {
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

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "do something" });

  const timeline = manager.getTimeline(snapshot.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");

  // Provider's user_message should be recorded (no canonical to dedup against)
  expect(userMessages).toHaveLength(1);
  expect(userMessages[0].text).toBe("continuation prompt");
});

test("authoritative timeline includes provider-emitted submitted user prompt", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-submitted-prompt-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  class SubmittedUserMessageSession extends TestAgentSession {
    override async startTurn(
      prompt: AgentPromptInput,
      options?: AgentRunOptions,
    ): Promise<{ turnId: string }> {
      const turnId = "turn-submitted-user-message";
      const text = typeof prompt === "string" ? prompt : "";
      setTimeout(() => {
        this.pushEvent({ type: "turn_started", provider: this.provider, turnId });
        this.pushEvent({
          type: "timeline",
          provider: this.provider,
          turnId,
          item: { type: "user_message", text, messageId: options?.messageId },
        });
        this.pushEvent({ type: "turn_completed", provider: this.provider, turnId });
      }, 0);
      return { turnId };
    }
  }

  class SubmittedUserMessageClient extends TestAgentClient {
    override async createSession(config: AgentSessionConfig): Promise<AgentSession> {
      return new SubmittedUserMessageSession(config);
    }
  }

  const manager = new AgentManager({
    clients: { codex: new SubmittedUserMessageClient() },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-000000000402",
  });

  try {
    const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
      workspaceId: undefined,
    });

    await manager.runAgent(snapshot.id, "hello from composer", { messageId: "msg-client-1" });

    const timeline = manager.fetchTimeline(snapshot.id, { direction: "tail", limit: 20 }).rows;
    expect(timeline.map((row) => row.item)).toContainEqual({
      type: "user_message",
      text: "hello from composer",
      messageId: "msg-client-1",
    });
  } finally {
    await manager.flush().catch(() => undefined);
    await storage.flush().catch(() => undefined);
    rmSync(workdir, { recursive: true, force: true });
  }
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

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

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
  const secondRun = await manager.replaceAgentRun(snapshot.id, "replacement prompt");
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

class RecordingPersistedAgentsClient implements AgentClient {
  readonly capabilities = TEST_CAPABILITIES;
  calls = 0;

  constructor(public readonly provider: AgentProvider) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(): Promise<AgentSession> {
    throw new Error(`unexpected createSession for ${this.provider}`);
  }

  async resumeSession(): Promise<AgentSession> {
    throw new Error(`unexpected resumeSession for ${this.provider}`);
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }

  async listImportableSessions() {
    this.calls += 1;
    return [
      {
        providerHandleId: `${this.provider}-session`,
        cwd: "/tmp/recent",
        title: null,
        lastActivityAt: new Date("2026-01-01T00:00:00Z"),
        firstPromptPreview: null,
        lastPromptPreview: null,
      },
    ];
  }
}

test.each([
  [
    "disabled",
    "claude",
    "codex",
    {
      claude: { enabled: true, derivedFromProviderId: null },
      codex: { enabled: false, derivedFromProviderId: null },
    },
  ],
])(
  "listImportableSessions skips %s providers in fan-out",
  async (_reason, includedProvider, skippedProvider, providerDefinitions) => {
    const includedClient = new RecordingPersistedAgentsClient(includedProvider);
    const skippedClient = new RecordingPersistedAgentsClient(skippedProvider);
    const manager = new AgentManager({
      clients: { [includedProvider]: includedClient, [skippedProvider]: skippedClient },
      providerDefinitions,
      logger,
    });

    const result = await manager.listImportableSessions();

    expect(includedClient.calls).toBe(1);
    expect(skippedClient.calls).toBe(0);
    expect(result.map((d) => d.provider)).toEqual([includedProvider]);
  },
);

test("listImportableSessions includes derived providers that list persisted agents", async () => {
  const claudeClient = new RecordingPersistedAgentsClient("claude");
  const ompClient = new RecordingPersistedAgentsClient("omp");
  const manager = new AgentManager({
    clients: { claude: claudeClient, omp: ompClient },
    providerDefinitions: {
      claude: { enabled: true, derivedFromProviderId: null },
      omp: { enabled: true, derivedFromProviderId: "pi" },
    },
    logger,
  });

  const result = await manager.listImportableSessions();

  expect(claudeClient.calls).toBe(1);
  expect(ompClient.calls).toBe(1);
  expect(result.map((d) => d.provider).sort()).toEqual(["claude", "omp"]);
});

test("listImportableSessions narrows to the providerFilter when supplied", async () => {
  const claudeClient = new RecordingPersistedAgentsClient("claude");
  const codexClient = new RecordingPersistedAgentsClient("codex");
  const manager = new AgentManager({
    clients: { claude: claudeClient, codex: codexClient },
    providerDefinitions: {
      claude: { enabled: true, derivedFromProviderId: null },
      codex: { enabled: true, derivedFromProviderId: null },
    },
    logger,
  });

  const result = await manager.listImportableSessions({
    providerFilter: new Set(["claude"]),
  });

  expect(claudeClient.calls).toBe(1);
  expect(codexClient.calls).toBe(0);
  expect(result.map((d) => d.provider)).toEqual(["claude"]);
});

test("listImportableSessions skips providers that lack supportsSessionListing even when row listing is defined", async () => {
  const listableClient = new RecordingPersistedAgentsClient("claude");
  const nonListableClient = new RecordingPersistedAgentsClient("acp");
  // Override capabilities to remove session listing support
  Object.defineProperty(nonListableClient, "capabilities", {
    value: {
      ...TEST_CAPABILITIES,
      supportsSessionListing: false,
    },
  });

  const manager = new AgentManager({
    clients: { claude: listableClient, acp: nonListableClient },
    providerDefinitions: {
      claude: { enabled: true, derivedFromProviderId: null },
      acp: { enabled: true, derivedFromProviderId: null },
    },
    logger,
  });

  const result = await manager.listImportableSessions();

  expect(listableClient.calls).toBe(1);
  expect(nonListableClient.calls).toBe(0);
  expect(result.map((d) => d.provider)).toEqual(["claude"]);
});

test("user_message events wrapping a paseo-system envelope are not added to the timeline", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-envelope-live-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  const codex = fakeCodexEmitting({
    turnItems: [
      {
        type: "user_message",
        text: formatSystemNotificationPrompt("child finished"),
      },
      { type: "user_message", text: "plain user message" },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-0000000005a1",
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "do something" });

  const timeline = manager.getTimeline(snapshot.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");

  expect(userMessages).toHaveLength(1);
  expect(userMessages[0].text).toBe("plain user message");
});

test("user_message events wrapping a paseo-system envelope are not restored during history replay", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-envelope-history-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);

  const codex = fakeCodexEmitting({
    historyItems: [
      {
        type: "user_message",
        text: formatSystemNotificationPrompt("schedule fired"),
        messageId: "msg_history_envelope",
      },
      {
        type: "user_message",
        text: "real user message",
        messageId: "msg_history_real",
      },
      { type: "assistant_message", text: "reply" },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    idFactory: () => "00000000-0000-4000-8000-0000000005a2",
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.hydrateTimelineFromProvider(snapshot.id);

  const timeline = manager.getTimeline(snapshot.id);
  const userMessages = timeline.filter((item) => item.type === "user_message");

  expect(userMessages).toHaveLength(1);
  expect(userMessages[0].text).toBe("real user message");
});

test("commandMayHaveChangedExternalState matches remote-state commands", () => {
  // GitHub PR operations (remote, no local file changes)
  expect(commandMayHaveChangedExternalState("gh pr merge 123")).toBe(true);
  expect(commandMayHaveChangedExternalState("gh pr close 123")).toBe(true);
  expect(commandMayHaveChangedExternalState("gh pr create")).toBe(true);
  expect(commandMayHaveChangedExternalState("gh pr edit 123")).toBe(true);
  expect(commandMayHaveChangedExternalState('gh pr comment 123 -b "lgtm"')).toBe(true);
  expect(commandMayHaveChangedExternalState("gh pr review 123 -a")).toBe(true);
  // Git remote operations (local refs unchanged)
  expect(commandMayHaveChangedExternalState("git push origin main")).toBe(true);
  expect(commandMayHaveChangedExternalState("git fetch origin")).toBe(true);
});

test("commandMayHaveChangedExternalState ignores local or read-only commands", () => {
  // Local git mutations — already caught by file watchers on .git/HEAD
  expect(commandMayHaveChangedExternalState("git commit -m 'hello'")).toBe(false);
  expect(commandMayHaveChangedExternalState("git checkout main")).toBe(false);
  expect(commandMayHaveChangedExternalState("git merge feature")).toBe(false);
  expect(commandMayHaveChangedExternalState("git rebase main")).toBe(false);
  expect(commandMayHaveChangedExternalState("git reset --hard HEAD~1")).toBe(false);
  // git pull includes a merge/rebase that changes local refs → watchers catch it
  expect(commandMayHaveChangedExternalState("git pull origin main")).toBe(false);
  // Read-only gh commands
  expect(commandMayHaveChangedExternalState("gh pr view 123")).toBe(false);
  expect(commandMayHaveChangedExternalState("gh pr list")).toBe(false);
  expect(commandMayHaveChangedExternalState("gh auth status")).toBe(false);
  expect(commandMayHaveChangedExternalState("gh repo view")).toBe(false);
  // Miscellaneous local commands
  expect(commandMayHaveChangedExternalState("git status")).toBe(false);
  expect(commandMayHaveChangedExternalState("ls -la")).toBe(false);
  expect(commandMayHaveChangedExternalState("cat file.txt")).toBe(false);
  expect(commandMayHaveChangedExternalState("npm install")).toBe(false);
  expect(commandMayHaveChangedExternalState("npm publish")).toBe(false);
});

test("onWorkspaceStateMayHaveChanged is called when a completed shell tool call may have changed external state", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-external-state-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const onWorkspaceStateMayHaveChanged = vi.fn();

  const codex = fakeCodexEmitting({
    turnItems: [
      {
        type: "tool_call",
        callId: "call-1",
        name: "bash",
        status: "completed",
        detail: { type: "shell", command: "gh pr merge 123 --squash" },
        error: null,
      },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    onWorkspaceStateMayHaveChanged,
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "merge it" });

  expect(onWorkspaceStateMayHaveChanged).toHaveBeenCalledTimes(1);
  expect(onWorkspaceStateMayHaveChanged).toHaveBeenCalledWith({ cwd: workdir });
});

test("onWorkspaceStateMayHaveChanged is not called for non-shell tool calls", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-external-state-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const onWorkspaceStateMayHaveChanged = vi.fn();

  const codex = fakeCodexEmitting({
    turnItems: [
      {
        type: "tool_call",
        callId: "call-1",
        name: "read",
        status: "completed",
        detail: { type: "read", filePath: "/tmp/foo.txt" },
        error: null,
      },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    onWorkspaceStateMayHaveChanged,
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "read it" });

  expect(onWorkspaceStateMayHaveChanged).not.toHaveBeenCalled();
});

test("onWorkspaceStateMayHaveChanged is not called for running shell tool calls", async () => {
  const workdir = mkdtempSync(join(tmpdir(), "agent-manager-external-state-"));
  const storagePath = join(workdir, "agents");
  const storage = new AgentStorage(storagePath, logger);
  const onWorkspaceStateMayHaveChanged = vi.fn();

  const codex = fakeCodexEmitting({
    turnItems: [
      {
        type: "tool_call",
        callId: "call-1",
        name: "bash",
        status: "running",
        detail: { type: "shell", command: "gh pr merge 123 --squash" },
        error: null,
      },
    ],
  });

  const manager = new AgentManager({
    clients: { codex },
    registry: storage,
    logger,
    onWorkspaceStateMayHaveChanged,
  });

  const snapshot = await manager.createAgent({ provider: "codex", cwd: workdir }, undefined, {
    workspaceId: undefined,
  });

  await manager.runAgent(snapshot.id, { text: "merge it" });

  expect(onWorkspaceStateMayHaveChanged).not.toHaveBeenCalled();
});
