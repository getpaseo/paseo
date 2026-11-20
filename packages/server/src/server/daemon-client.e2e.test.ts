import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import {
  createDaemonTestContext,
  type DaemonTestContext,
  DaemonClient,
} from "./test-utils/index.js";
import { createTestPaseoDaemon } from "./test-utils/paseo-daemon.js";
import { createTestAgentClients } from "./test-utils/fake-agent-client.js";
import { selectLegacyAdoptions } from "./agent/plugin-config-adoption.js";
import { getFullAccessConfig, getAskModeConfig } from "./daemon-e2e/agent-configs.js";
import { parsePcm16MonoWav, wordSimilarity } from "./test-utils/dictation-e2e.js";
import type {
  AgentClient,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentRunResult,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "./agent/agent-sdk-types.js";

const openaiApiKey = process.env.OPENAI_API_KEY ?? null;

const localModelsDir =
  process.env.PASEO_LOCAL_MODELS_DIR ?? path.join(homedir(), ".paseo", "models", "local-speech");
const testFileDir = path.dirname(fileURLToPath(import.meta.url));
const appE2eFixturesDir = path.resolve(testFileDir, "../../../app/e2e/support/fixtures");

function fixturePath(fileName: string): string {
  return path.join(appE2eFixturesDir, fileName);
}

async function readFixture(fileName: string): Promise<Buffer> {
  return readFile(fixturePath(fileName));
}

function hasSherpaParakeetModels(modelsDir: string): boolean {
  return (
    existsSync(
      path.join(modelsDir, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "encoder.int8.onnx"),
    ) &&
    existsSync(path.join(modelsDir, "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8", "tokens.txt"))
  );
}

function hasSherpaKokoroModels(modelsDir: string): boolean {
  return (
    existsSync(path.join(modelsDir, "kokoro-en-v0_19", "model.onnx")) &&
    existsSync(path.join(modelsDir, "kokoro-en-v0_19", "voices.bin")) &&
    existsSync(path.join(modelsDir, "kokoro-en-v0_19", "tokens.txt"))
  );
}

const hasLocalSpeech =
  hasSherpaParakeetModels(localModelsDir) && hasSherpaKokoroModels(localModelsDir);
const hasAnySpeech = hasLocalSpeech || Boolean(openaiApiKey);
const speechTest = hasAnySpeech ? test : test.skip;

function tmpCwd(): string {
  return mkdtempSync(path.join(tmpdir(), "daemon-client-"));
}

test("DaemonClient connects to a password-protected daemon", async () => {
  const daemon = await createTestPaseoDaemon({
    auth: { password: "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76" },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    password: "shared-secret",
  });

  try {
    await client.connect();
    const agents = await client.fetchAgents();
    expect(agents.entries).toEqual([]);
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("DaemonClient surfaces password auth failures from WebSocket close reasons", async () => {
  const daemon = await createTestPaseoDaemon({
    auth: { password: "$2b$12$GMhF7pN4QnMlHOQXOqjd1OitKWPSmAO3FwB0PHzKtcZR/sAMryz76" },
  });
  const missingPasswordClient = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    reconnect: { enabled: false },
  });
  const wrongPasswordClient = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    password: "wrong-secret",
    reconnect: { enabled: false },
  });

  try {
    await expect(missingPasswordClient.connect()).rejects.toThrow("Password required");
    expect(missingPasswordClient.lastError).toBe("Password required");

    await expect(wrongPasswordClient.connect()).rejects.toThrow("Incorrect password");
    expect(wrongPasswordClient.lastError).toBe("Incorrect password");
  } finally {
    await missingPasswordClient.close();
    await wrongPasswordClient.close();
    await daemon.close();
  }
});

test("createAgent without an initial prompt returns an idle snapshot", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });

    const agent = await client.createAgent({
      provider: "codex",
      cwd: tmpCwd(),
      title: "No prompt agent",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });

    expect(agent.status).toBe("idle");
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("DaemonClient uploads file bytes to daemon temp storage", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();

    const result = await client.uploadFile({
      fileName: "notes.txt",
      mimeType: "text/plain",
      bytes: new TextEncoder().encode("hello world"),
      modifiedAt: "2026-05-02T00:00:00.000Z",
      requestId: "req-upload-e2e",
      chunkSize: 5,
    });

    const uploadId = result.file?.id ?? "";
    expect(uploadId).toMatch(
      /^upload_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(result).toEqual({
      requestId: "req-upload-e2e",
      file: {
        type: "uploaded_file",
        id: uploadId,
        fileName: "notes.txt",
        mimeType: "text/plain",
        size: 11,
        path: path.join(daemon.paseoHome, "uploads", uploadId, "notes.txt"),
      },
      error: null,
    });
    await expect(readFile(result.file?.path ?? "", "utf8")).resolves.toBe("hello world");
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("agent.config.apply sets an option that has no control and the next snapshot reports it", async () => {
  const clients = createTestAgentClients();
  const codex = clients.codex as AgentClient;
  const applied: unknown[] = [];
  // Records what reaches the provider session; behavior is the fake client's.
  const recordingCodex: AgentClient = Object.create(codex, {
    createSession: {
      value: async (...args: Parameters<AgentClient["createSession"]>) => {
        const session = await codex.createSession(...args);
        const apply = session.applyOptions?.bind(session);
        session.applyOptions = async (options) => {
          applied.push(options);
          await apply?.(options);
        };
        return session;
      },
    },
  });
  const daemon = await createTestPaseoDaemon({
    agentClients: { ...clients, codex: recordingCodex },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });
    const agent = await client.createAgent({
      provider: "codex",
      cwd: tmpCwd(),
      title: "Options agent",
      modeId: "full-access",
      model: "gpt-5.4-mini",
    });
    expect(agent.options?.sandbox_mode).toBeUndefined();

    await client.applyAgentConfig(agent.id, { options: { sandbox_mode: "read-only" } });

    expect(applied).toEqual([expect.objectContaining({ sandbox_mode: "read-only" })]);
    const next = await client.fetchAgent(agent.id);
    expect(next?.agent.options).toMatchObject({ sandbox_mode: "read-only" });
    expect(next?.agent.controls?.map((control) => control.key)).not.toContain("sandbox_mode");
  } finally {
    await client.close();
    await daemon.close();
  }
});

test("createAgent with background initialPrompt returns a running snapshot before turn completion", async () => {
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });

    const agent = await client.createAgent({
      provider: "codex",
      cwd: tmpCwd(),
      title: "Background prompt agent",
      modeId: "full-access",
      model: "gpt-5.4-mini",
      initialPrompt: "Run exactly: sleep 30",
    });

    expect(agent.status).toBe("running");

    const fetchedWhileRunning = await client.fetchAgent({ agentId: agent.id });
    expect(fetchedWhileRunning?.agent.status).toBe("running");

    await new Promise((resolve) => setTimeout(resolve, 350));

    const fetchedAfterCompletion = await client.fetchAgent({ agentId: agent.id });
    expect(fetchedAfterCompletion?.agent.status).toBe("idle");
  } finally {
    await client.close();
    await daemon.close();
  }
});

interface StubAgentOptions {
  sessionId: string;
  supportsStreaming: boolean;
  startError?: string;
  interruptError?: string;
}

class StubAgentSession implements AgentSession {
  readonly provider = "codex" as const;
  readonly capabilities;
  private activeTurnId: string | null = null;

  constructor(private readonly options: StubAgentOptions) {
    this.capabilities = {
      supportsStreaming: options.supportsStreaming,
      supportsSessionPersistence: true,
      supportsDynamicModes: false,
      supportsMcpServers: false,
      supportsReasoningStream: false,
      supportsToolInvocations: false,
      supportsRewindConversation: false,
      supportsRewindFiles: false,
      supportsRewindBoth: false,
    } as const;
  }

  get id(): string {
    return this.options.sessionId;
  }

  async run(): Promise<AgentRunResult> {
    return { sessionId: this.id, finalText: "", timeline: [] };
  }

  async startTurn(): Promise<{ turnId: string }> {
    if (this.options.startError) throw new Error(this.options.startError);
    if (this.activeTurnId) throw new Error("A foreground turn is already active");
    this.activeTurnId = "provider-owned-turn";
    return { turnId: this.activeTurnId };
  }

  subscribe(): () => void {
    return () => undefined;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {}

  async getRuntimeInfo() {
    return {
      provider: this.provider,
      sessionId: this.id,
      model: "gpt-5.4-mini",
      modeId: "full-access",
    };
  }

  async getAvailableModes() {
    return [{ id: "full-access", label: "Full access", description: "No prompts" }];
  }

  async getCurrentMode(): Promise<string> {
    return "full-access";
  }

  async setMode(): Promise<void> {}
  getPendingPermissions() {
    return [];
  }
  async respondToPermission(): Promise<void> {}
  describePersistence(): AgentPersistenceHandle {
    return { provider: this.provider, sessionId: this.id };
  }
  async interrupt(): Promise<void> {
    if (this.options.interruptError) throw new Error(this.options.interruptError);
  }
  async close(): Promise<void> {
    this.activeTurnId = null;
  }
}

class StubAgentClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities;

