import { test, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
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
import { getFullAccessConfig, getAskModeConfig } from "./daemon-e2e/agent-configs.js";
import { parsePcm16MonoWav, wordSimilarity } from "./test-utils/dictation-e2e.js";
import type {
  AgentClient,
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
const appE2eFixturesDir = path.resolve(testFileDir, "../../../app/e2e/fixtures");

function fixturePath(fileName: string): string {
  return path.join(appE2eFixturesDir, fileName);
}

async function readFixture(fileName: string): Promise<Buffer> {
  return readFile(fixturePath(fileName));
}

function hasSherpaZipformerModels(modelsDir: string): boolean {
  return (
    existsSync(
      path.join(
        modelsDir,
        "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
        "encoder-epoch-99-avg-1.onnx",
      ),
    ) &&
    existsSync(
      path.join(
        modelsDir,
        "sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
        "tokens.txt",
      ),
    )
  );
}

function hasSherpaKittenModels(modelsDir: string): boolean {
  return (
    existsSync(path.join(modelsDir, "kitten-nano-en-v0_1-fp16", "model.fp16.onnx")) &&
    existsSync(path.join(modelsDir, "kitten-nano-en-v0_1-fp16", "voices.bin")) &&
    existsSync(path.join(modelsDir, "kitten-nano-en-v0_1-fp16", "tokens.txt"))
  );
}

const hasLocalSpeech =
  hasSherpaZipformerModels(localModelsDir) && hasSherpaKittenModels(localModelsDir);
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
  readonly id = null;
  readonly capabilities = {
    supportsStreaming: false,
    supportsSessionPersistence: true,
    supportsDynamicModes: false,
    supportsMcpServers: false,
    supportsReasoningStream: false,
    supportsToolInvocations: false,
  } as const;

  constructor(private readonly onClose: () => void) {}

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

  async listModels() {
    return [];
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
          dictationStt:
            process.env.PASEO_DICTATION_LOCAL_STT_MODEL ?? "zipformer-bilingual-zh-en-2023-02-20",
          voiceStt:
            process.env.PASEO_VOICE_LOCAL_STT_MODEL ?? "zipformer-bilingual-zh-en-2023-02-20",
          voiceTts: process.env.PASEO_VOICE_LOCAL_TTS_MODEL ?? "kitten-nano-en-v0_1-fp16",
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
    ...(openaiApiKey ? { openai: { apiKey: openaiApiKey } } : {}),
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

    const archivedResult = await ctx.client.fetchAgent(created.id);
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

    const refreshed = await ctx.client.fetchAgent(created.id);
    expect(refreshed).not.toBeNull();
    expect(refreshed?.agent.archivedAt).toBeNull();
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);

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

    const refreshed = await ctx.client.fetchAgent(created.id);
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

test("resume_agent auto-unarchives archived agents", async () => {
  const cwd = tmpCwd();
  try {
    const created = await ctx.client.createAgent({
      config: {
        ...getFullAccessConfig("codex"),
        cwd,
      },
    });
    const agentBeforeArchive = await ctx.client.fetchAgent(created.id);
    expect(agentBeforeArchive?.agent.persistence).toBeTruthy();
    await ctx.client.archiveAgent(created.id);

    const handle = agentBeforeArchive?.agent.persistence;
    if (!handle) {
      throw new Error("Expected persistence handle for resume test");
    }
    const resumed = await ctx.client.resumeAgent(handle);
    const resumedDetails = await ctx.client.fetchAgent(resumed.id);
    expect(resumedDetails).not.toBeNull();
    expect(resumedDetails?.agent.archivedAt).toBeNull();

    if (resumed.id !== created.id) {
      await ctx.client.deleteAgent(resumed.id);
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}, 180000);

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

    const archived = await ctx.client.fetchAgent(created.id);
    expect(archived).not.toBeNull();
    expect(archived?.agent.archivedAt).toBeTruthy();
    expect(archived?.agent.title).toBe("Pinned Title");
    expect(archived?.agent.labels).toMatchObject({ lane: "phase-1a" });

    await ctx.client.sendMessage(created.id, "Say hello and nothing else");
    const finalState = await ctx.client.waitForFinish(created.id, 120000);
    expect(finalState.status).toBe("idle");

    const unarchived = await ctx.client.fetchAgent(created.id);
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
  const outsideHomeDir = mkdtempSync(path.join(tmpdir(), "paseo-dir-suggestion-outside-"));

  try {
    const insideQuery = path.basename(insideHomeDir);
    const insideResult = await ctx.client.getDirectorySuggestions({
      query: insideQuery,
      limit: 25,
    });
    expect(insideResult.error).toBeNull();
    expect(insideResult.directories).toContain(insideHomeDir);

    const outsideQuery = path.basename(outsideHomeDir);
    const outsideResult = await ctx.client.getDirectorySuggestions({
      query: outsideQuery,
      limit: 25,
    });
    expect(outsideResult.error).toBeNull();
    expect(outsideResult.directories).not.toContain(outsideHomeDir);
  } finally {
    rmSync(insideHomeDir, { recursive: true, force: true });
    rmSync(outsideHomeDir, { recursive: true, force: true });
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

  await client.close();
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
    expect(voice?.dictation.reason).toBe("Dictation is disabled in daemon config.");
    expect(voice?.voice.enabled).toBe(false);
    expect(voice?.voice.reason).toBe("Realtime voice is disabled in daemon config.");
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
    subscribe: { subscriptionId: "daemon-client-lifecycle" },
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
  const createdStatusPromise = waitForSignal(15000, (resolve) => {
    const unsubscribe = ctx.client.on("status", (message) => {
      if (message.type !== "status") {
        return;
      }
      const payload = message.payload as {
        status?: string;
        agentId?: string;
        requestId?: string;
      };
      if (payload.status !== "agent_created") {
        return;
      }
      if (payload.requestId !== createRequestId) {
        return;
      }
      resolve(message);
    });
    return unsubscribe;
  });

  const agent = await ctx.client.createAgent({
    ...getFullAccessConfig("codex"),
    cwd,
    title: "Daemon Client V2",
    requestId: createRequestId,
  });

  expect(agent.id).toBeTruthy();
  expect(agent.status).toBe("idle");
  const fetchedResult = await ctx.client.fetchAgent(agent.id);
  expect(fetchedResult?.agent.id).toBe(agent.id);

  const agentUpdate = await agentUpdatePromise;
  expect(agentUpdate.payload.agent.id).toBe(agent.id);
  const createdStatus = await createdStatusPromise;
  expect((createdStatus.payload as { agentId?: string }).agentId).toBe(agent.id);

  const failRequestId = `fail-${Date.now()}`;
  const failedStatusPromise = waitForSignal(15000, (resolve) => {
    const unsubscribe = ctx.client.on("status", (message) => {
      if (message.type !== "status") {
        return;
      }
      const payload = message.payload as {
        status?: string;
        requestId?: string;
      };
      if (payload.status !== "agent_create_failed") {
        return;
      }
      if (payload.requestId !== failRequestId) {
        return;
      }
      resolve(message);
    });
    return unsubscribe;
  });

  await expect(
    ctx.client.createAgent({
      ...getFullAccessConfig("codex"),
      cwd: "/this/path/does/not/exist/12345",
      title: "Should Fail",
      requestId: failRequestId,
    }),
  ).rejects.toThrow("Working directory does not exist");
  await failedStatusPromise;

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
  const unsubscribeRawStream = ctx.client.on("agent_stream", (message) => {
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

  const commands = await ctx.client.listCommands(agent.id, commandsRequestId);
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
