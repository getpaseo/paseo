import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";

import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig, AgentStreamEvent } from "../../agent-sdk-types.js";
import { PaseoAgentClient, PaseoAgentSession } from "./agent.js";
import { PaseoAgentConfigSchema, type PaseoAgentConfig } from "./config.js";
import { storeOAuthCredential } from "./oauth-store.js";
import type { PaseoAgentSessionHandle } from "./pi-services.js";

function makeConfig(): PaseoAgentConfig {
  return PaseoAgentConfigSchema.parse({
    defaultModel: "openrouter-main/test-model",
    providers: {
      "openrouter-main": {
        type: "openrouter",
        options: {
          baseUrl: "https://openrouter.ai/api/v1",
          apiKey: "sk-test",
          api: "openai-completions",
          models: [{ id: "test-model", label: "Test Model" }],
        },
      },
    },
  });
}

function sessionConfig(overrides?: Partial<AgentSessionConfig>): AgentSessionConfig {
  return { provider: "paseo", cwd: process.cwd(), ...overrides };
}

function createRecordingLogger(): Logger & { warnings: Array<{ data: unknown; message: string }> } {
  const warnings: Array<{ data: unknown; message: string }> = [];
  const logger = {
    warnings,
    child: () => logger,
    debug: () => {},
    warn: (data: unknown, message: string) => {
      warnings.push({ data, message });
    },
    error: () => {},
    info: () => {},
  } as Logger & { warnings: Array<{ data: unknown; message: string }> };
  return logger;
}

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });
  return { promise, resolve, reject };
}

class FakeInProcessPiSession {
  readonly sessionId = "pi-session-1";
  readonly thinkingLevel = "medium";
  readonly model = { provider: "openrouter-main", id: "test-model" };
  readonly messages: Array<{ role: string; content: unknown }> = [];
  readonly agent = { state: { errorMessage: "" } };
  abortCalls = 0;
  disposeCalls = 0;
  promptCalls: Array<{ text: string; options: unknown }> = [];
  promptDeferred = deferred();
  private readonly subscribers = new Set<(event: AgentSessionEvent) => void>();