  constructor(private readonly options: StubAgentOptions) {
    this.capabilities = new StubAgentSession(options).capabilities;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
  async createSession(): Promise<AgentSession> {
    return new StubAgentSession(this.options);
  }
  async resumeSession(): Promise<AgentSession> {
    return new StubAgentSession(this.options);
  }
  async fetchCatalog() {
    return {
      models: [{ id: "gpt-5.4-mini", label: "GPT-5.4 mini", provider: this.provider }],
      modes: [{ id: "full-access", label: "Full access", description: "No prompts" }],
    };
  }
}

class RecordingMcpResumeClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities;
  readonly resumeOverrides: Array<Partial<AgentSessionConfig> | undefined> = [];
  readonly resumeLaunchContexts: Array<AgentLaunchContext | undefined> = [];
  private readonly inner = createTestAgentClients({ supportsMcpServers: true }).codex;

  constructor() {
    this.capabilities = this.inner.capabilities;
  }

  isAvailable() {
    return this.inner.isAvailable();
  }

  createSession(config: AgentSessionConfig) {
    return this.inner.createSession(config);
  }

  resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    this.resumeOverrides.push(overrides);
    this.resumeLaunchContexts.push(launchContext);
    return this.inner.resumeSession(handle, overrides);
  }

  fetchCatalog(...args: Parameters<AgentClient["fetchCatalog"]>) {
    return this.inner.fetchCatalog(...args);
  }
}

class UnsupportedMcpResumeSession extends StubAgentSession {
  closed = false;

  constructor() {
    super({
      sessionId: "unsupported-mcp-resume-session",
      supportsStreaming: false,
    });
  }

  override async close(): Promise<void> {
    this.closed = true;
  }
}

class RejectingMcpResumeClient implements AgentClient {
  readonly provider = "codex" as const;
  readonly capabilities;
  readonly nativeArchiveCalls: string[] = [];
  readonly replacement = new UnsupportedMcpResumeSession();
  private readonly inner = createTestAgentClients({ supportsMcpServers: true }).codex;

  constructor() {
    this.capabilities = this.inner.capabilities;
  }

  isAvailable() {
    return this.inner.isAvailable();
  }

  createSession(config: AgentSessionConfig) {
    return this.inner.createSession(config);
  }

  async resumeSession(): Promise<AgentSession> {
    return this.replacement;
  }

  fetchCatalog(...args: Parameters<AgentClient["fetchCatalog"]>) {
    return this.inner.fetchCatalog(...args);
  }

  async archiveNativeSession(): Promise<void> {
    this.nativeArchiveCalls.push("archive");
  }

  async unarchiveNativeSession(): Promise<void> {
    this.nativeArchiveCalls.push("unarchive");
  }
}

test("createAgent preserves the error snapshot when the initial turn cannot start", async () => {
  const testAgent = new StubAgentClient({
    sessionId: "start-turn-failure-session",
    supportsStreaming: false,
    startError: "Initial turn failed to start",
  });

  const daemon = await createTestPaseoDaemon({
    agentClients: { codex: testAgent },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.1.82",
  });

  try {
    await client.connect();
    await client.fetchAgents({ subscribe: {} });

    const created = await client.createAgent({
      provider: "codex",
      cwd: tmpCwd(),
      title: "Start failure agent",
      modeId: "full-access",
      model: "gpt-5.4-mini",
      initialPrompt: "Run exactly: sleep 30",
    });
    expect(created.status).toBe("error");
    expect(created.lastError).toBe("Initial turn failed to start");
    const fetched = await client.fetchAgent({ agentId: created.id });
    expect(fetched?.agent.lastError).toBe("Initial turn failed to start");
  } finally {
    await client.close();
    await daemon.close();
  }
});

function createUninterruptibleClient(): AgentClient {
  return new StubAgentClient({
    sessionId: "uninterruptible-session",
    supportsStreaming: true,
    interruptError: "Provider did not acknowledge cancellation",
  });
}