  subscribe(callback: (event: AgentSessionEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async prompt(text: string, options?: unknown): Promise<void> {
    this.promptCalls.push({ text, options });
    await this.promptDeferred.promise;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    const error = new Error("Request was aborted");
    error.name = "AbortError";
    this.promptDeferred.reject(error);
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  getSessionStats() {
    return {
      sessionFile: undefined,
      sessionId: this.sessionId,
      userMessages: 1,
      assistantMessages: 1,
      toolCalls: 0,
      toolResults: 0,
      totalMessages: 2,
      tokens: { input: 3, output: 5, cacheRead: 2, cacheWrite: 0, total: 10 },
      cost: 0.01,
      contextUsage: { contextWindow: 200000, tokens: 1234, percentage: 0.6 },
    };
  }

  setThinkingLevel(): void {}

  async setModel(): Promise<void> {}

  emit(event: AgentSessionEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}

function createPaseoProviderSession(): {
  fakePi: FakeInProcessPiSession;
  session: PaseoAgentSession;
  events: AgentStreamEvent[];
  mcpBridge: { closeCalls: number };
} {
  const fakePi = new FakeInProcessPiSession();
  const handle = {
    session: fakePi,
    modelRegistry: { find: () => fakePi.model },
    resourceLoader: {},
    sessionManager: {},
  } as unknown as PaseoAgentSessionHandle;
  const mcpBridge = {
    tools: [],
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
    },
  };
  const session = new PaseoAgentSession(
    handle,
    sessionConfig(),
    mcpBridge as unknown as ConstructorParameters<typeof PaseoAgentSession>[2],
    null,
    [],
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { fakePi, session, events, mcpBridge };
}

describe("PaseoAgentClient", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is available only when config has a usable model provider", async () => {
    const withConfig = new PaseoAgentClient({ logger: createTestLogger(), config: makeConfig() });
    expect(await withConfig.isAvailable()).toBe(true);

    const empty = new PaseoAgentClient({
      logger: createTestLogger(),
      config: PaseoAgentConfigSchema.parse({}),
    });
    expect(await empty.isAvailable()).toBe(false);
  });

  it("checks OAuth credentials in the configured Paseo home", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    const wrongHome = mkdtempSync(join(tmpdir(), "paseo-agent-wrong-home-"));
    tempDirs.push(paseoHome, wrongHome);
    const previousPaseoHome = process.env.PASEO_HOME;
    process.env.PASEO_HOME = wrongHome;
    storeOAuthCredential({
      providerInstance: "chatgpt",
      credential: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
      binding: { flow: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" },
      env: { PASEO_HOME: paseoHome },
    });
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        chatgpt: {
          type: "chatgpt",
        },
      },
    });

    try {
      const client = new PaseoAgentClient({ logger: createTestLogger(), config, paseoHome });
      expect(await client.isAvailable()).toBe(true);
    } finally {
      if (previousPaseoHome === undefined) {
        delete process.env.PASEO_HOME;
      } else {
        process.env.PASEO_HOME = previousPaseoHome;
      }
    }
  });

  it("does not treat an endpoint-mismatched OAuth credential as available", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    tempDirs.push(paseoHome);
    storeOAuthCredential({
      providerInstance: "chatgpt",
      credential: { type: "oauth", access: "access-token", refresh: "refresh-token", expires: 0 },
      binding: { flow: "openai-codex", baseUrl: "https://chatgpt.example.test/changed" },
      env: { PASEO_HOME: paseoHome },
    });
    const config = PaseoAgentConfigSchema.parse({
      providers: {
        chatgpt: {
          type: "chatgpt",
        },
      },
    });

    const client = new PaseoAgentClient({ logger: createTestLogger(), config, paseoHome });
    expect(await client.isAvailable()).toBe(false);
  });

  it("lists only configured models, never Pi disk/default models", async () => {
    const client = new PaseoAgentClient({ logger: createTestLogger(), config: makeConfig() });
    const { models } = await client.fetchCatalog({
      scope: "workspace",
      cwd: process.cwd(),
      force: false,
    });
    expect(models.map((m) => m.id)).toEqual(["openrouter-main/test-model"]);
    expect(models[0]?.isDefault).toBe(true);
  });

  it("throws when creating a session with no configured providers", async () => {
    const client = new PaseoAgentClient({
      logger: createTestLogger(),
      config: PaseoAgentConfigSchema.parse({}),
    });
    await expect(client.createSession(sessionConfig())).rejects.toThrow(/no configured/i);
  });

  it("creates an in-process session bound to the configured model", async () => {
    const client = new PaseoAgentClient({ logger: createTestLogger(), config: makeConfig() });
    const session = await client.createSession(sessionConfig());
    try {
      expect(session.provider).toBe("paseo");
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("openrouter-main/test-model");
      // In-memory prototype: no durable persistence handle.
      expect(session.describePersistence()).toBeNull();
    } finally {
      await session.close();
    }
  });

  it("honors an explicitly requested model over the default", async () => {
    const config = PaseoAgentConfigSchema.parse({
      defaultModel: "openrouter-main/a",
      providers: {
        "openrouter-main": {
          type: "openrouter",
          options: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [{ id: "a" }, { id: "b" }],
          },
        },
      },
    });
    const client = new PaseoAgentClient({ logger: createTestLogger(), config });
    const session = await client.createSession(sessionConfig({ model: "openrouter-main/b" }));
    try {
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("openrouter-main/b");
    } finally {
      await session.close();
    }
  });

  it("uses the selected agent as a model default", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    tempDirs.push(paseoHome);
    mkdirSync(join(paseoHome, "agents"), { recursive: true });
    writeFileSync(
      join(paseoHome, "agents", "orchestrator.md"),
      `---
model: openrouter-main/b
---
Profile prompt.
`,
    );
    const config = PaseoAgentConfigSchema.parse({
      defaultAgent: "orchestrator",
      providers: {
        "openrouter-main": {
          type: "openrouter",
          options: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [{ id: "a" }, { id: "b" }],
          },
        },
      },
    });
    const client = new PaseoAgentClient({ logger: createTestLogger(), config, paseoHome });
    const session = await client.createSession(sessionConfig());
    try {
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("openrouter-main/b");
    } finally {
      await session.close();
    }
  });

  it("prefers the selected agent model over the configured default model", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    tempDirs.push(paseoHome);
    mkdirSync(join(paseoHome, "agents"), { recursive: true });
    writeFileSync(
      join(paseoHome, "agents", "orchestrator.md"),
      `---
model: openrouter-main/b
---
Profile prompt.
`,
    );
    const config = PaseoAgentConfigSchema.parse({
      defaultAgent: "orchestrator",
      defaultModel: "openrouter-main/a",
      providers: {
        "openrouter-main": {
          type: "openrouter",
          options: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [{ id: "a" }, { id: "b" }],
          },
        },
      },
    });
    const client = new PaseoAgentClient({ logger: createTestLogger(), config, paseoHome });
    const session = await client.createSession(sessionConfig());
    try {
      const info = await session.getRuntimeInfo();
      expect(info.model).toBe("openrouter-main/b");
    } finally {
      await session.close();
    }
  });

  it("uses the requested mode as the selected agent definition", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    tempDirs.push(paseoHome);
    mkdirSync(join(paseoHome, "agents"), { recursive: true });
    writeFileSync(join(paseoHome, "agents", "builder.md"), "---\nname: Builder\n---\nBuild.");
    writeFileSync(
      join(paseoHome, "agents", "reviewer.md"),
      "---\nmodel: openrouter-main/b\n---\nReview.",
    );
    const config = PaseoAgentConfigSchema.parse({
      defaultAgent: "builder",
      providers: {
        "openrouter-main": {
          type: "openrouter",
          options: {
            baseUrl: "https://openrouter.ai/api/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [{ id: "a" }, { id: "b" }],
          },
        },
      },
    });
    const client = new PaseoAgentClient({ logger: createTestLogger(), config, paseoHome });

    const { modes } = await client.fetchCatalog({
      scope: "workspace",
      cwd: process.cwd(),
      force: false,
    });
    expect(modes).toEqual([
      { id: "builder", label: "Builder" },
      { id: "reviewer", label: "reviewer" },
    ]);

    const session = await client.createSession(sessionConfig({ modeId: "reviewer" }));
    try {
      const info = await session.getRuntimeInfo();
      expect(info.modeId).toBe("reviewer");
      expect(info.model).toBe("openrouter-main/b");
      await expect(session.getCurrentMode()).resolves.toBe("reviewer");
    } finally {
      await session.close();
    }
  });

  it("warns when the configured profile expects a missing MCP server", async () => {
    const paseoHome = mkdtempSync(join(tmpdir(), "paseo-agent-client-"));
    tempDirs.push(paseoHome);
    mkdirSync(join(paseoHome, "agents"), { recursive: true });
    writeFileSync(
      join(paseoHome, "agents", "orchestrator.md"),
      `---
mcp: [paseo, paseo]
---
Profile prompt.
`,
    );
    const logger = createRecordingLogger();
    const client = new PaseoAgentClient({
      logger,
      config: PaseoAgentConfigSchema.parse({ ...makeConfig(), defaultAgent: "orchestrator" }),
      paseoHome,
    });
    const session = await client.createSession(sessionConfig());
    try {
      expect(logger.warnings).toEqual([
        {
          data: expect.objectContaining({ mcpServer: "paseo" }),
          message: expect.stringMatching(/expects an MCP server/i),
        },
      ]);
    } finally {
      await session.close();
    }
  });
});

describe("PaseoAgentSession runtime events", () => {
  it("runs through a representative Pi event sequence", async () => {
    const { fakePi, session, events } = createPaseoProviderSession();
    const resultPromise = session.run("hello");

    await Promise.resolve();
    fakePi.emit({ type: "agent_start" });
    fakePi.emit({ type: "turn_start" });
    fakePi.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "thinking_delta", delta: "thinking" },
    });
    fakePi.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "pwd" },
    });
    fakePi.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { output: "/tmp" },
      isError: false,
    });
    fakePi.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "done" },
    });
    fakePi.emit({ type: "agent_end", messages: [], willRetry: false });
    fakePi.promptDeferred.resolve();

    await expect(resultPromise).resolves.toEqual({
      sessionId: "pi-session-1",
      finalText: "done",
      usage: {
        inputTokens: 3,
        cachedInputTokens: 2,
        outputTokens: 5,
        totalCostUsd: 0.01,
        contextWindowMaxTokens: 200000,
        contextWindowUsedTokens: 1234,
      },
      timeline: [
        {
          type: "user_message",
          text: "hello",
          messageId: expect.any(String),
        },
        { type: "reasoning", text: "thinking" },
        {
          type: "tool_call",
          callId: "tool-1",
          name: "bash",
          status: "running",
          detail: { type: "shell", command: "pwd", output: undefined, exitCode: undefined },
          error: null,
        },
        {
          type: "tool_call",
          callId: "tool-1",
          name: "bash",
          status: "completed",
          detail: { type: "shell", command: "pwd", output: "/tmp", exitCode: null },
          error: null,
        },
        { type: "assistant_message", text: "done" },
      ],
    });
    expect(events.map((event) => event.type)).toEqual([
      "timeline",
      "thread_started",
      "turn_started",
      "timeline",
      "timeline",
      "timeline",
      "timeline",
      "turn_completed",
    ]);
  });

  it("keeps the active turn open when Pi agent_end says it will retry", async () => {
    const { fakePi, session, events } = createPaseoProviderSession();
    const resultPromise = session.run("retry please");

    await Promise.resolve();
    fakePi.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "first attempt " },
    });
    fakePi.agent.state.errorMessage = "transient overflow";
    fakePi.emit({ type: "agent_end", messages: [], willRetry: true });
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
    expect(events.some((event) => event.type === "turn_completed")).toBe(false);

    fakePi.agent.state.errorMessage = "";
    fakePi.emit({
      type: "message_update",
      message: { role: "assistant", content: [] },
      assistantMessageEvent: { type: "text_delta", delta: "retry success" },
    });
    fakePi.emit({ type: "agent_end", messages: [], willRetry: false });
    fakePi.promptDeferred.resolve();

    await expect(resultPromise).resolves.toMatchObject({
      finalText: "first attempt retry success",
    });
    expect(events.filter((event) => event.type === "turn_completed")).toHaveLength(1);
  });

  it("maps interrupt aborts to clean turn cancellation", async () => {
    const { fakePi, session, events } = createPaseoProviderSession();
    const resultPromise = session.run("cancel me");

    await Promise.resolve();
    await session.interrupt();

    await expect(resultPromise).resolves.toMatchObject({
      sessionId: "pi-session-1",
      finalText: "",
      timeline: [
        {
          type: "user_message",
          text: "cancel me",
          messageId: expect.any(String),
        },
      ],
    });
    expect(fakePi.abortCalls).toBe(1);
    expect(events).toContainEqual({
      type: "turn_canceled",
      provider: "paseo",
      turnId: expect.any(String),
      reason: "interrupted",
    });
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
  });

  it("aborts an active turn before close and close is idempotent", async () => {
    const { fakePi, session, events, mcpBridge } = createPaseoProviderSession();
    await session.startTurn("close me");

    await Promise.all([session.close(), session.close()]);

    expect(fakePi.abortCalls).toBe(1);
    expect(fakePi.disposeCalls).toBe(1);
    expect(mcpBridge.closeCalls).toBe(1);
    expect(events).toContainEqual({
      type: "turn_canceled",
      provider: "paseo",
      turnId: expect.any(String),
      reason: "interrupted",
    });
    expect(events.some((event) => event.type === "turn_failed")).toBe(false);
  });
});