test("DaemonClient rejects a replacement prompt when cancellation is not acknowledged", async () => {
  const cwd = tmpCwd();
  const daemon = await createTestPaseoDaemon({
    agentClients: { codex: createUninterruptibleClient() },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

  try {
    await client.connect();
    const agent = await client.createAgent({ provider: "codex", cwd });
    await client.sendMessage(agent.id, "Keep working on the first prompt.");

    await expect(client.sendMessage(agent.id, "Replace it with this prompt.")).rejects.toThrow(
      `Cannot replace agent ${agent.id} because its active run cancellation was not acknowledged`,
    );
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

test("DaemonClient rejects Stop when cancellation is not acknowledged", async () => {
  const cwd = tmpCwd();
  const daemon = await createTestPaseoDaemon({
    agentClients: { codex: createUninterruptibleClient() },
  });
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });

  try {
    await client.connect();
    const agent = await client.createAgent({ provider: "codex", cwd });
    await client.sendMessage(agent.id, "Keep working until stopped.");

    await expect(client.cancelAgent(agent.id)).rejects.toThrow(
      `Cannot stop agent ${agent.id} because its active run cancellation was not acknowledged`,
    );
  } finally {
    await client.close();
    await daemon.close();
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30_000);

function waitForSignal<T>(
  timeoutMs: number,
  setup: (resolve: (value: T) => void, reject: (error: Error) => void) => () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let cleanup: (() => void) | null = null;
    const timeout = setTimeout(() => {
      if (cleanup) {
        cleanup();
      }
      reject(new Error(`Timeout waiting for event after ${timeoutMs}ms`));
    }, timeoutMs);

    cleanup = setup(
      (value) => {
        clearTimeout(timeout);
        cleanup?.();
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        cleanup?.();
        reject(error);
      },
    );
  });
}

class NonPersistentReloadSession implements AgentSession {
  readonly provider = "claude" as const;
  readonly id: string | null;
  readonly capabilities = {
    supportsStreaming: false,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: false,
  } as const;

  constructor(
    private readonly onClose: () => void,
    id: string | null = null,
  ) {
    this.id = id;
  }

  async run(): Promise<AgentRunResult> {
    return {
      sessionId: "non-persistent",
      finalText: "",
      timeline: [],
    };
  }

  async startTurn(): Promise<{ turnId: string }> {
    return { turnId: "non-persistent-turn" };
  }

  subscribe(_callback: (event: AgentStreamEvent) => void): () => void {
    return () => undefined;
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* [];
  }

  async getRuntimeInfo() {
    return {
      provider: "claude" as const,
      sessionId: null,
      model: null,
      modeId: null,
    };
  }

  async getAvailableModes(): Promise<[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(_modeId: string): Promise<void> {}

  getPendingPermissions() {
    return [];
  }

  async respondToPermission(): Promise<void> {}

  describePersistence(): AgentPersistenceHandle | null {
    return null;
  }

  async interrupt(): Promise<void> {}

  async close(): Promise<void> {
    this.onClose();
  }
}

class NonPersistentReloadClient implements AgentClient {
  readonly provider = "claude" as const;
  readonly capabilities = {
    supportsStreaming: false,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: false,
  } as const;
  createSessionCalls = 0;
  resumeSessionCalls = 0;
  closeCalls = 0;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    this.createSessionCalls += 1;
    return new NonPersistentReloadSession(() => {
      this.closeCalls += 1;
    });
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.resumeSessionCalls += 1;
    return new NonPersistentReloadSession(() => {
      this.closeCalls += 1;
    });
  }

  async fetchCatalog() {
    return { models: [], modes: [] };
  }
}

class FailingResumeSession extends NonPersistentReloadSession {
  constructor(onClose: () => void) {
    super(onClose, "failing-resume-session");
  }

  describePersistence(): AgentPersistenceHandle | null {
    return {
      provider: "claude",
      sessionId: this.id,
      metadata: { cwd: process.cwd() },
    };
  }
}

class FailingResumeClient extends NonPersistentReloadClient {
  async createSession(_config: AgentSessionConfig): Promise<AgentSession> {
    this.createSessionCalls += 1;
    return new FailingResumeSession(() => {
      this.closeCalls += 1;
    });
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
  ): Promise<AgentSession> {
    this.resumeSessionCalls += 1;
    throw new Error("resume exploded");
  }
}

function resolveSpeechConfig() {
  if (hasLocalSpeech) {
    return {
      providers: {
        dictationStt: { provider: "local" as const, explicit: true },
        voiceStt: { provider: "local" as const, explicit: true },
        voiceTts: { provider: "local" as const, explicit: true },
      },
      local: {
        modelsDir: localModelsDir,
        models: {
          dictationStt: "parakeet-tdt-0.6b-v2-int8",
          voiceStt: "parakeet-tdt-0.6b-v2-int8",
          voiceTts: "kokoro-en-v0_19",
          voiceTtsSpeakerId: 0,
        },
      },
    };
  }
  if (openaiApiKey) {
    return {
      providers: {
        dictationStt: { provider: "openai" as const, explicit: true },
        voiceStt: { provider: "openai" as const, explicit: true },
        voiceTts: { provider: "openai" as const, explicit: true },
      },
    };
  }
  return undefined;
}

let ctx: DaemonTestContext;

beforeAll(async () => {
  const speechConfig = resolveSpeechConfig();

  ctx = await createDaemonTestContext({
    dictationFinalTimeoutMs: 5000,
    ...(openaiApiKey
      ? { openai: { stt: { apiKey: openaiApiKey }, tts: { apiKey: openaiApiKey } } }
      : {}),
    ...(speechConfig ? { speech: speechConfig } : {}),
  });
}, 60000);

afterAll(async () => {
  await ctx.cleanup();
}, 60000);

test("handles session actions", async () => {
  expect(ctx.client.isConnected).toBe(true);

  const agents = await ctx.client.fetchAgents();
  expect(Array.isArray(agents.entries)).toBe(true);

  const cwd = tmpCwd();
  const created = await ctx.client.createAgent({
    config: {
      ...getFullAccessConfig("codex"),
      cwd,
    },
  });

  await expect(ctx.client.setVoiceMode(true, created.id)).resolves.toMatchObject({
    enabled: true,
    agentId: created.id,
    accepted: true,
    error: null,
  });
  await expect(ctx.client.setVoiceMode(false)).resolves.toMatchObject({
    enabled: false,
    agentId: null,
    accepted: true,
    error: null,
  });

  await ctx.client.deleteAgent(randomUUID());
  rmSync(cwd, { recursive: true, force: true });
}, 30000);

test("archives agents and excludes them from default listings", async () => {
  const cwd = tmpCwd();
  try {
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });

    await ctx.client.archiveAgent(created.id);

    const active = await ctx.client.fetchAgents();
    expect(active.entries.some((entry) => entry.agent.id === created.id)).toBe(false);

    const withArchived = await ctx.client.fetchAgents({
      filter: { includeArchived: true },
    });
    expect(withArchived.entries.some((entry) => entry.agent.id === created.id)).toBe(true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("returns rpc error when archiving an unknown agent id", async () => {
  await expect(ctx.client.archiveAgent(randomUUID())).rejects.toThrow();
}, 10000);

test("interrupts a running agent before archiving", async () => {
  const cwd = tmpCwd();
  try {
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });

    await ctx.client.sendMessage(
      created.id,
      "Use your shell tool to run `sleep 30` and then confirm when done.",
    );
    await ctx.client.waitForAgentUpsert(
      created.id,
      (snapshot) => snapshot.status === "running",
      15000,
    );

    const result = await ctx.client.archiveAgent(created.id);
    expect(result.archivedAt).toBeTruthy();

    const archivedResult = await ctx.client.fetchAgent({ agentId: created.id });
    expect(archivedResult).not.toBeNull();
    expect(archivedResult?.agent.archivedAt).toBeTruthy();
    expect(archivedResult?.agent.status).not.toBe("running");
    expect(archivedResult?.agent.requiresAttention).toBe(false);
    expect(archivedResult?.agent.attentionReason).toBeNull();
    expect(archivedResult?.project).not.toBeNull();
    expect(archivedResult?.project?.checkout.cwd).toBe(cwd);

    const runningAgents = await ctx.client.fetchAgents({
      filter: { includeArchived: true, statuses: ["running"] },
    });
    expect(runningAgents.entries.some((entry) => entry.agent.id === created.id)).toBe(false);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 60000);

test("send_agent_message auto-unarchives archived agents", async () => {
  const cwd = tmpCwd();
  try {
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });

    await ctx.client.archiveAgent(created.id);
    await ctx.client.sendMessage(created.id, "Say hello and nothing else");
    const finalState = await ctx.client.waitForFinish(created.id, 120000);
    expect(finalState.status).toBe("idle");

    const refreshed = await ctx.client.fetchAgent({ agentId: created.id });
    expect(refreshed).not.toBeNull();
    expect(refreshed?.agent.archivedAt).toBeNull();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);

test("send_agent_message leaves an archived agent archived when its directory is gone", async () => {
  const cwd = tmpCwd();
  try {
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });
    const archived = await ctx.client.archiveAgent(created.id);
    rmSync(cwd, { recursive: true, force: true });

    await expect(ctx.client.sendMessage(created.id, "hello")).rejects.toThrow(
      "Working directory does not exist",
    );

    const afterSend = await ctx.client.fetchAgent({ agentId: created.id });
    expect(afterSend?.agent.archivedAt).toBe(archived.archivedAt);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("refresh_agent auto-unarchives archived agents", async () => {
  const cwd = tmpCwd();
  try {
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });
    await ctx.client.archiveAgent(created.id);
    await ctx.client.refreshAgent(created.id);

    const refreshed = await ctx.client.fetchAgent({ agentId: created.id });
    expect(refreshed).not.toBeNull();
    expect(refreshed?.agent.archivedAt).toBeNull();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 120000);

test("refresh_agent rebuilds a live agent even when it has no persistence handle", async () => {
  const cwd = tmpCwd();
  const client = new NonPersistentReloadClient();
  const localCtx = await createDaemonTestContext({
    agentClients: {
      claude: client,
    },
  });

  try {
    const created = await localCtx.client.createAgent({
      config: {
        provider: "claude",
        cwd,
      },
    });

    expect(client.createSessionCalls).toBe(1);
    expect(client.resumeSessionCalls).toBe(0);
    expect(client.closeCalls).toBe(0);

    await localCtx.client.refreshAgent(created.id);

    expect(client.createSessionCalls).toBe(2);
    expect(client.resumeSessionCalls).toBe(0);
    expect(client.closeCalls).toBe(1);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("refresh_agent rejects when persisted session resume fails", async () => {
  const cwd = tmpCwd();
  const client = new FailingResumeClient();
  const localCtx = await createDaemonTestContext({
    agentClients: {
      claude: client,
    },
  });

  try {
    const created = await localCtx.client.createAgent({
      config: {
        provider: "claude",
        cwd,
      },
    });
    await localCtx.client.archiveAgent(created.id);

    await expect(localCtx.client.refreshAgent(created.id)).rejects.toMatchObject({
      name: "DaemonRpcError",
      code: "agent_refresh_failed",
      requestType: "refresh_agent_request",
    });
    expect(client.resumeSessionCalls).toBe(1);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume_agent auto-unarchives archived agents", async () => {
  const cwd = tmpCwd();
  try {
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });
    const agentBeforeArchive = await ctx.client.fetchAgent({ agentId: created.id });
    expect(agentBeforeArchive?.agent.persistence).toBeTruthy();
    await ctx.client.archiveAgent(created.id);

    const handle = agentBeforeArchive?.agent.persistence;
    if (!handle) {
      throw new Error("Expected persistence handle for resume test");
    }
    const resumed = await ctx.client.resumeAgent(handle);
    const resumedDetails = await ctx.client.fetchAgent({ agentId: resumed.id });
    expect(resumedDetails).not.toBeNull();
    expect(resumedDetails?.agent.archivedAt).toBeNull();

    if (resumed.id !== created.id) {
      await ctx.client.deleteAgent(resumed.id);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);

test("resume_agent rehydrates the newest private MCP config from a redacted persistence handle", async () => {
  const cwd = tmpCwd();
  const provider = new RecordingMcpResumeClient();
  const localCtx = await createDaemonTestContext({
    agentClients: { codex: provider },
  });
  const bearerA = "durable-resume-bearer-a";
  const bearerB = "durable-resume-bearer-b";
  const externalMcpA = {
    hub: {
      type: "http" as const,
      url: "https://hub.test/mcp/executions/durable-resume",
      headers: { Authorization: `Bearer ${bearerA}` },
    },
  };
  const externalMcpB = {
    hub: {
      ...externalMcpA.hub,
      headers: { Authorization: `Bearer ${bearerB}` },
    },
  };

  try {
    const created = await localCtx.client.createAgent({
      config: {
        provider: "codex",
        cwd,
        mcpServers: externalMcpA,
      },
    });
    const projectedHandle = created.persistence;
    if (!projectedHandle) {
      throw new Error("Expected a projected persistence handle");
    }
    expect(projectedHandle.metadata).not.toHaveProperty("mcpServers");
    expect(JSON.stringify(projectedHandle)).not.toContain(bearerA);

    await localCtx.client.archiveAgent(created.id);
    const resumedWithOverride = await localCtx.client.resumeAgent(projectedHandle, {
      mcpServers: externalMcpB,
    });
    const newestProjectedHandle = resumedWithOverride.persistence;
    if (!newestProjectedHandle) {
      throw new Error("Expected a projected persistence handle after resume");
    }
    expect(provider.resumeOverrides[0]?.mcpServers?.hub).toEqual(externalMcpB.hub);
    expect(JSON.stringify(resumedWithOverride)).not.toContain(bearerA);
    expect(JSON.stringify(resumedWithOverride)).not.toContain(bearerB);

    await localCtx.client.archiveAgent(resumedWithOverride.id);
    const resumedNewest = await localCtx.client.resumeAgent(newestProjectedHandle);

    expect(provider.resumeOverrides).toHaveLength(2);
    expect(provider.resumeOverrides[1]?.mcpServers?.hub).toEqual(externalMcpB.hub);
    expect(provider.resumeOverrides[1]?.mcpServers?.hub).not.toEqual(externalMcpA.hub);
    expect(resumedNewest.persistence?.metadata).not.toHaveProperty("mcpServers");
    expect(JSON.stringify(resumedNewest)).not.toContain(bearerA);
    expect(JSON.stringify(resumedNewest)).not.toContain(bearerB);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test.each([
  { name: "stored plugin policy", plugin: true, replace: false, expected: "plugin" },
  { name: "explicit replacement", plugin: true, replace: true, expected: undefined },
  { name: "legacy required policy", plugin: false, replace: false, expected: undefined },
])("resume_agent preserves required intent for $name", async ({ plugin, replace, expected }) => {
  const cwd = tmpCwd();
  const provider = new RecordingMcpResumeClient();
  const localCtx = await createDaemonTestContext({ agentClients: { codex: provider } });
  const toolPolicy = { preapproved: [{ kind: "mcp" as const, server: "hub", tool: "finish" }] };
  const mcpServers = { hub: { type: "http" as const, url: "http://127.0.0.1/hub" } };
  try {
    const created = await localCtx.client.createAgent({ config: { provider: "codex", cwd } });
    const handle = created.persistence!;
    await localCtx.client.archiveAgent(created.id);
    const storage = localCtx.daemon.daemon.agentStorage;
    const record = await storage.get(created.id);
    await storage.upsert({
      ...record!,
      config: {
        ...record!.config,
        toolPolicy,
        mcpServers,
        ...(plugin ? { toolPolicySource: "plugin" as const } : {}),
      },
    });
    await localCtx.client.resumeAgent(handle, replace ? { toolPolicy } : undefined);
    expect(provider.resumeOverrides).toHaveLength(1);
    expect(provider.resumeOverrides[0]?.toolPolicySource).toBe(expected);
    expect(provider.resumeOverrides[0]?.toolPolicy).toEqual(toolPolicy);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume_agent copies adopted required intent into a new ID without source receipts and honors explicit overrides", async () => {
  const cwd = tmpCwd();
  const provider = new RecordingMcpResumeClient();
  const localCtx = await createDaemonTestContext({ agentClients: { codex: provider } });
  const docs = { type: "http" as const, url: "http://127.0.0.1:1/docs" };
  const requiredPolicy = {
    preapproved: [{ kind: "mcp" as const, server: "docs", tool: "read" }],
  };
  try {
    const created = await localCtx.client.createAgent({
      config: {
        provider: "codex",
        cwd,
        modeId: "default",
        systemPrompt: "Caller instructions\n\nLegacy plugin instructions",
        providerOptions: { caller_option: true, legacy_option: "dummy-legacy-option" },
        mcpServers: {
          docs,
          legacy: {
            type: "http",
            url: "http://127.0.0.1:1/legacy",
            headers: { Authorization: "Bearer dummy-legacy-credential" },
          },
        },
        toolPolicy: requiredPolicy,
      },
    });
    await localCtx.client.archiveAgent(created.id);
    const storage = localCtx.daemon.daemon.agentStorage;
    const original = (await storage.get(created.id))!;
    const receipts = selectLegacyAdoptions({
      pluginId: "notes",
      config: { ...original.config, provider: "codex", cwd },
      env: original.launchEnv ?? {},
      recipe: {
        version: 1,
        selectors: [
          {
            id: "prompt",
            group: "notes",
            label: "Instructions",
            kind: "prompt-suffix",
            text: "\n\nLegacy plugin instructions",
          },
          { id: "endpoint", group: "notes", label: "Endpoint", kind: "mcp", name: "legacy" },
          {
            id: "option",
            group: "notes",
            label: "Option",
            kind: "option",
            key: "legacy_option",
            baselines: [{ id: "inherit", label: "Inherit", kind: "absent" }],
          },
        ],
      },
      selections: [{ id: "prompt" }, { id: "endpoint" }, { id: "option", baselineId: "inherit" }],
    });
    await storage.mutatePluginConfigAdoptions(created.id, () => ({ version: 1, receipts }));
    const sourceBefore = (await storage.get(created.id))!;
    const sourceIntent = JSON.stringify({
      config: sourceBefore.config,
      launchEnv: sourceBefore.launchEnv,
      receipts: sourceBefore.pluginConfigAdoptions,
    });
    const handle = (await localCtx.client.fetchAgent(created.id))!.agent.persistence!;
    expect(handle).toBeTruthy();
    expect(handle.metadata).not.toHaveProperty("mcpServers");
    expect(handle.metadata).not.toHaveProperty("pluginConfigAdoptions");
    expect(JSON.stringify(handle)).not.toContain("dummy-legacy-credential");

    const resumed = await localCtx.client.resumeAgent(handle, {
      modeId: "full-access",
    });

    expect(resumed.id).not.toBe(created.id);
    expect(provider.resumeOverrides).toHaveLength(1);
    expect(provider.resumeOverrides[0]).toMatchObject({
      systemPrompt: "Caller instructions",
      providerOptions: { caller_option: true },
      modeId: "full-access",
      toolPolicy: requiredPolicy,
    });
    expect(provider.resumeOverrides[0]?.mcpServers).toMatchObject({ docs });
    expect(provider.resumeOverrides[0]?.mcpServers).not.toHaveProperty("legacy");
    expect(provider.resumeOverrides[0]?.providerOptions).toEqual({ caller_option: true });
    expect(provider.resumeOverrides[0]?.toolPolicySource).toBeUndefined();
    expect(provider.resumeOverrides[0]?.pluginAppendSystemPrompt).toBeUndefined();
    expect(provider.resumeOverrides[0]?.pluginToolPolicy).toBeUndefined();
    const copied = (await storage.get(resumed.id))!;
    expect(copied.config).toMatchObject({
      systemPrompt: "Caller instructions",
      modeId: "full-access",
      toolPolicy: requiredPolicy,
    });
    expect(copied.config?.mcpServers).toEqual({ docs });
    expect(copied.config?.providerOptions).toEqual({ caller_option: true });
    expect(copied.pluginConfigAdoptions).toBeUndefined();
    expect(JSON.stringify(resumed)).not.toContain("dummy-legacy");
    expect(JSON.stringify(resumed)).not.toContain(receipts[0]!.id);
    const sourceAfter = (await storage.get(created.id))!;
    expect(
      JSON.stringify({
        config: sourceAfter.config,
        launchEnv: sourceAfter.launchEnv,
        receipts: sourceAfter.pluginConfigAdoptions,
      }),
    ).toBe(sourceIntent);
    expect(sourceAfter.config?.toolPolicy).toEqual(requiredPolicy);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume_agent restores the archived source when prompt adoption receipts are stale", async () => {
  const cwd = tmpCwd();
  const provider = new RecordingMcpResumeClient();
  const localCtx = await createDaemonTestContext({ agentClients: { codex: provider } });
  try {
    const created = await localCtx.client.createAgent({
      config: {
        provider: "codex",
        cwd,
        systemPrompt: "Caller instructions\n\nLegacy plugin instructions",
        providerOptions: { caller_option: true },
      },
    });
    const handle = created.persistence!;
    const archived = await localCtx.client.archiveAgent(created.id);
    const storage = localCtx.daemon.daemon.agentStorage;
    const original = (await storage.get(created.id))!;
    const receipts = selectLegacyAdoptions({
      pluginId: "notes",
      config: { ...original.config, provider: "codex", cwd },
      env: original.launchEnv ?? {},
      recipe: {
        version: 1,
        selectors: [
          {
            id: "prompt",
            group: "notes",
            label: "Instructions",
            kind: "prompt-suffix",
            text: "\n\nLegacy plugin instructions",
          },
        ],
      },
      selections: [{ id: "prompt" }],
    });
    await storage.mutatePluginConfigAdoptions(created.id, () => ({ version: 1, receipts }));
    await storage.upsert({
      ...original,
      config: {
        ...original.config,
        systemPrompt: "Edited caller instructions\n\nLegacy plugin instructions",
      },
    });
    const sourceBefore = structuredClone((await storage.get(created.id))!);

    await expect(localCtx.client.resumeAgent(handle)).rejects.toMatchObject({
      name: "DaemonRpcError",
      code: "agent_resume_failed",
      requestType: "resume_agent_request",
      userMessage:
        "Adopted plugin configuration is stale; reset the affected selection before editing it",
    });

    expect(provider.resumeOverrides).toHaveLength(0);
    expect((await storage.listAll()).map((record) => record.id)).toEqual([created.id]);
    const sourceAfter = (await storage.get(created.id))!;
    expect(sourceAfter.config).toEqual(sourceBefore.config);
    expect(sourceAfter.launchEnv).toEqual(sourceBefore.launchEnv);
    expect(sourceAfter.pluginConfigAdoptions).toEqual({ version: 1, receipts });
    expect(sourceAfter.persistence).toEqual(sourceBefore.persistence);
    expect(sourceAfter.archivedAt).toBe(archived.archivedAt);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("createAgentFromRecord projects adoption receipts without native persistence and preserves saved intent through archived history", async () => {
  const cwd = tmpCwd();
  const launches: AgentSessionConfig[] = [];
  const historyHandles: AgentPersistenceHandle[] = [];
  const clients = createTestAgentClients({
    supportsMcpServers: true,
    beforeCreateSession: async (config) => {
      launches.push(structuredClone(config));
    },
    beforeResumeSession: async (handle) => {
      historyHandles.push(structuredClone(handle));
    },
  });
  const localCtx = await createDaemonTestContext({ agentClients: clients });
  const id = randomUUID();
  const docs = { type: "http" as const, url: "http://127.0.0.1:1/docs" };
  const requiredPolicy = {
    preapproved: [{ kind: "mcp" as const, server: "docs", tool: "read" }],
  };
  const config: AgentSessionConfig = {
    provider: "codex",
    cwd,
    model: "gpt-5.4-mini",
    modeId: "default",
    systemPrompt: "Caller instructions\n\nLegacy plugin instructions",
    mcpServers: {
      docs,
      legacy: {
        type: "http",
        url: "http://127.0.0.1:1/legacy",
        headers: { Authorization: "Bearer dummy-record-credential" },
      },
    },
    toolPolicy: requiredPolicy,
  };
  try {
    const storage = localCtx.daemon.daemon.agentStorage;
    const now = new Date().toISOString();
    await storage.upsert({
      id,
      provider: "codex",
      cwd,
      labels: {},
      createdAt: now,
      updatedAt: now,
      lastStatus: "closed",
      config: {
        model: config.model,
        modeId: config.modeId,
        systemPrompt: config.systemPrompt,
        mcpServers: config.mcpServers,
        toolPolicy: config.toolPolicy,
      },
    });
    const receipts = selectLegacyAdoptions({
      pluginId: "notes",
      config,
      env: {},
      recipe: {
        version: 1,
        selectors: [
          {
            id: "prompt",
            group: "notes",
            label: "Instructions",
            kind: "prompt-suffix",
            text: "\n\nLegacy plugin instructions",
          },
          { id: "endpoint", group: "notes", label: "Endpoint", kind: "mcp", name: "legacy" },
        ],
      },
      selections: [{ id: "prompt" }, { id: "endpoint" }],
    });
    await storage.mutatePluginConfigAdoptions(id, () => ({ version: 1, receipts }));
    const before = (await storage.get(id))!;
    const originalConfig = structuredClone(before.config);
    expect(before.persistence).toBeUndefined();

    const opened = await localCtx.daemon.daemon.agentManager.createAgentFromRecord(id);

    expect(opened.id).toBe(id);
    expect(launches).toHaveLength(1);
    expect(launches[0]?.systemPrompt).toBe("Caller instructions");
    expect(launches[0]?.mcpServers).toMatchObject({ docs });
    expect(launches[0]?.mcpServers).not.toHaveProperty("legacy");
    expect(launches[0]?.toolPolicy).toEqual(requiredPolicy);
    const after = (await storage.get(id))!;
    expect(after.config).toEqual(originalConfig);
    expect(after.pluginConfigAdoptions).toEqual({ version: 1, receipts });
    const publicAgent = (await localCtx.client.fetchAgent(id))!.agent;
    expect(publicAgent).not.toHaveProperty("pluginConfigAdoptions");
    expect(publicAgent.persistence?.metadata).not.toHaveProperty("mcpServers");
    expect(publicAgent.persistence?.metadata).not.toHaveProperty("pluginConfigAdoptions");
    expect(JSON.stringify(publicAgent)).not.toContain("dummy-record-credential");
    expect(JSON.stringify(publicAgent)).not.toContain(receipts[0]!.id);
    const archived = await localCtx.client.archiveAgent(id);
    const history = await localCtx.client.fetchAgentTimeline(id);
    expect(history.agentId).toBe(id);
    expect(history.agent?.archivedAt).toBe(archived.archivedAt);
    expect(historyHandles).toHaveLength(1);
    expect(launches).toHaveLength(1);
    const afterHistory = (await storage.get(id))!;
    expect(afterHistory.config).toEqual(originalConfig);
    expect(afterHistory.pluginConfigAdoptions).toEqual({ version: 1, receipts });
    expect(afterHistory.archivedAt).toBe(archived.archivedAt);
    expect(JSON.stringify(history)).not.toContain("dummy-record-credential");
    expect(JSON.stringify(history)).not.toContain(receipts[0]!.id);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume_agent treats unmatched handle config as required caller intent without accepting metadata adoption authority", async () => {
  const cwd = tmpCwd();
  const provider = new RecordingMcpResumeClient();
  const localCtx = await createDaemonTestContext({ agentClients: { codex: provider } });
  const config: AgentSessionConfig = {
    provider: "codex",
    cwd,
    systemPrompt: "Imported caller instructions",
    mcpServers: { imported: { type: "http", url: "http://127.0.0.1:1/imported" } },
    toolPolicy: {
      preapproved: [{ kind: "mcp", server: "imported", tool: "read" }],
    },
  };
  const receipts = selectLegacyAdoptions({
    pluginId: "notes",
    config,
    env: {},
    recipe: {
      version: 1,
      selectors: [
        {
          id: "prompt",
          group: "notes",
          label: "Instructions",
          kind: "prompt-suffix",
          text: "Imported caller instructions",
        },
      ],
    },
    selections: [{ id: "prompt" }],
  });
  try {
    const resumed = await localCtx.client.resumeAgent({
      provider: "codex",
      sessionId: "unmatched-imported-session",
      metadata: {
        cwd,
        systemPrompt: config.systemPrompt,
        mcpServers: config.mcpServers,
        toolPolicy: config.toolPolicy,
        toolPolicySource: "plugin",
        pluginConfigAdoptions: { version: 1, receipts },
      },
    });
    expect(provider.resumeOverrides).toHaveLength(1);
    expect(provider.resumeOverrides[0]?.systemPrompt).toBe("Imported caller instructions");
    expect(provider.resumeOverrides[0]?.mcpServers).toMatchObject(config.mcpServers!);
    expect(provider.resumeOverrides[0]?.toolPolicy).toEqual(config.toolPolicy);
    expect(provider.resumeOverrides[0]?.toolPolicySource).toBeUndefined();
    const saved = (await localCtx.daemon.daemon.agentStorage.get(resumed.id))!;
    expect(saved.config?.systemPrompt).toBe("Imported caller instructions");
    expect(saved.config?.mcpServers).toEqual(config.mcpServers);
    expect(saved.config?.toolPolicy).toEqual(config.toolPolicy);
    expect(saved.config?.toolPolicySource).toBeUndefined();
    expect(saved.pluginConfigAdoptions).toBeUndefined();
    expect(resumed.persistence?.metadata).not.toHaveProperty("pluginConfigAdoptions");
    expect(JSON.stringify(resumed)).not.toContain(receipts[0]!.id);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume_agent keeps the workspace of the agent it matches", async () => {
  const cwd = tmpCwd();
  const provider = new RecordingMcpResumeClient();
  const localCtx = await createDaemonTestContext({
    agentClients: { codex: provider },
  });

  try {
    const opened = await localCtx.client.openProject(cwd);
    if (!opened.workspace) {
      throw new Error(opened.error ?? "Workspace did not open");
    }
    const workspaceId = opened.workspace.id;
    const created = await localCtx.client.createAgent({
      config: { provider: "codex", cwd },
      workspaceId,
    });
    if (!created.persistence) {
      throw new Error("Expected a persistence handle");
    }

    await localCtx.client.archiveAgent(created.id);
    const resumed = await localCtx.client.resumeAgent(created.persistence);

    expect(provider.resumeLaunchContexts[0]?.env?.PASEO_WORKSPACE_ID).toBe(workspaceId);
    expect(resumed.workspaceId).toBe(workspaceId);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("resume_agent restores archive state when an MCP-capable provider returns an unsupported session", async () => {
  const cwd = tmpCwd();
  const provider = new RejectingMcpResumeClient();
  const localCtx = await createDaemonTestContext({
    agentClients: { codex: provider },
  });

  try {
    const created = await localCtx.client.createAgent({
      config: {
        provider: "codex",
        cwd,
        mcpServers: {
          hub: {
            type: "http",
            url: "https://hub.test/mcp/executions/rejected-resume",
            headers: { Authorization: "Bearer rejected-resume-secret" },
          },
        },
      },
    });
    const handle = created.persistence;
    if (!handle) {
      throw new Error("Expected a projected persistence handle");
    }
    const archived = await localCtx.client.archiveAgent(created.id);

    await expect(localCtx.client.resumeAgent(handle)).rejects.toMatchObject({
      name: "DaemonRpcError",
      code: "agent_resume_failed",
      requestType: "resume_agent_request",
    });

    const archivedAgents = await localCtx.client.fetchAgents({
      filter: { includeArchived: true },
    });
    const original = archivedAgents.entries.find((entry) => entry.agent.id === created.id)?.agent;
    expect(original?.archivedAt).toBe(archived.archivedAt);
    expect(provider.nativeArchiveCalls).toEqual(["archive", "unarchive", "archive"]);
    expect(provider.replacement.closed).toBe(true);
  } finally {
    await localCtx.cleanup();
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("update_agent persists unloaded title and labels across auto-unarchive", async () => {
  const cwd = tmpCwd();
  try {
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });

    await ctx.client.archiveAgent(created.id);
    await ctx.client.updateAgent(created.id, {
      name: "Pinned Title",
      labels: { lane: "phase-1a" },
    });

    const archived = await ctx.client.fetchAgent({ agentId: created.id });
    expect(archived).not.toBeNull();
    expect(archived?.agent.archivedAt).toBeTruthy();
    expect(archived?.agent.title).toBe("Pinned Title");
    expect(archived?.agent.labels).toMatchObject({ lane: "phase-1a" });

    await ctx.client.sendMessage(created.id, "Say hello and nothing else");
    const finalState = await ctx.client.waitForFinish(created.id, 120000);
    expect(finalState.status).toBe("idle");

    const unarchived = await ctx.client.fetchAgent({ agentId: created.id });
    expect(unarchived).not.toBeNull();
    expect(unarchived?.agent.archivedAt).toBeNull();
    expect(unarchived?.agent.title).toBe("Pinned Title");
    expect(unarchived?.agent.labels).toMatchObject({ lane: "phase-1a" });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);

test("returns home-scoped directory suggestions", async () => {
  const insideHomeDir = mkdtempSync(path.join(homedir(), "paseo-dir-suggestion-"));
  const rootBrowseDir = mkdtempSync(path.join(homedir(), "000-paseo-root-browse-"));
  const outsideHomeDir = mkdtempSync(path.join(tmpdir(), "paseo-dir-suggestion-outside-"));

  try {
    const insideQuery = path.basename(insideHomeDir);
    const insideResult = await ctx.client.getDirectorySuggestions({
      query: insideQuery,
      limit: 25,
    });
    expect(insideResult.error).toBeNull();
    expect(insideResult.directories).toContain(insideHomeDir);

    const rootBrowseResult = await ctx.client.getDirectorySuggestions({
      query: "~",
      limit: 100,
    });
    expect(rootBrowseResult.error).toBeNull();
    expect(rootBrowseResult.directories).toContain(rootBrowseDir);

    const blankResult = await ctx.client.getDirectorySuggestions({ query: "", limit: 100 });
    expect(blankResult.error).toBeNull();
    expect(blankResult.entries).toEqual([]);

    const outsideQuery = path.basename(outsideHomeDir);
    const outsideResult = await ctx.client.getDirectorySuggestions({
      query: outsideQuery,
      limit: 25,
    });
    expect(outsideResult.error).toBeNull();
    expect(outsideResult.directories).not.toContain(outsideHomeDir);
  } finally {
    rmSync(insideHomeDir, { recursive: true, force: true });
    rmSync(rootBrowseDir, { recursive: true, force: true });
    rmSync(outsideHomeDir, { recursive: true, force: true });
  }
}, 30000);

test("returns typed relative suggestions within a requested directory", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-workspace-suggestion-"));
  const target = path.join(cwd, "src", "components", "message-renderer.tsx");

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");

    const result = await ctx.client.getDirectorySuggestions({
      cwd,
      query: "msgrndr",
      includeFiles: true,
      includeDirectories: false,
      limit: 20,
    });

    expect(result.error).toBeNull();
    expect(result.directories).toEqual([]);
    expect(result.entries).toEqual([{ path: "src/components/message-renderer.tsx", kind: "file" }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("finds workspace files inside the OpenCode directory", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-opencode-suggestion-"));
  const target = path.join(
    cwd,
    ".opencode",
    "command",
    "workflow",
    "00-kickoff",
    "00-user-stories.md",
  );

  try {
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "");

    const result = await ctx.client.getDirectorySuggestions({
      cwd,
      query: "00-user-stories.md",
      includeFiles: true,
      includeDirectories: false,
      limit: 20,
    });

    expect(result.error).toBeNull();
    expect(result.directories).toEqual([]);
    expect(result.entries).toEqual([
      {
        path: ".opencode/command/workflow/00-kickoff/00-user-stories.md",
        kind: "file",
      },
    ]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("opens an exact gitignored workspace path without offering it as a suggestion", async () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "paseo-gitignored-suggestion-"));
  const target = path.join(cwd, "generated", "notes.md");

  try {
    execSync("git init -q", { cwd });
    writeFileSync(path.join(cwd, ".gitignore"), "generated/\n");
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "generated notes\n");
    writeFileSync(path.join(cwd, "notes.md"), "tracked notes\n");

    const exactResult = await ctx.client.getDirectorySuggestions({
      cwd,
      query: "generated/notes.md",
      includeFiles: true,
      includeDirectories: false,
      matchMode: "suffix",
      limit: 1,
    });
    const discoveryResult = await ctx.client.getDirectorySuggestions({
      cwd,
      query: "notes",
      includeFiles: true,
      includeDirectories: false,
      limit: 20,
    });

    expect(exactResult.error).toBeNull();
    expect(exactResult.entries).toEqual([{ path: "generated/notes.md", kind: "file" }]);
    expect(discoveryResult.error).toBeNull();
    expect(discoveryResult.entries).toEqual([{ path: "notes.md", kind: "file" }]);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 30000);

test("receives server_info on websocket connect", async () => {
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${ctx.daemon.port}/ws`,
    clientId: `cid-e2e-${randomUUID()}`,
    clientType: "cli",
  });
  await client.connect();
  const serverInfo = client.getLastServerInfoMessage();
  expect(serverInfo).not.toBeNull();
  expect(serverInfo?.serverId.length).toBeGreaterThan(0);
  expect(serverInfo?.features?.["terminal-restore-modes"]).toBe(true);
  expect(serverInfo?.features?.hubRelationship).toBe(true);
  expect(serverInfo?.features?.commitsList).toBe(true);
  expect(serverInfo?.features?.commitBaseClassification).toBe(true);
  expect(serverInfo?.desktopManaged).toBe(false);
  expect(serverInfo?.features?.daemonSelfUpdate).toBe(true);
  expect(serverInfo?.features?.worktreeRestore).toBe(true);
  expect(serverInfo?.features?.workspaceRecovery).toBe(true);

  await client.close();
}, 15000);

test("a Desktop-managed daemon does not advertise npm self-update", async () => {
  const daemon = await createTestPaseoDaemon({ desktopManaged: true });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    clientId: `cid-desktop-managed-${randomUUID()}`,
    clientType: "cli",
  });

  try {
    await client.connect();
    const serverInfo = client.getLastServerInfoMessage();

    expect(serverInfo?.desktopManaged).toBe(true);
    expect(serverInfo?.features?.daemonSelfUpdate).toBe(false);
  } finally {
    await client.close();
    await daemon.close();
  }
}, 15000);

test("emits disabled voice capability reasons on fresh daemon startup", async () => {
  const isolatedCtx = await createDaemonTestContext({
    speech: {
      providers: {
        dictationStt: { provider: "local", explicit: true, enabled: false },
        voiceTurnDetection: { provider: "local", explicit: true, enabled: false },
        voiceStt: { provider: "local", explicit: true, enabled: false },
        voiceTts: { provider: "local", explicit: true, enabled: false },
      },
    },
  });

  const client = new DaemonClient({
    url: `ws://127.0.0.1:${isolatedCtx.daemon.port}/ws`,
    clientId: `cid-e2e-${randomUUID()}`,
    clientType: "cli",
  });

  try {
    await client.connect();
    const serverInfo = client.getLastServerInfoMessage();
    const voice = serverInfo?.capabilities?.voice;
    expect(voice).toBeTruthy();

    expect(voice?.dictation.enabled).toBe(false);
    expect(voice?.dictation.reason).toBe("Dictation is off. Turn it on in Settings > Voice.");
    expect(voice?.voice.enabled).toBe(false);
    expect(voice?.voice.reason).toBe("Voice mode is off. Turn it on in Settings > Voice.");
  } finally {
    await client.close().catch(() => undefined);
    await isolatedCtx.cleanup();
  }
}, 30000);

test("handles concurrent filtered agent fetch requests", async () => {
  const firstRequestId = `fetch-${Date.now()}-a`;
  const secondRequestId = `fetch-${Date.now()}-b`;

  const [first, second] = await Promise.all([
    ctx.client.fetchAgents({
      requestId: firstRequestId,
      filter: { labels: { surface: "voice" } },
    }),
    ctx.client.fetchAgents({
      requestId: secondRequestId,
      filter: { labels: { surface: "voice" } },
    }),
  ]);

  expect(first.requestId).toBe(firstRequestId);
  expect(second.requestId).toBe(secondRequestId);
  expect(Array.isArray(first.entries)).toBe(true);
  expect(Array.isArray(second.entries)).toBe(true);
}, 15000);

test("creates agent and exercises lifecycle", async () => {
  const cwd = tmpCwd();

  await ctx.client.fetchAgents({
    subscribe: {},
  });

  const agentUpdatePromise = waitForSignal(15000, (resolve) => {
    const unsubscribe = ctx.client.on("agent_update", (message) => {
      if (message.type !== "agent_update") {
        return;
      }
      if (message.payload.kind !== "upsert") {
        return;
      }
      resolve(message);
    });
    return unsubscribe;
  });

  const createRequestId = `create-${Date.now()}`;
  const agent = await ctx.client.createAgent({
    ...getFullAccessConfig("codex"),
    cwd,
    title: "Daemon Client V2",
    requestId: createRequestId,
  });

  expect(agent.id).toBeTruthy();
  expect(agent.status).toBe("idle");
  const fetchedResult = await ctx.client.fetchAgent({ agentId: agent.id });
  expect(fetchedResult?.agent.id).toBe(agent.id);

  const agentUpdate = await agentUpdatePromise;
  expect(agentUpdate.payload.agent.id).toBe(agent.id);

  const failRequestId = `fail-${Date.now()}`;
  await expect(
    ctx.client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: "/this/path/does/not/exist/12345",
      title: "Should Fail",
      requestId: failRequestId,
    }),
  ).rejects.toThrow("Working directory does not exist");

  let sawRefresh = false;
  const unsubscribe = ctx.client.subscribe((event) => {
    if (event.type === "status" && event.payload.status === "agent_refreshed") {
      sawRefresh = true;
    }
  });

  const statusPromise = waitForSignal(15000, (resolve) => {
    const unsubscribeStatus = ctx.client.on("status", (message) => {
      if (message.type !== "status") {
        return;
      }
      if (message.payload.status !== "agent_refreshed") {
        return;
      }
      if ((message.payload as { agentId?: string }).agentId !== agent.id) {
        return;
      }
      resolve(message);
    });
    return unsubscribeStatus;
  });

  const refreshResult = await ctx.client.refreshAgent(agent.id);
  unsubscribe();

  expect(refreshResult.status).toBe("agent_refreshed");
  expect(refreshResult.agentId).toBe(agent.id);
  expect(sawRefresh).toBe(true);
  const statusMessage = await statusPromise;
  expect((statusMessage.payload as { agentId?: string }).agentId).toBe(agent.id);

  const timelineResult = await ctx.client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 1,
  });
  expect(timelineResult.agentId).toBe(agent.id);

  const nextMode = agent.availableModes.find((mode) => mode.id !== agent.currentModeId)?.id;

  if (nextMode) {
    await ctx.client.setAgentMode(agent.id, nextMode);
    const modeState = await ctx.client.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.currentModeId === nextMode,
      15000,
    );
    expect(modeState.currentModeId).toBe(nextMode);
  } else {
    await ctx.client.setAgentMode(agent.id, agent.currentModeId ?? "auto");
  }

  let sawAssistantMessage = false;
  let sawRawAssistantMessage = false;
  const unsubscribeStream = ctx.client.subscribe((event) => {
    if (event.type !== "agent_stream" || event.agentId !== agent.id) {
      return;
    }
    if (event.event.type === "timeline" && event.event.item.type === "assistant_message") {
      sawAssistantMessage = true;
    }
  });
  const unsubscribeRawStream = ctx.client.subscribeAgentTimeline(agent.id, (message) => {
    if (message.type !== "agent_stream") {
      return;
    }
    if (message.payload.agentId !== agent.id) {
      return;
    }
    if (
      message.payload.event.type === "timeline" &&
      message.payload.event.item.type === "assistant_message"
    ) {
      sawRawAssistantMessage = true;
    }
  });
  await ctx.client.sendMessage(agent.id, "Say 'hello' and nothing else");
  const finalState = await ctx.client.waitForFinish(agent.id, 120000);
  unsubscribeStream();
  unsubscribeRawStream();
  expect(finalState.status).toBe("idle");
  expect(sawAssistantMessage).toBe(true);
  expect(sawRawAssistantMessage).toBe(true);

  await ctx.client.setVoiceMode(false);

  await ctx.client.abortRequest();
  await ctx.client.audioPlayed("audio-1");
  ctx.client.clearAgentAttention(agent.id);
  await ctx.client.cancelAgent(agent.id);

  const modelsRequestId = `models-${Date.now()}`;
  const modelsPromise = waitForSignal(30000, (resolve) => {
    const unsubscribeModels = ctx.client.on("list_provider_models_response", (message) => {
      if (message.type !== "list_provider_models_response") {
        return;
      }
      if (message.payload.provider !== "codex") {
        return;
      }
      if (message.payload.requestId !== modelsRequestId) {
        return;
      }
      resolve(message);
    });
    return unsubscribeModels;
  });

  const models = await ctx.client.listProviderModels("codex", {
    cwd,
    requestId: modelsRequestId,
  });
  const modelsMessage = await modelsPromise;
  expect(models.provider).toBe("codex");
  expect(models.fetchedAt).toBeTruthy();
  expect(models.requestId).toBe(modelsRequestId);
  expect(modelsMessage.payload.provider).toBe("codex");
  expect(modelsMessage.payload.requestId).toBe(modelsRequestId);

  const commandsRequestId = `commands-${Date.now()}`;
  const commandsResponsePromise = waitForSignal(15000, (resolve) => {
    const unsubscribeCommands = ctx.client.on("list_commands_response", (message) => {
      if (message.type !== "list_commands_response") {
        return;
      }
      if (message.payload.agentId !== agent.id) {
        return;
      }
      if (message.payload.requestId !== commandsRequestId) {
        return;
      }
      resolve(message);
    });
    return unsubscribeCommands;
  });

  const commands = await ctx.client.listCommands({
    agentId: agent.id,
    requestId: commandsRequestId,
  });
  const commandsMessage = await commandsResponsePromise;
  expect(commands.agentId).toBe(agent.id);
  expect(Array.isArray(commands.commands)).toBe(true);
  expect(commands.requestId).toBe(commandsRequestId);
  expect(commandsMessage.payload.agentId).toBe(agent.id);
  expect(commandsMessage.payload.requestId).toBe(commandsRequestId);

  const persistence = finalState.final?.persistence;

  const agentDeletedPromise = waitForSignal(15000, (resolve) => {
    const unsubscribeDeleted = ctx.client.on("agent_deleted", (message) => {
      if (message.type !== "agent_deleted") {
        return;
      }
      if (message.payload.agentId !== agent.id) {
        return;
      }
      resolve(message);
    });
    return unsubscribeDeleted;
  });

  await ctx.client.deleteAgent(agent.id);
  const agentDeleted = await agentDeletedPromise;
  expect(agentDeleted.payload.agentId).toBe(agent.id);

  if (persistence) {
    const resumed = await ctx.client.resumeAgent(persistence);
    expect(resumed.id).toBeTruthy();
    expect(resumed.status).toBe("idle");
    await ctx.client.deleteAgent(resumed.id);
  }

  rmSync(cwd, { recursive: true, force: true });
}, 300000);

test("handles permission flow", async () => {
  const permissionEvents = ctx.client.observeEvents([
    "agent_permission_request",
    "agent_permission_resolved",
  ]);
  await permissionEvents.ready;
  const cwd = tmpCwd();
  const filePath = path.join(cwd, "permission.txt");

  const agent = await ctx.client.createAgent({
    ...getAskModeConfig("codex"),
    cwd,
    title: "Permission Test",
  });

  const permissionRequestPromise = waitForSignal(60000, (resolve) => {
    const unsubscribe = ctx.client.on("agent_permission_request", (message) => {
      if (message.type !== "agent_permission_request") {
        return;
      }
      if (message.payload.agentId !== agent.id) {
        return;
      }
      resolve(message);
    });
    return unsubscribe;
  });

  const permissionResolvedPromise = waitForSignal(60000, (resolve) => {
    const unsubscribe = ctx.client.on("agent_permission_resolved", (message) => {
      if (message.type !== "agent_permission_resolved") {
        return;
      }
      if (message.payload.agentId !== agent.id) {
        return;
      }
      resolve(message);
    });
    return unsubscribe;
  });

  try {
    await ctx.client.sendMessage(
      agent.id,
      [
        'Use your shell tool to run: `printf "ok" > permission.txt`.',
        "This will require approval. Request permission and wait for approval before continuing.",
      ].join("\n"),
    );

    const permissionState = await ctx.client.waitForFinish(agent.id, 60000);
    expect(permissionState.status).toBe("permission");
    expect(permissionState.final?.pendingPermissions?.length).toBeGreaterThan(0);
    const permission = permissionState.final!.pendingPermissions[0];
    expect(permission).toBeTruthy();
    expect(permission.id).toBeTruthy();

    const permissionRequest = await permissionRequestPromise;
    expect(permissionRequest.payload.agentId).toBe(agent.id);

    await ctx.client.respondToPermission(agent.id, permission.id, {
      behavior: "allow",
    });

    const permissionResolved = await permissionResolvedPromise;
    expect(permissionResolved.payload.requestId).toBe(permission.id);

    const finalState = await ctx.client.waitForFinish(agent.id, 120000);
    expect(finalState.status).toBe("idle");
    expect(existsSync(filePath)).toBe(true);
  } finally {
    // Prevent unhandled rejections if the test fails before promises resolve.
    await permissionRequestPromise.catch(() => {});
    await permissionResolvedPromise.catch(() => {});
    await permissionEvents.release();
    await ctx.client.deleteAgent(agent.id);
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);

test("exposes raw session events for reachable screens", async () => {
  const cwd = tmpCwd();
  const agent = await ctx.client.createAgent({
    ...getFullAccessConfig("codex"),
    cwd,
    title: "Raw Events Test",
  });

  await ctx.client.sendMessage(agent.id, "Say 'hello' and nothing else");
  await ctx.client.waitForFinish(agent.id, 120000);

  const timeline = await ctx.client.fetchAgentTimeline(agent.id, {
    direction: "tail",
    limit: 0,
  });
  expect(timeline.entries.length).toBeGreaterThan(0);

  await ctx.client.deleteAgent(agent.id);
  rmSync(cwd, { recursive: true, force: true });
}, 120000);

speechTest(
  "does not process non-voice audio through the voice agent path",
  async () => {
    await ctx.client.setVoiceMode(false);

    let sawTranscriptLog = false;
    let sawAssistantChunk = false;
    let sawAssistantLog = false;

    const transcriptSeen = waitForSignal(60000, (resolve) => {
      const unsubscribeChunk = ctx.client.on("assistant_chunk", (message) => {
        if (message.type !== "assistant_chunk") {
          return;
        }
        if (message.payload.chunk.length > 0) {
          sawAssistantChunk = true;
        }
      });

      const unsubscribeActivity = ctx.client.on("activity_log", (message) => {
        if (message.type !== "activity_log") {
          return;
        }
        if (message.payload.type === "transcript") {
          sawTranscriptLog = true;
          resolve();
        }
        if (message.payload.type === "assistant") {
          sawAssistantLog = true;
        }
      });

      return () => {
        unsubscribeChunk();
        unsubscribeActivity();
      };
    });

    const wav = await readFixture("recording.wav");
    await ctx.client.sendVoiceAudioChunk(wav.toString("base64"), "audio/wav", true);
    await transcriptSeen;
    await new Promise((resolve) => setTimeout(resolve, 1500));

    expect(sawTranscriptLog).toBe(true);
    expect(sawAssistantChunk).toBe(false);
    expect(sawAssistantLog).toBe(false);
  },
  90000,
);

speechTest(
  "voice mode buffers audio until isLast and emits transcription_result",
  async () => {
    const voiceCwd = tmpCwd();
    const voiceAgent = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd: voiceCwd,
      },
    });
    await ctx.client.setVoiceMode(true, voiceAgent.id);

    const transcription = waitForSignal(30_000, (resolve) => {
      const unsubscribe = ctx.client.on("transcription_result", (message) => {
        if (message.type !== "transcription_result") {
          return;
        }
        resolve(message.payload);
      });
      return unsubscribe;
    });

    const errorSignal = waitForSignal(30_000, (resolve) => {
      const unsubscribeStatus = ctx.client.on("status", (message) => {
        if (message.type !== "status") {
          return;
        }
        if (message.payload.status !== "error") {
          return;
        }
        resolve(`status:error ${message.payload.message}`);
      });

      const unsubscribeLog = ctx.client.on("activity_log", (message) => {
        if (message.type !== "activity_log") {
          return;
        }
        if (message.payload.type !== "error") {
          return;
        }
        resolve(`activity_log:error ${message.payload.content}`);
      });

      return () => {
        unsubscribeStatus();
        unsubscribeLog();
      };
    });

    try {
      const wav = await readFixture("recording.wav");
      const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
      expect(sampleRate).toBe(16000);
      const format = "audio/pcm;rate=16000;bits=16";

      const earlyTranscription = waitForSignal(1000, (resolve) => {
        const unsubscribe = ctx.client.on("transcription_result", (message) => {
          if (message.type !== "transcription_result") {
            return;
          }
          resolve(message.payload.text);
        });
        return unsubscribe;
      });

      const chunkBytes = 3200; // 100ms @ 16kHz mono PCM16
      const firstChunk = pcm16.subarray(0, Math.min(chunkBytes, pcm16.length));
      await ctx.client.sendVoiceAudioChunk(firstChunk.toString("base64"), format, false);
      await earlyTranscription
        .then(() => {
          throw new Error("Expected no transcription_result before isLast=true");
        })
        .catch(() => {});

      for (let offset = chunkBytes; offset < pcm16.length; offset += chunkBytes) {
        const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
        const isLast = offset + chunkBytes >= pcm16.length;
        await ctx.client.sendVoiceAudioChunk(chunk.toString("base64"), format, isLast);
      }

      const outcome = await Promise.race([
        transcription.then((payload) => ({ kind: "ok" as const, payload })),
        errorSignal.then((error) => ({ kind: "error" as const, error })),
      ]);

      if (outcome.kind === "error") {
        throw new Error(outcome.error);
      }

      expect(typeof outcome.payload.text).toBe("string");
      if (outcome.payload.text.trim().length > 0) {
        expect(outcome.payload.text.toLowerCase()).toContain("voice note");
      } else {
        expect(outcome.payload.isLowConfidence).toBe(true);
      }
    } finally {
      await Promise.allSettled([transcription, errorSignal]);
      await ctx.client.setVoiceMode(false);
      rmSync(voiceCwd, { recursive: true, force: true });
    }
  },
  90_000,
);

speechTest(
  "streams dictation PCM and returns final transcript",
  async () => {
    const wav = await readFixture("recording.wav");
    const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
    expect(sampleRate).toBe(16000);
    const dictationId = `dict-${Date.now()}`;
    const format = "audio/pcm;rate=16000;bits=16";

    await ctx.client.startDictationStream(dictationId, format);

    const chunkBytes = 3200; // ~100ms @ 16kHz mono PCM16 (1600 samples * 2 bytes)
    let seq = 0;
    for (let offset = 0; offset < pcm16.length; offset += chunkBytes) {
      const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
      ctx.client.sendDictationStreamChunk(dictationId, seq, chunk.toString("base64"), format);
      seq += 1;
    }

    const finalSeq = seq - 1;
    const result = await ctx.client.finishDictationStream(dictationId, finalSeq);

    expect(result.dictationId).toBe(dictationId);
    expect(result.text.toLowerCase()).toContain("voice note");
  },
  30_000,
);

speechTest(
  "realtime dictation transcript is similar to baseline fixture",
  async () => {
    const wav = await readFixture("recording.wav");
    const { sampleRate, pcm16 } = parsePcm16MonoWav(wav);
    expect(sampleRate).toBe(16000);
    const dictationId = `dict-baseline-${Date.now()}`;
    const format = "audio/pcm;rate=16000;bits=16";

    const baseline = (await readFile(fixturePath("recording.baseline.txt"), "utf-8")).trim();

    await ctx.client.startDictationStream(dictationId, format);

    const chunkBytes = 3200; // 100ms @ 16kHz mono PCM16
    let seq = 0;
    for (let offset = 0; offset < pcm16.length; offset += chunkBytes) {
      const chunk = pcm16.subarray(offset, Math.min(pcm16.length, offset + chunkBytes));
      ctx.client.sendDictationStreamChunk(dictationId, seq, chunk.toString("base64"), format);
      seq += 1;
    }

    const finalSeq = seq - 1;
    const result = await ctx.client.finishDictationStream(dictationId, finalSeq);

    expect(result.dictationId).toBe(dictationId);
    expect(wordSimilarity(result.text, baseline)).toBeGreaterThan(0.6);
  },
  30_000,
);

speechTest(
  "fails fast if dictation finishes without sending required chunks",
  async () => {
    const dictationId = `dict-missing-chunks-${Date.now()}`;
    const format = "audio/pcm;rate=16000;bits=16";

    await ctx.client.startDictationStream(dictationId, format);

    // Claim that we sent chunk 0, but actually send no chunks.
    await expect(ctx.client.finishDictationStream(dictationId, 0)).rejects.toThrow(
      /no audio chunks were received/i,
    );
  },
  15_000,
);

test("supports git and file operations", async () => {
  const cwd = tmpCwd();

  execSync("git init -b main", { cwd, stdio: "pipe" });
  execSync("git config user.email 'test@test.com'", {
    cwd,
    stdio: "pipe",
  });
  execSync("git config user.name 'Test'", { cwd, stdio: "pipe" });

  const testFile = path.join(cwd, "test.txt");
  writeFileSync(testFile, "original content\n");
  execSync("git add test.txt", { cwd, stdio: "pipe" });
  execSync("git -c commit.gpgSign=false commit -m 'Initial commit'", {
    cwd,
    stdio: "pipe",
  });

  writeFileSync(testFile, "modified content\n");

  const downloadFile = path.join(cwd, "download.txt");
  const downloadContents = "download payload";
  writeFileSync(downloadFile, downloadContents, "utf-8");

  const agent = await ctx.client.createAgent({
    ...getFullAccessConfig("codex"),
    cwd,
    title: "Git/File Test",
  });

  // Test checkout status RPC
  const checkoutStatus = await ctx.client.getCheckoutStatus(cwd);
  expect(checkoutStatus.error).toBeNull();
  expect(checkoutStatus.isGit).toBe(true);
  expect(checkoutStatus.repoRoot).toContain(cwd);

  const diffResult = await ctx.client.getCheckoutDiff(cwd, { mode: "uncommitted" });
  expect(diffResult.error).toBeNull();
  expect(Array.isArray(diffResult.files)).toBe(true);
  expect(diffResult.files.length).toBeGreaterThan(0);
  expect(diffResult.files.some((file) => file.path === "test.txt")).toBe(true);

  const listRequestId = `list-${Date.now()}`;
  const listMessagePromise = waitForSignal(15000, (resolve) => {
    const unsubscribeList = ctx.client.on("file_explorer_response", (message) => {
      if (message.type !== "file_explorer_response") {
        return;
      }
      if (message.payload.cwd !== cwd) {
        return;
      }
      if (message.payload.mode !== "list") {
        return;
      }
      if (message.payload.requestId !== listRequestId) {
        return;
      }
      resolve(message);
    });
    return unsubscribeList;
  });

  const listResult = await ctx.client.listDirectory(cwd, ".", listRequestId);
  const listMessage = await listMessagePromise;
  expect(listResult.entries.some((entry) => entry.name === "download.txt")).toBe(true);
  expect(listMessage.payload.mode).toBe("list");
  expect(listMessage.payload.requestId).toBe(listRequestId);

  const fileRequestId = `file-${Date.now()}`;
  const fileMessagePromise = waitForSignal(15000, (resolve) => {
    const unsubscribeFile = ctx.client.on("file_explorer_response", (message) => {
      if (message.type !== "file_explorer_response") {
        return;
      }
      if (message.payload.cwd !== cwd) {
        return;
      }
      if (message.payload.mode !== "file") {
        return;
      }
      if (message.payload.requestId !== fileRequestId) {
        return;
      }
      resolve(message);
    });
    return unsubscribeFile;
  });

  const fileResult = await ctx.client.readFile(cwd, "download.txt", fileRequestId);
  const fileMessage = await fileMessagePromise;
  expect(new TextDecoder().decode(fileResult.bytes)).toBe(downloadContents);
  expect(fileMessage.payload.mode).toBe("file");
  expect(fileMessage.payload.requestId).toBe(fileRequestId);

  const tokenRequestId = `token-${Date.now()}`;
  const tokenMessagePromise = waitForSignal(15000, (resolve) => {
    const unsubscribeToken = ctx.client.on("file_download_token_response", (message) => {
      if (message.type !== "file_download_token_response") {
        return;
      }
      if (message.payload.cwd !== cwd) {
        return;
      }
      if (!message.payload.path.endsWith("download.txt")) {
        return;
      }
      if (message.payload.requestId !== tokenRequestId) {
        return;
      }
      resolve(message);
    });
    return unsubscribeToken;
  });

  const tokenResponse = await ctx.client.requestDownloadToken(cwd, "download.txt", tokenRequestId);
  const tokenMessage = await tokenMessagePromise;
  expect(tokenResponse.error).toBeNull();
  expect(tokenResponse.token).toBeTruthy();
  expect(tokenResponse.requestId).toBe(tokenRequestId);
  expect(tokenMessage.payload.cwd).toBe(cwd);
  expect(tokenMessage.payload.requestId).toBe(tokenRequestId);

  const response = await fetch(
    `http://127.0.0.1:${ctx.daemon.port}/api/files/download?token=${tokenResponse.token}`,
  );

  expect(response.status).toBe(200);
  const body = await response.text();
  expect(body).toBe(downloadContents);

  await ctx.client.deleteAgent(agent.id);
  rmSync(cwd, { recursive: true, force: true });
}, 120000);
