import { describe, expect, test, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type {
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import {
  buildCodexAppServerEnv,
  CodexAppServerAgentClient,
  CodexAppServerAgentSession,
  codexAppServerTurnInputFromPrompt,
  listCodexSkills,
  mapCodexPatchNotificationToToolCall,
  mapCodexPlanToToolCall,
  normalizeCodexOutputSchema,
  toAgentUsage,
} from "./codex-app-server-agent.js";
import { CodexAppServerClient } from "./codex/app-server-transport.js";
import {
  createFakeCodexAppServer,
  type FakeCodexAppServer,
  waitForNextPermission,
} from "./codex/test-utils/fake-app-server.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals as castInternals, createStub } from "../../test-utils/class-mocks.js";
import { buildProviderRegistry } from "../provider-registry.js";

interface CollaborationModeRecord {
  name: string;
  mode?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  developer_instructions?: string | null;
}

interface CodexSessionTestAccess {
  ensureThreadLoaded(): Promise<void>;
  handleToolApprovalRequest(params: unknown): Promise<unknown>;
  handleNotification(method: string, params: unknown): void;
  loadPersistedHistory(): Promise<void>;
  refreshResolvedCollaborationMode(): void;
  serviceTier: "fast" | null;
  planModeEnabled: boolean;
  collaborationModes: CollaborationModeRecord[];
  config: AgentSessionConfig;
}

interface CodexClientLike {
  request: (method: string, ...rest: unknown[]) => Promise<unknown>;
}

type CodexTestSession = AgentSession & {
  connected: boolean;
  currentThreadId: string | null;
  activeForegroundTurnId: string | null;
  client: CodexClientLike | null;
};

const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+X1r0AAAAASUVORK5CYII=";
const CODEX_PROVIDER = "codex";

function createConfig(overrides: Partial<AgentSessionConfig> = {}): AgentSessionConfig {
  return {
    provider: CODEX_PROVIDER,
    cwd: "/tmp/codex-question-test",
    modeId: "auto",
    model: "gpt-5.4",
    ...overrides,
  };
}

function createSession(
  configOverrides: Partial<AgentSessionConfig> = {},
  options: { goalsEnabled?: boolean; autoReviewEnabled?: boolean } = {},
): CodexTestSession {
  const session = new CodexAppServerAgentSession(
    createConfig(configOverrides),
    null,
    createTestLogger(),
    () => {
      throw new Error("Test session cannot spawn Codex app-server");
    },
    {},
    false,
    options.goalsEnabled === true,
    options.autoReviewEnabled === true,
  ) as CodexTestSession;
  session.connected = true;
  session.currentThreadId = "test-thread";
  session.activeForegroundTurnId = "test-turn";
  return session;
}

function asInternals(session: CodexTestSession): CodexSessionTestAccess {
  return castInternals<CodexSessionTestAccess>(session);
}

function markdownImageSource(markdown: string): string {
  const match = markdown.match(/^!\[[^\]]*]\((.*)\)$/);
  if (!match) {
    throw new Error(`Expected markdown image, got: ${markdown}`);
  }
  return match[1].replace(/\\\)/g, ")");
}

function emitCodexUserMessage(
  appServer: FakeCodexAppServer,
  input: { id: string; text: string; threadId?: string },
): void {
  appServer.child.stdout.write(
    `${JSON.stringify({
      method: "item/started",
      params: {
        threadId: input.threadId ?? "thread-1",
        item: {
          type: "userMessage",
          id: input.id,
          content: [{ type: "text", text: input.text }],
        },
      },
    })}\n`,
  );
}

type CapturedFakeCodexRecord = Record<string, unknown>;

async function runCustomCodexProviderTurn(
  providerId: string,
  baseUrl: string,
): Promise<CapturedFakeCodexRecord[]> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-custom-provider-"));
  const fakeAppServerPath = path.join(tempDir, "fake-codex-app-server.cjs");
  const capturedRequestsPath = path.join(tempDir, "requests.jsonl");
  writeFileSync(
    fakeAppServerPath,
    `
const fs = require("node:fs");

const capturePath = process.env.PASEO_FAKE_CODEX_CAPTURE;
let buffer = "";

fs.appendFileSync(capturePath, JSON.stringify({
  kind: "env",
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
}) + "\\n");

function record(method, params) {
  fs.appendFileSync(capturePath, JSON.stringify({ kind: "request", method, params }) + "\\n");
}

function resultFor(method) {
  if (method === "initialize") return {};
  if (method === "collaborationMode/list") return { data: [] };
  if (method === "skills/list") return { data: [] };
  if (method === "config/read") return { config: {} };
  if (method === "getUserSavedConfig") return { config: {} };
  if (method === "model/list") return { data: [{ id: "custom-model", isDefault: true }] };
  if (method === "thread/start") return { thread: { id: "thread-1" } };
  if (method === "turn/start") return {};
  return {};
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const newlineIndex = buffer.indexOf("\\n");
    if (newlineIndex === -1) break;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    record(message.method, message.params);
    process.stdout.write(JSON.stringify({ id: message.id, result: resultFor(message.method) }) + "\\n");
  }
});
`,
  );

  const registry = buildProviderRegistry(createTestLogger(), {
    providerOverrides: {
      [providerId]: {
        extends: "codex",
        label: "Custom Codex",
        command: [process.execPath, fakeAppServerPath],
        env: {
          OPENAI_API_KEY: "sk-custom",
          OPENAI_BASE_URL: baseUrl,
          PASEO_FAKE_CODEX_CAPTURE: capturedRequestsPath,
        },
      },
    },
  });
  const session = await registry[providerId].createClient(createTestLogger()).createSession({
    provider: providerId,
    cwd: "/workspace/project",
    modeId: "auto",
    model: "custom-model",
  });

  try {
    await session.startTurn("use the custom endpoint");
    return readFileSync(capturedRequestsPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as CapturedFakeCodexRecord);
  } finally {
    await session.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function capturedThreadStartConfig(records: CapturedFakeCodexRecord[]): unknown {
  const threadStart = records.find((record) => record.method === "thread/start");
  const params = threadStart?.params as Record<string, unknown> | undefined;
  return params?.config;
}

async function listCommandsFromFakeCodex(skills: unknown[]): Promise<AgentSlashCommand[]> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-command-list-"));
  const fakeCodexPath = path.join(tempDir, "fake-codex.cjs");
  writeFileSync(
    fakeCodexPath,
    `
let buffer = "";

function resultFor(method) {
  if (method === "initialize") return {};
  if (method === "collaborationMode/list") return { data: [] };
  if (method === "skills/list") {
    return {
      data: [
        {
          cwd: "/tmp/codex-question-test",
          skills: ${JSON.stringify(skills)},
          errors: [],
        },
      ],
    };
  }
  throw new Error("Unexpected Codex request: " + method);
}

process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  for (;;) {
    const newlineIndex = buffer.indexOf("\\n");
    if (newlineIndex === -1) break;
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (typeof message.id !== "number") continue;
    try {
      process.stdout.write(JSON.stringify({ id: message.id, result: resultFor(message.method) }) + "\\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { message: error.message } }) + "\\n");
    }
  }
});
`,
  );

  const client = new CodexAppServerAgentClient(createTestLogger(), {
    command: { mode: "replace", argv: [process.execPath, fakeCodexPath] },
  });
  const session = await client.createSession(createConfig());
  try {
    return await session.listCommands();
  } finally {
    await session.close();
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe("Codex app-server provider", () => {
  test("getAvailableModes includes auto-review when the Codex version supports it", async () => {
    const session = createSession({}, { autoReviewEnabled: true });

    await expect(session.getAvailableModes()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "auto-review",
          label: "Auto-review",
        }),
      ]),
    );
  });

  test("getAvailableModes excludes auto-review when the Codex version is too old", async () => {
    const session = createSession({}, { autoReviewEnabled: false });

    await expect(session.getAvailableModes()).resolves.not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "auto-review" })]),
    );
  });

  test("setMode auto-review sends approvalsReviewer to thread/start", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const session = createSession(
      { modeId: "auto", thinkingOptionId: "medium" },
      { autoReviewEnabled: true },
    );
    session.currentThreadId = null;
    session.activeForegroundTurnId = null;
    session.client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/start") {
          return { thread: { id: "auto-review-thread" } };
        }
        if (method === "turn/start") {
          return {};
        }
        throw new Error(`Unexpected request: ${method}`);
      }),
    };

    await session.setMode("auto-review");
    await session.startTurn("trigger thread creation");

    const startCall = requests.find((req) => req.method === "thread/start");
    expect(startCall?.params).toMatchObject({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "auto_review",
    });
  });

  test.each(["auto_review", "guardian_subagent"])(
    "parses %s thread/start response as auto-review mode",
    async (approvalsReviewer) => {
      const session = createSession(
        { modeId: "auto", thinkingOptionId: "medium" },
        { autoReviewEnabled: true },
      );
      session.currentThreadId = null;
      session.activeForegroundTurnId = null;
      session.client = {
        request: vi.fn(async (method: string) => {
          if (method === "thread/start") {
            return {
              thread: { id: "auto-review-thread" },
              approvalPolicy: "on-request",
              sandbox: { type: "workspaceWrite", networkAccess: false },
              approvalsReviewer,
            };
          }
          if (method === "turn/start") {
            return {};
          }
          throw new Error(`Unexpected request: ${method}`);
        }),
      };

      await session.startTurn("trigger thread creation");

      await expect(session.getCurrentMode()).resolves.toBe("auto-review");
    },
  );

  test("turn/start forwards approvalsReviewer while in auto-review mode", async () => {
    const session = createSession({ modeId: "auto-review" }, { autoReviewEnabled: true });
    const request = vi.fn(async (method: string) => {
      if (method === "thread/loaded/list") {
        return { data: ["test-thread"] };
      }
      if (method === "turn/start") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });
    session.activeForegroundTurnId = null;
    session.client = createStub<CodexClientLike>({ request });

    await session.startTurn("needs approval");

    const turnStartCall = request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1]).toEqual(
      expect.objectContaining({
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
      }),
    );
  });

  test("passes ephemeral: true to thread/start when constructed as ephemeral", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const fakeClient: CodexClientLike = {
      async request(method: string, params?: unknown) {
        requests.push({ method, params });
        if (method === "thread/start") {
          return { thread: { id: "ephemeral-thread" } };
        }
        return null;
      },
    };

    const session = new CodexAppServerAgentSession(
      createConfig({ thinkingOptionId: "medium" }),
      null,
      createTestLogger(),
      () => {
        throw new Error("Test session cannot spawn Codex app-server");
      },
      {},
      true,
    );
    castInternals<{ client: CodexClientLike }>(session).client = fakeClient;

    await castInternals<{ ensureThread: () => Promise<void> }>(session).ensureThread();

    const startCall = requests.find((req) => req.method === "thread/start");
    expect(startCall).toBeDefined();
    expect(startCall?.params).toMatchObject({ ephemeral: true });
  });

  test("omits ephemeral from thread/start by default", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const fakeClient: CodexClientLike = {
      async request(method: string, params?: unknown) {
        requests.push({ method, params });
        if (method === "thread/start") {
          return { thread: { id: "persistent-thread" } };
        }
        return null;
      },
    };

    const session = new CodexAppServerAgentSession(
      createConfig({ thinkingOptionId: "medium" }),
      null,
      createTestLogger(),
      () => {
        throw new Error("Test session cannot spawn Codex app-server");
      },
    );
    castInternals<{ client: CodexClientLike }>(session).client = fakeClient;

    await castInternals<{ ensureThread: () => Promise<void> }>(session).ensureThread();

    const startCall = requests.find((req) => req.method === "thread/start");
    expect(startCall).toBeDefined();
    expect((startCall!.params as Record<string, unknown>).ephemeral).toBeUndefined();
  });

  test("disposes an unresponsive app-server child with SIGKILL", async () => {
    vi.useFakeTimers();
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    child.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
    child.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams["kill"];
    const client = new CodexAppServerClient(child, createTestLogger());

    try {
      const disposePromise = client.dispose();
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");

      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");

      await vi.advanceTimersByTimeAsync(1_000);
      await expect(disposePromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  test("round-trips server-initiated command approvals through the real app-server transport", async () => {
    const appServer = createFakeCodexAppServer({
      initialize: () => ({}),
      "collaborationMode/list": () => ({ data: [] }),
      "skills/list": () => ({ data: [] }),
    });
    const session = new CodexAppServerAgentSession(
      createConfig({ cwd: "/workspace/project" }),
      null,
      createTestLogger(),
      async () => appServer.child,
    );

    await session.connect();
    appServer.assertNoErrors();

    const permissionRequested = waitForNextPermission(session);
    appServer.requestCommandApproval({
      itemId: "exec-approval-1",
      threadId: "thread-1",
      turnId: "turn-1",
      command: "git restore README.md",
      cwd: "/workspace/project",
      reason: "requires escalated permissions",
    });

    const permissionEvent = await permissionRequested;
    expect(permissionEvent.request).toMatchObject({
      id: "permission-exec-approval-1",
      provider: "codex",
      name: "CodexBash",
      kind: "tool",
      title: "Run command: git restore README.md",
      description: "requires escalated permissions",
      input: {
        command: "git restore README.md",
        cwd: "/workspace/project",
      },
      metadata: {
        itemId: "exec-approval-1",
        threadId: "thread-1",
        turnId: "turn-1",
      },
    });

    await session.respondToPermission(permissionEvent.request.id, { behavior: "allow" });

    await expect(appServer.waitForCommandApprovalDecision("exec-approval-1")).resolves.toEqual({
      decision: "accept",
    });
    appServer.assertNoErrors();
    await session.close();
  });

  test("initializes Codex app-server without making Paseo the request originator", async () => {
    let initializeParams: unknown;
    const appServer = createFakeCodexAppServer({
      initialize: (params) => {
        initializeParams = params;
        return {};
      },
      "collaborationMode/list": () => ({ data: [] }),
      "skills/list": () => ({ data: [] }),
    });
    const session = new CodexAppServerAgentSession(
      createConfig({ cwd: "/workspace/project" }),
      null,
      createTestLogger(),
      async () => appServer.child,
    );

    await session.connect();

    expect(initializeParams).toEqual({
      clientInfo: {
        name: "codex_app_server_daemon",
        title: "Codex App Server Daemon",
        version: "0.0.0",
      },
      capabilities: { experimentalApi: true },
    });
    appServer.assertNoErrors();
    await session.close();
  });

  test("rewinds the conversation to a freshly emitted Codex user message id", async () => {
    const appServer = createFakeCodexAppServer();
    const session = new CodexAppServerAgentSession(
      createConfig({ cwd: "/workspace/project" }),
      null,
      createTestLogger(),
      async () => appServer.child,
    );

    await session.startTurn("remember first");
    emitCodexUserMessage(appServer, { id: "codex-first", text: "remember first" });
    appServer.completeTurn();
    await session.startTurn("remember second");
    emitCodexUserMessage(appServer, { id: "codex-second", text: "remember second" });
    appServer.completeTurn();

    await session.revertConversation({ messageId: "codex-first" });

    expect(appServer.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    await expect(session.getRuntimeInfo()).resolves.toMatchObject({
      sessionId: "forked-thread",
    });
    appServer.assertNoErrors();
    await session.close();
  });

  test("configures Codex app-server to use a custom provider base URL", async () => {
    const capturedRequests = await runCustomCodexProviderTurn(
      "codex-iisb",
      "https://custom-relay.example.com",
    );

    expect(capturedRequests[0]).toEqual({
      kind: "env",
      OPENAI_API_KEY: "sk-custom",
      OPENAI_BASE_URL: "https://custom-relay.example.com",
    });
    expect(capturedThreadStartConfig(capturedRequests)).toEqual({
      model_provider: "codex-iisb",
      model_providers: {
        "codex-iisb": {
          name: "Custom Codex",
          base_url: "https://custom-relay.example.com/v1",
          env_key: "OPENAI_API_KEY",
          requires_openai_auth: false,
          wire_api: "responses",
        },
      },
    });
  });

  test("does not append v1 twice for custom Codex provider base URLs", async () => {
    const capturedRequests = await runCustomCodexProviderTurn(
      "codex-custom",
      "https://custom-relay.example.com/v1/",
    );

    expect(capturedThreadStartConfig(capturedRequests)).toEqual({
      model_provider: "codex-custom",
      model_providers: {
        "codex-custom": expect.objectContaining({
          base_url: "https://custom-relay.example.com/v1",
        }),
      },
    });
  });

  test("resumeSession does not replace a persisted Codex thread when app-server resume fails", async () => {
    const threadRequests: string[] = [];
    const appServer = createFakeCodexAppServer({
      "thread/loaded/list": () => {
        threadRequests.push("thread/loaded/list");
        return { data: [] };
      },
      "thread/resume": () => {
        threadRequests.push("thread/resume");
        return Promise.reject(new Error("no tool-call found for thread id archived-thread-id"));
      },
      "thread/start": () => {
        threadRequests.push("thread/start");
        return { thread: { id: "replacement-empty-thread-id" } };
      },
      "thread/read": () => {
        threadRequests.push("thread/read");
        return { thread: { turns: [] } };
      },
      getUserSavedConfig: () => {
        threadRequests.push("getUserSavedConfig");
        return { config: {} };
      },
      "config/read": () => {
        threadRequests.push("config/read");
        return { config: {} };
      },
      "model/list": () => {
        threadRequests.push("model/list");
        return {
          data: [{ id: "gpt-5.4", isDefault: true, defaultReasoningEffort: "medium" }],
        };
      },
    });
    const provider = new CodexAppServerAgentClient(createTestLogger());
    castInternals<{ goalsEnabledPromise: Promise<boolean> | null }>(provider).goalsEnabledPromise =
      Promise.resolve(false);
    castInternals<{ spawnAppServer: () => Promise<ChildProcessWithoutNullStreams> }>(
      provider,
    ).spawnAppServer = async () => appServer.child;

    const outcome = await Promise.race([
      provider
        .resumeSession({
          sessionId: "archived-thread-id",
          metadata: {
            cwd: "/tmp/codex-question-test",
            modeId: "auto",
            model: "gpt-5.4",
          },
        })
        .then(
          () => "resolved" as const,
          (error) => {
            expect(error).toBeInstanceOf(Error);
            expect((error as Error).message).toContain(
              "no tool-call found for thread id archived-thread-id",
            );
            return "rejected" as const;
          },
        ),
      new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 500)),
    ]);

    if (outcome === "timed_out") {
      appServer.child.kill("SIGTERM");
      throw new Error(`resumeSession timed out; thread requests: ${threadRequests.join(", ")}`);
    }

    expect(threadRequests).toEqual(["thread/loaded/list", "thread/resume"]);
    expect(outcome).toBe("rejected");
    appServer.assertNoErrors();
  });

  test("lists repo skills using WorkspaceGitService repo-root resolution", async () => {
    const tempDir = await mkdtemp(path.join(tmpdir(), "codex-skills-"));
    const cwd = path.join(tempDir, "repo", "packages", "app");
    const repoSkillDir = path.join(tempDir, "repo", ".codex", "skills", "shipper");
    mkdirSync(cwd, { recursive: true });
    mkdirSync(repoSkillDir, { recursive: true });
    writeFileSync(
      path.join(repoSkillDir, "SKILL.md"),
      "---\nname: shipper\ndescription: Ship changes carefully.\n---\n",
    );
    const workspaceGitService = {
      resolveRepoRoot: vi.fn().mockResolvedValue(path.join(tempDir, "repo")),
    };

    try {
      await expect(listCodexSkills(cwd, workspaceGitService)).resolves.toContainEqual({
        name: "shipper",
        description: "Ship changes carefully.",
        argumentHint: "",
        kind: "skill",
      });
      expect(workspaceGitService.resolveRepoRoot).toHaveBeenCalledWith(cwd);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const logger = createTestLogger();

  test("extracts context window usage from snake_case token payloads", () => {
    expect(
      toAgentUsage({
        model_context_window: 200000,
        last: {
          total_tokens: 50000,
          inputTokens: 30000,
          cachedInputTokens: 5000,
          outputTokens: 15000,
        },
      }),
    ).toEqual({
      inputTokens: 30000,
      cachedInputTokens: 5000,
      outputTokens: 15000,
      contextWindowMaxTokens: 200000,
      contextWindowUsedTokens: 50000,
    });
  });

  test("extracts context window usage from camelCase token payloads", () => {
    expect(
      toAgentUsage({
        modelContextWindow: 200000,
        last: {
          totalTokens: 50000,
          inputTokens: 30000,
          cachedInputTokens: 5000,
          outputTokens: 15000,
        },
      }),
    ).toEqual({
      inputTokens: 30000,
      cachedInputTokens: 5000,
      outputTokens: 15000,
      contextWindowMaxTokens: 200000,
      contextWindowUsedTokens: 50000,
    });
  });

  test("keeps existing usage behavior when context window fields are missing", () => {
    expect(
      toAgentUsage({
        last: {
          inputTokens: 30000,
          cachedInputTokens: 5000,
          outputTokens: 15000,
        },
      }),
    ).toEqual({
      inputTokens: 30000,
      cachedInputTokens: 5000,
      outputTokens: 15000,
    });
  });

  test("excludes invalid context window values", () => {
    expect(
      toAgentUsage({
        model_context_window: Number.NaN,
        modelContextWindow: "200000",
        last: {
          total_tokens: Number.NaN,
          totalTokens: "50000",
          inputTokens: 30000,
          cachedInputTokens: 5000,
          outputTokens: 15000,
        },
      }),
    ).toEqual({
      inputTokens: 30000,
      cachedInputTokens: 5000,
      outputTokens: 15000,
    });
  });

  test("normalizes raw output schemas for Codex structured outputs", () => {
    const input = {
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string" },
              summary: { type: "string" },
            },
            required: ["severity"],
          },
        },
        overall: { type: "string" },
      },
      required: ["overall"],
    };

    const normalized = normalizeCodexOutputSchema(input);

    expect(normalized).toEqual({
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string" },
              summary: { type: "string" },
            },
            required: ["severity", "summary"],
            additionalProperties: false,
          },
        },
        overall: { type: "string" },
      },
      required: ["overall", "findings"],
      additionalProperties: false,
    });
    expect(input).toEqual({
      type: "object",
      properties: {
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              severity: { type: "string" },
              summary: { type: "string" },
            },
            required: ["severity"],
          },
        },
        overall: { type: "string" },
      },
      required: ["overall"],
    });
  });

  test("passes a normalized output schema to turn/start", async () => {
    const session = createSession();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/loaded/list") {
        return { data: ["test-thread"] };
      }
      if (method === "turn/start") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    session.activeForegroundTurnId = null;
    session.client = createStub<CodexClientLike>({ request });

    await session.startTurn("Return JSON", {
      outputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
        },
      },
    });

    const turnStartCall = request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1]).toEqual(
      expect.objectContaining({
        outputSchema: {
          type: "object",
          properties: {
            summary: { type: "string" },
          },
          required: ["summary"],
          additionalProperties: false,
        },
      }),
    );
  });

  test("resolves Codex skill slash commands into app-server skill input", async () => {
    const session = createSession();
    const request = vi.fn(async (method: string) => {
      if (method === "skills/list") {
        return {
          data: [
            {
              cwd: "/tmp/codex-question-test",
              skills: [
                {
                  name: "paseo-implement",
                  description: "Execute an existing Paseo plan.",
                  path: "/tmp/skills/paseo-implement/SKILL.md",
                },
              ],
              errors: [],
            },
          ],
        };
      }
      if (method === "thread/loaded/list") {
        return { data: ["test-thread"] };
      }
      if (method === "turn/start") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    session.activeForegroundTurnId = null;
    session.client = createStub<CodexClientLike>({ request });

    await session.startTurn("/paseo-implement in a worktree, remember to use Claude for the UI");

    const turnStartCall = request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1]).toEqual(
      expect.objectContaining({
        input: [
          {
            type: "skill",
            name: "paseo-implement",
            path: "/tmp/skills/paseo-implement/SKILL.md",
          },
          {
            type: "text",
            text: "$paseo-implement in a worktree, remember to use Claude for the UI",
            text_elements: [],
          },
        ],
      }),
    );
  });

  test("deduplicates Codex skill slash commands returned from multiple skill roots", async () => {
    const commands = await listCommandsFromFakeCodex([
      {
        name: "paseo",
        description: "Shared orchestration skill.",
        path: "/Users/test/.agents/skills/paseo/SKILL.md",
      },
      {
        name: "paseo",
        description: "Shared orchestration skill.",
        path: "/Users/test/.codex/skills/paseo/SKILL.md",
      },
    ]);

    expect(commands.filter((command) => command.name === "paseo")).toEqual([
      {
        name: "paseo",
        description: "Shared orchestration skill.",
        argumentHint: "",
        kind: "skill",
      },
    ]);
  });

  test("maps image prompt blocks to Codex localImage input", async () => {
    const input = await codexAppServerTurnInputFromPrompt(
      [
        { type: "text", text: "hello" },
        { type: "image", mimeType: "image/png", data: ONE_BY_ONE_PNG_BASE64 },
      ],
      logger,
    );
    const localImage = input.find((item) => (item as { type?: string })?.type === "localImage") as
      | { type: "localImage"; path?: string }
      | undefined;
    expect(localImage?.path).toBeTypeOf("string");
    if (localImage?.path) {
      expect(existsSync(localImage.path)).toBe(true);
      rmSync(localImage.path, { force: true });
    }
  });

  test("maps github_pr prompt attachments to Codex text input", async () => {
    const input = await codexAppServerTurnInputFromPrompt(
      [
        {
          type: "github_pr",
          mimeType: "application/github-pr",
          number: 123,
          title: "Fix race in worktree setup",
          url: "https://github.com/getpaseo/paseo/pull/123",
          body: "Review body",
          baseRefName: "main",
          headRefName: "fix/worktree-race",
        },
      ],
      logger,
    );

    expect(input).toEqual([
      {
        type: "text",
        text_elements: [],
        text: expect.stringContaining("GitHub PR #123: Fix race in worktree setup"),
      },
    ]);
  });

  test("passes Codex skill prompt blocks through to Codex app-server input", async () => {
    const input = await codexAppServerTurnInputFromPrompt(
      [
        { type: "skill", name: "fix-build", path: "/tmp/skills/fix-build/SKILL.md" },
        { type: "text", text: "keep this build moving" },
      ],
      logger,
    );

    expect(input).toEqual([
      { type: "skill", name: "fix-build", path: "/tmp/skills/fix-build/SKILL.md" },
      { type: "text", text: "keep this build moving", text_elements: [] },
    ]);
  });

  test("separates Codex text prompts from rendered attachment text", async () => {
    const input = await codexAppServerTurnInputFromPrompt(
      [
        { type: "text", text: "Please review this" },
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 456,
          title: "Attachment spacing",
          url: "https://github.com/getpaseo/paseo/issues/456",
        },
      ],
      logger,
    );

    expect(input).toEqual([
      { type: "text", text: "Please review this", text_elements: [] },
      {
        type: "text",
        text: expect.stringMatching(/^\n\nGitHub Issue #456: Attachment spacing/),
        text_elements: [],
      },
    ]);
  });

  test("does not prefix Codex attachment-only prompts with a blank line", async () => {
    const input = await codexAppServerTurnInputFromPrompt(
      [
        {
          type: "github_issue",
          mimeType: "application/github-issue",
          number: 456,
          title: "Attachment spacing",
          url: "https://github.com/getpaseo/paseo/issues/456",
        },
      ],
      logger,
    );

    expect(input).toEqual([
      {
        type: "text",
        text: expect.stringMatching(/^GitHub Issue #456: Attachment spacing/),
        text_elements: [],
      },
    ]);
  });

  test("maps patch notifications with array-style changes and alias diff keys", () => {
    const item = mapCodexPatchNotificationToToolCall({
      callId: "patch-array-alias",
      changes: [
        {
          path: "/tmp/repo/src/array-alias.ts",
          kind: "modify",
          unified_diff: "@@\n-old\n+new\n",
        },
      ],
      cwd: "/tmp/repo",
      running: false,
    });

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/array-alias.ts");
      expect(item.detail.unifiedDiff).toContain("-old");
      expect(item.detail.unifiedDiff).toContain("+new");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  test("maps Codex plan markdown to a synthetic plan tool call", () => {
    const item = mapCodexPlanToToolCall({
      callId: "plan-turn-1",
      text: "### Login Screen\n- Build layout\n- Add validation",
    });

    expect(item).toEqual({
      type: "tool_call",
      callId: "plan-turn-1",
      name: "plan",
      status: "completed",
      error: null,
      detail: {
        type: "plan",
        text: "### Login Screen\n- Build layout\n- Add validation",
      },
    });
  });

  test("maps patch notifications with object-style single change payloads", () => {
    const item = mapCodexPatchNotificationToToolCall({
      callId: "patch-object-single",
      changes: {
        path: "/tmp/repo/src/object-single.ts",
        kind: "modify",
        patch: "@@\n-before\n+after\n",
      },
      cwd: "/tmp/repo",
      running: false,
    });

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/object-single.ts");
      expect(item.detail.unifiedDiff).toContain("-before");
      expect(item.detail.unifiedDiff).toContain("+after");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  test("maps patch notifications with file_path aliases in array-style changes", () => {
    const item = mapCodexPatchNotificationToToolCall({
      callId: "patch-array-file-path",
      changes: [
        {
          file_path: "/tmp/repo/src/alias-path.ts",
          type: "modify",
          diff: "@@\n-before\n+after\n",
        },
      ],
      cwd: "/tmp/repo",
      running: false,
    });

    expect(item.detail.type).toBe("edit");
    if (item.detail.type === "edit") {
      expect(item.detail.filePath).toBe("src/alias-path.ts");
      expect(item.detail.unifiedDiff).toContain("-before");
      expect(item.detail.unifiedDiff).toContain("+after");
      expect(item.detail.newString).toBeUndefined();
    }
  });

  test("builds app-server env from launch-context env overrides", () => {
    const launchContext: AgentLaunchContext = {
      env: {
        PASEO_AGENT_ID: "00000000-0000-4000-8000-000000000301",
        PASEO_TEST_FLAG: "codex-launch-value",
      },
    };
    const env = buildCodexAppServerEnv(
      {
        env: {
          PASEO_AGENT_ID: "runtime-value",
          PASEO_TEST_FLAG: "runtime-test-value",
        },
      },
      launchContext.env,
    );

    expect(env.PASEO_AGENT_ID).toBe(launchContext.env?.PASEO_AGENT_ID);
    expect(env.PASEO_TEST_FLAG).toBe(launchContext.env?.PASEO_TEST_FLAG);
  });

  test("projects request_user_input into a question permission and running timeline tool call", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    void asInternals(session).handleToolApprovalRequest({
      itemId: "call-question-1",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: "favorite_drink",
          header: "Drink",
          question: "Which drink do you want?",
          options: [{ label: "Coffee", description: "Default" }, { label: "Tea" }],
        },
      ],
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "tool_call",
          callId: "call-question-1",
          name: "request_user_input",
          status: "running",
          error: null,
          detail: {
            type: "plain_text",
            text: "Drink: Which drink do you want?\nOptions: Coffee, Tea",
            icon: "brain",
          },
          metadata: {
            questions: [
              {
                id: "favorite_drink",
                header: "Drink",
                question: "Which drink do you want?",
                options: [{ label: "Coffee", description: "Default" }, { label: "Tea" }],
              },
            ],
          },
        },
      },
      {
        type: "permission_requested",
        provider: "codex",
        turnId: "test-turn",
        request: {
          id: "permission-call-question-1",
          provider: "codex",
          name: "request_user_input",
          kind: "question",
          title: "Question",
          detail: {
            type: "plain_text",
            text: "Drink: Which drink do you want?\nOptions: Coffee, Tea",
            icon: "brain",
          },
          input: {
            questions: [
              {
                id: "favorite_drink",
                header: "Drink",
                question: "Which drink do you want?",
                options: [{ label: "Coffee", description: "Default" }, { label: "Tea" }],
              },
            ],
          },
          metadata: {
            itemId: "call-question-1",
            threadId: "thread-1",
            turnId: "turn-1",
            questions: [
              {
                id: "favorite_drink",
                header: "Drink",
                question: "Which drink do you want?",
                options: [{ label: "Coffee", description: "Default" }, { label: "Tea" }],
              },
            ],
          },
        },
      },
    ]);
  });

  test("converts Codex collab agent notifications through the normal timeline path", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/started", {
      threadId: "test-thread",
      item: {
        type: "collabAgentToolCall",
        id: "call-sub-agent-normal-path",
        tool: "spawnAgent",
        status: "inProgress",
        prompt: "Inspect the stream path.",
        receiverThreadIds: [],
        agentsStates: {},
      },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "tool_call",
          callId: "call-sub-agent-normal-path",
          name: "Sub-agent",
          status: "running",
          error: null,
          detail: {
            type: "sub_agent",
            subAgentType: "Sub-agent",
            description: "Inspect the stream path.",
            log: "",
            actions: [],
          },
        },
      },
    ]);
  });

  test("folds child-thread Codex activity into the parent sub-agent tool call", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/completed", {
      threadId: "test-thread",
      item: {
        type: "collabAgentToolCall",
        id: "call-sub-agent-child-activity",
        tool: "spawnAgent",
        status: "completed",
        prompt: "Report findings.",
        receiverThreadIds: ["child-thread-1"],
        agentsStates: {
          "child-thread-1": { status: "pendingInit", message: null },
        },
      },
    });
    asInternals(session).handleNotification("item/agentMessage/delta", {
      threadId: "child-thread-1",
      itemId: "child-message-1",
      delta: "Found the path.",
    });
    asInternals(session).handleNotification("item/completed", {
      threadId: "child-thread-1",
      item: {
        type: "agentMessage",
        id: "child-message-1",
        text: "Found the path.",
      },
    });
    asInternals(session).handleNotification("turn/completed", {
      threadId: "child-thread-1",
      turn: { status: "completed" },
    });

    const timelineEvents = events.filter((event) => event.type === "timeline");
    expect(timelineEvents).toHaveLength(4);
    expect(timelineEvents.every((event) => event.item.type === "tool_call")).toBe(true);
    const finalItem = timelineEvents.at(-1)?.item;
    expect(finalItem).toMatchObject({
      type: "tool_call",
      callId: "call-sub-agent-child-activity",
      name: "Sub-agent",
      status: "completed",
      detail: {
        type: "sub_agent",
        subAgentType: "Sub-agent",
        description: "Report findings.",
        log: "[Assistant] Found the path.",
        actions: [],
      },
    });
  });

  test("keeps the parent sub-agent running when a child command fails during the child turn", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/completed", {
      threadId: "test-thread",
      item: {
        type: "collabAgentToolCall",
        id: "call-sub-agent-child-command-failure",
        tool: "spawnAgent",
        status: "completed",
        prompt: "Fix the regression test-first.",
        receiverThreadIds: ["child-thread-1"],
        agentsStates: {
          "child-thread-1": { status: "running", message: null },
        },
      },
    });
    asInternals(session).handleNotification("item/completed", {
      threadId: "child-thread-1",
      item: {
        type: "commandExecution",
        id: "child-failing-command",
        status: "failed",
        command: "npx vitest run packages/server/src/server/agent/providers/opencode-agent.test.ts",
        aggregatedOutput: "expected false to be true",
        exitCode: 1,
        error: { message: "Command failed" },
      },
    });

    expect(events.at(-1)?.item).toMatchObject({
      type: "tool_call",
      callId: "call-sub-agent-child-command-failure",
      name: "Sub-agent",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Sub-agent",
        description: "Fix the regression test-first.",
      },
    });
  });

  test("does not synthesize a parent sub-agent failure from child error state alone", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/completed", {
      threadId: "test-thread",
      item: {
        type: "collabAgentToolCall",
        id: "call-sub-agent-transient-child-error",
        tool: "spawnAgent",
        status: "completed",
        prompt: "Validate the child agent result.",
        receiverThreadIds: ["child-thread-1"],
        agentsStates: {
          "child-thread-1": { status: "error", message: "Sub-agent failed" },
        },
      },
    });

    expect(events.at(-1)?.item).toMatchObject({
      type: "tool_call",
      callId: "call-sub-agent-transient-child-error",
      name: "Sub-agent",
      status: "running",
      error: null,
      detail: {
        type: "sub_agent",
        subAgentType: "Sub-agent",
        description: "Validate the child agent result.",
      },
    });
  });

  test("loads Codex persisted history from the app-server thread", async () => {
    const session = createSession();
    const requests: Array<{ method: string; params: unknown }> = [];
    session.client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method !== "thread/read") {
          return {};
        }
        return {
          thread: {
            turns: [
              {
                items: [
                  {
                    type: "agentMessage",
                    id: "message-history",
                    text: "History loaded.",
                    timestamp: "2026-05-01T10:00:00.000Z",
                  },
                  {
                    type: "contextCompaction",
                    id: "compact-history",
                    createdAt: "2026-05-01T10:00:01.000Z",
                  },
                ],
              },
            ],
          },
        };
      }),
    };

    await asInternals(session).loadPersistedHistory();

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }

    expect(requests.map((request) => [request.method, request.params])).toEqual([
      ["thread/read", { threadId: "test-thread", includeTurns: true }],
    ]);
    expect(history).toEqual([
      {
        type: "timeline",
        provider: "codex",
        timestamp: "2026-05-01T10:00:00.000Z",
        item: {
          type: "assistant_message",
          text: "History loaded.",
          messageId: "message-history",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        timestamp: "2026-05-01T10:00:01.000Z",
        item: {
          type: "compaction",
          status: "completed",
        },
      },
    ]);
  });

  test("uses Codex turn timestamps for timestamp-less persisted history items", async () => {
    const session = createSession();
    session.client = {
      request: vi.fn(async (method: string) => {
        if (method !== "thread/read") {
          return {};
        }
        return {
          thread: {
            turns: [
              {
                startedAt: 1_778_832_941,
                completedAt: 1_778_833_094,
                items: [
                  {
                    type: "userMessage",
                    id: "user-history",
                    content: [{ type: "text", text: "Check OpenCode timestamps." }],
                  },
                  {
                    type: "agentMessage",
                    id: "message-history",
                    text: "History loaded.",
                  },
                ],
              },
            ],
          },
        };
      }),
    };

    await asInternals(session).loadPersistedHistory();

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }

    expect(history).toEqual([
      {
        type: "timeline",
        provider: "codex",
        timestamp: "2026-05-15T08:15:41.000Z",
        item: {
          type: "user_message",
          text: "Check OpenCode timestamps.",
          messageId: "user-history",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        timestamp: "2026-05-15T08:18:14.000Z",
        item: {
          type: "assistant_message",
          text: "History loaded.",
          messageId: "message-history",
        },
      },
    ]);
  });

  test("preserves Codex app-server assistant item ids in persisted history", async () => {
    const session = createSession();
    session.client = {
      request: vi.fn(async (method: string) => {
        if (method !== "thread/read") {
          return {};
        }
        return {
          thread: {
            turns: [
              {
                items: [
                  {
                    type: "agentMessage",
                    id: "before-tool-message",
                    text: "I checked the workspace.",
                  },
                  {
                    type: "agentMessage",
                    id: "after-tool-message",
                    text: "The tests are green.",
                  },
                ],
              },
            ],
          },
        };
      }),
    };

    await asInternals(session).loadPersistedHistory();

    const history: AgentStreamEvent[] = [];
    for await (const event of session.streamHistory()) {
      history.push(event);
    }

    expect(history).toEqual([
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text: "I checked the workspace.",
          messageId: "before-tool-message",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text: "The tests are green.",
          messageId: "after-tool-message",
        },
      },
    ]);
  });

  test("captures live Codex user message ids from item events", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const userMessageItem = {
      type: "userMessage",
      id: "codex-user-live-1",
      content: [{ type: "text", text: "Use the native Codex id." }],
    };

    asInternals(session).handleNotification("item/started", {
      threadId: "test-thread",
      item: userMessageItem,
    });
    asInternals(session).handleNotification("item/completed", {
      threadId: "test-thread",
      item: userMessageItem,
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "user_message",
          text: "Use the native Codex id.",
          messageId: "codex-user-live-1",
        },
      },
    ]);
  });

  test("emits Codex context compaction markers from live thread items", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/started", {
      threadId: "test-thread",
      item: {
        type: "contextCompaction",
        id: "compact-live",
      },
    });
    asInternals(session).handleNotification("item/completed", {
      threadId: "test-thread",
      item: {
        type: "contextCompaction",
        id: "compact-live",
      },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "compaction",
          status: "loading",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "compaction",
          status: "completed",
        },
      },
    ]);
  });

  test("emits and dedupes Codex thread/compacted notifications", () => {
    const session = createSession();
    session.activeForegroundTurnId = null;
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("thread/compacted", {
      threadId: "test-thread",
      turnId: "legacy-compact-turn",
    });
    asInternals(session).handleNotification("item/completed", {
      threadId: "test-thread",
      item: {
        type: "contextCompaction",
        id: "legacy-compact-item",
      },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "legacy-compact-turn",
        item: {
          type: "compaction",
          status: "completed",
        },
      },
    ]);
  });

  test("emits consecutive Codex thread/compacted notifications", () => {
    const session = createSession();
    session.activeForegroundTurnId = null;
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("thread/compacted", {
      threadId: "test-thread",
      turnId: "legacy-compact-turn-1",
    });
    asInternals(session).handleNotification("thread/compacted", {
      threadId: "test-thread",
      turnId: "legacy-compact-turn-2",
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "legacy-compact-turn-1",
        item: {
          type: "compaction",
          status: "completed",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "legacy-compact-turn-2",
        item: {
          type: "compaction",
          status: "completed",
        },
      },
    ]);
  });

  test("does not replace a persisted Codex thread when app-server resume fails", async () => {
    const session = createSession({ thinkingOptionId: "medium" });
    session.currentThreadId = "archived-thread-id";
    const requests: Array<{ method: string; params: unknown }> = [];
    session.client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/loaded/list") {
          return { data: [] };
        }
        if (method === "thread/resume") {
          throw new Error("no tool-call found for thread id archived-thread-id");
        }
        if (method === "thread/start") {
          return { thread: { id: "replacement-empty-thread-id" } };
        }
        return {};
      }),
    };

    await expect(asInternals(session).ensureThreadLoaded()).rejects.toThrow(
      "no tool-call found for thread id archived-thread-id",
    );

    expect(session.currentThreadId).toBe("archived-thread-id");
    expect(requests).toEqual([
      { method: "thread/loaded/list", params: {} },
      { method: "thread/resume", params: { threadId: "archived-thread-id" } },
    ]);
  });

  test("appends blank-line spacing to /goal status messages", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const session = createSession({}, { goalsEnabled: true });
    session.client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/loaded/list") {
          return { data: ["test-thread"] };
        }
        return {};
      }),
    };

    const handler = session.tryHandleOutOfBand?.("/goal ship feature");
    expect(handler).not.toBeNull();

    const events: AgentStreamEvent[] = [];
    await handler?.run({ emit: (event) => events.push(event) });

    expect(requests).toContainEqual({
      method: "thread/goal/set",
      params: {
        threadId: "test-thread",
        objective: "ship feature",
        status: "active",
      },
    });
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        item: {
          type: "assistant_message",
          text: "Goal set: ship feature\n\n",
        },
      },
    ]);
  });

  test("lists /compact and sends Codex compaction out of band", async () => {
    const requests: Array<{ method: string; params: unknown }> = [];
    const session = createSession();
    session.client = {
      request: vi.fn(async (method: string, params: unknown) => {
        requests.push({ method, params });
        if (method === "thread/loaded/list") {
          return { data: ["test-thread"] };
        }
        if (method === "skills/list") {
          return { data: [] };
        }
        return {};
      }),
    };

    await expect(session.listCommands?.()).resolves.toContainEqual({
      name: "compact",
      description: "Summarize conversation to prevent hitting the context limit",
      argumentHint: "",
      kind: "command",
    });

    const handler = session.tryHandleOutOfBand?.("/compact");
    expect(handler).not.toBeNull();

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));
    await handler?.run({ emit: (event) => events.push(event) });
    asInternals(session).handleNotification("item/started", {
      threadId: "test-thread",
      item: {
        type: "contextCompaction",
        id: "manual-compact",
      },
    });
    asInternals(session).handleNotification("item/completed", {
      threadId: "test-thread",
      item: {
        type: "contextCompaction",
        id: "manual-compact",
      },
    });

    expect(requests).toContainEqual({
      method: "thread/compact/start",
      params: { threadId: "test-thread" },
    });
    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "compaction",
          status: "loading",
          trigger: "manual",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "compaction",
          status: "completed",
          trigger: "manual",
        },
      },
    ]);
  });

  test("maps question responses from headers back to question ids and completes the tool call", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const pendingResponse = asInternals(session).handleToolApprovalRequest({
      itemId: "call-question-2",
      threadId: "thread-1",
      turnId: "turn-1",
      questions: [
        {
          id: "favorite_drink",
          header: "Drink",
          question: "Which drink do you want?",
          options: [{ label: "Coffee" }, { label: "Tea" }],
        },
      ],
    });

    await session.respondToPermission("permission-call-question-2", {
      behavior: "allow",
      updatedInput: {
        answers: {
          Drink: "Tea",
        },
      },
    });

    await expect(pendingResponse).resolves.toEqual({
      answers: {
        favorite_drink: { answers: ["Tea"] },
      },
    });
    expect(events.at(-2)).toEqual({
      type: "permission_resolved",
      provider: "codex",
      turnId: "test-turn",
      requestId: "permission-call-question-2",
      resolution: {
        behavior: "allow",
        updatedInput: {
          answers: {
            Drink: "Tea",
          },
        },
      },
    });
    expect(events.at(-1)).toEqual({
      type: "timeline",
      provider: "codex",
      turnId: "test-turn",
      item: {
        type: "tool_call",
        callId: "call-question-2",
        name: "request_user_input",
        status: "completed",
        error: null,
        detail: {
          type: "plain_text",
          text: "Drink: Which drink do you want?\nOptions: Coffee, Tea\n\nAnswers:\n\nfavorite_drink: Tea",
          icon: "brain",
        },
        metadata: {
          questions: [
            {
              id: "favorite_drink",
              header: "Drink",
              question: "Which drink do you want?",
              options: [{ label: "Coffee" }, { label: "Tea" }],
            },
          ],
          answers: {
            favorite_drink: ["Tea"],
          },
        },
      },
    });
  });

  test("emits a synthetic plan approval permission after a successful Codex plan turn", () => {
    const session = createSession({
      featureValues: { plan_mode: true, fast_mode: true },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("turn/started", {
      turn: { id: "turn-plan-1" },
    });
    asInternals(session).handleNotification("turn/plan/updated", {
      plan: [
        { step: "Inspect the existing auth flow", status: "completed" },
        { step: "Implement the button behavior", status: "pending" },
      ],
    });
    asInternals(session).handleNotification("turn/completed", {
      turn: { status: "completed", error: null },
    });

    expect(
      events.some(
        (event) =>
          event.type === "timeline" &&
          event.item.type === "tool_call" &&
          event.item.detail.type === "plan",
      ),
    ).toBe(false);
    expect(events.at(-2)).toEqual({
      type: "permission_requested",
      provider: "codex",
      turnId: "test-turn",
      request: expect.objectContaining({
        provider: "codex",
        name: "CodexPlanApproval",
        kind: "plan",
        title: "Plan",
        input: {
          plan: "- Inspect the existing auth flow\n- Implement the button behavior",
        },
        actions: [
          expect.objectContaining({
            id: "reject",
            label: "Reject",
            behavior: "deny",
          }),
          expect.objectContaining({
            id: "implement",
            label: "Implement",
            behavior: "allow",
          }),
        ],
      }),
    });
    expect(events.at(-1)).toEqual({
      type: "turn_completed",
      provider: "codex",
      turnId: "test-turn",
      usage: undefined,
    });
  });

  test("does not emit Codex plan thread items as timeline cards while plan approval is pending", () => {
    const session = createSession({
      featureValues: { plan_mode: true, fast_mode: true },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("turn/started", {
      turn: { id: "turn-plan-thread-item" },
    });
    asInternals(session).handleNotification("item/completed", {
      item: {
        id: "plan-item-1",
        type: "plan",
        text: "- Inspect README\n- Add a short note",
      },
    });
    asInternals(session).handleNotification("turn/completed", {
      turn: { status: "completed", error: null },
    });

    expect(events).not.toContainEqual(
      expect.objectContaining({
        type: "timeline",
        item: expect.objectContaining({
          type: "tool_call",
          detail: expect.objectContaining({ type: "plan" }),
        }),
      }),
    );
    expect(events.at(-2)).toEqual({
      type: "permission_requested",
      provider: "codex",
      turnId: "test-turn",
      request: expect.objectContaining({
        provider: "codex",
        name: "CodexPlanApproval",
        kind: "plan",
        input: {
          plan: "- Inspect README\n- Add a short note",
        },
      }),
    });
  });

  test("emits imageView thread items as assistant markdown images using the path", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/completed", {
      item: {
        id: "image-view-1",
        type: "imageView",
        path: "/tmp/paseo image.png",
      },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "assistant_message",
          text: "![Image](/tmp/paseo image.png)",
        },
      },
    ]);
  });

  test.each([
    ["savedPath", { savedPath: "/tmp/generated-camel.png" }, "/tmp/generated-camel.png"],
    ["saved_path", { saved_path: "/tmp/generated-snake.png" }, "/tmp/generated-snake.png"],
  ])(
    "emits imageGeneration thread items with %s as assistant markdown images",
    (_fieldName, imageFields, expectedPath) => {
      const session = createSession();
      const events: AgentStreamEvent[] = [];
      session.subscribe((event) => events.push(event));

      asInternals(session).handleNotification("item/completed", {
        item: {
          id: `image-generation-${_fieldName}`,
          type: "imageGeneration",
          status: "completed",
          ...imageFields,
        },
      });

      expect(events).toEqual([
        {
          type: "timeline",
          provider: "codex",
          turnId: "test-turn",
          item: {
            type: "assistant_message",
            text: `![Image](${expectedPath})`,
          },
        },
      ]);
    },
  );

  test("materializes imageGeneration base64 results before rendering markdown", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/completed", {
      item: {
        id: "image-generation-base64",
        type: "imageGeneration",
        status: "completed",
        result: `data:image/png;base64,${ONE_BY_ONE_PNG_BASE64}`,
      },
    });

    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toMatchObject({
      type: "timeline",
      provider: "codex",
      turnId: "test-turn",
      item: { type: "assistant_message" },
    });
    if (event?.type !== "timeline" || event.item.type !== "assistant_message") {
      throw new Error("Expected assistant timeline event");
    }
    expect(event.item.text).not.toContain("data:image");
    expect(event.item.text).not.toContain(ONE_BY_ONE_PNG_BASE64);
    const source = markdownImageSource(event.item.text);
    expect(source).toMatch(/paseo-attachments[\\/].+\.png$/);
    expect(existsSync(source)).toBe(true);
    rmSync(source, { force: true });
  });

  test("ignores incomplete imageGeneration thread items without failing the turn", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    expect(() =>
      asInternals(session).handleNotification("item/completed", {
        item: {
          id: "image-generation-incomplete",
          type: "imageGeneration",
          status: "in_progress",
        },
      }),
    ).not.toThrow();
    asInternals(session).handleNotification("turn/completed", {
      turn: { status: "completed", error: null },
    });

    expect(events).toEqual([
      {
        type: "turn_completed",
        provider: "codex",
        turnId: "test-turn",
        usage: undefined,
      },
    ]);
  });

  test("emits usage_updated on token usage updates and keeps usage on turn completion", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("thread/tokenUsage/updated", {
      tokenUsage: {
        model_context_window: 200000,
        last: {
          total_tokens: 50000,
          inputTokens: 30000,
          cachedInputTokens: 5000,
          outputTokens: 15000,
        },
      },
    });
    asInternals(session).handleNotification("turn/completed", {
      turn: { status: "completed", error: null },
    });

    expect(events).toContainEqual({
      type: "usage_updated",
      provider: "codex",
      turnId: "test-turn",
      usage: {
        inputTokens: 30000,
        cachedInputTokens: 5000,
        outputTokens: 15000,
        contextWindowMaxTokens: 200000,
        contextWindowUsedTokens: 50000,
      },
    });
    expect(events.at(-1)).toEqual({
      type: "turn_completed",
      provider: "codex",
      turnId: "test-turn",
      usage: {
        inputTokens: 30000,
        cachedInputTokens: 5000,
        outputTokens: 15000,
        contextWindowMaxTokens: 200000,
        contextWindowUsedTokens: 50000,
      },
    });
  });

  test("streams Codex assistant message deltas and does not replay completed text", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/agentMessage/delta", {
      itemId: "assistant-item-1",
      delta: "Hel",
    });
    asInternals(session).handleNotification("item/agentMessage/delta", {
      itemId: "assistant-item-1",
      delta: "lo",
    });
    asInternals(session).handleNotification("item/completed", {
      item: {
        id: "assistant-item-1",
        type: "agentMessage",
        text: "Hello",
      },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "assistant_message", text: "Hel", messageId: "assistant-item-1" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "assistant_message", text: "lo", messageId: "assistant-item-1" },
      },
    ]);
  });

  test("emits only the missing assistant suffix when completed text extends streamed deltas", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/agentMessage/delta", {
      itemId: "assistant-item-2",
      delta: "Hel",
    });
    asInternals(session).handleNotification("item/agentMessage/delta", {
      itemId: "assistant-item-2",
      delta: "lo",
    });
    asInternals(session).handleNotification("item/completed", {
      item: {
        id: "assistant-item-2",
        type: "agentMessage",
        text: "Hello!",
      },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "assistant_message", text: "Hel", messageId: "assistant-item-2" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "assistant_message", text: "lo", messageId: "assistant-item-2" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "assistant_message", text: "!", messageId: "assistant-item-2" },
      },
    ]);
  });

  test("emits a markdown divider when a new Codex assistant item starts after the previous one completed", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/agentMessage/delta", {
      itemId: "assistant-item-3",
      delta:
        "I’m in the waiting phase now. The next read is intentionally delayed so we get meaningful CI state instead of churn.",
    });
    asInternals(session).handleNotification("item/completed", {
      item: {
        id: "assistant-item-3",
        type: "agentMessage",
        text: "I’m in the waiting phase now. The next read is intentionally delayed so we get meaningful CI state instead of churn.",
      },
    });
    asInternals(session).handleNotification("item/agentMessage/delta", {
      itemId: "assistant-item-4",
      delta:
        "CI is still cooking. I’m staying on the current run rather than jumping around, because the first red job will tell us exactly whether anything else needs work.",
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "assistant_message",
          messageId: "assistant-item-3",
          text: "I’m in the waiting phase now. The next read is intentionally delayed so we get meaningful CI state instead of churn.",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "assistant_message",
          messageId: "assistant-item-4",
          text: "\n\n---\n\nCI is still cooking. I’m staying on the current run rather than jumping around, because the first red job will tell us exactly whether anything else needs work.",
        },
      },
    ]);
  });

  test("streams Codex reasoning deltas and does not replay completed reasoning", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/reasoning/summaryTextDelta", {
      itemId: "reasoning-item-1",
      delta: "Think",
    });
    asInternals(session).handleNotification("item/reasoning/summaryTextDelta", {
      itemId: "reasoning-item-1",
      delta: "ing",
    });
    asInternals(session).handleNotification("item/completed", {
      item: {
        id: "reasoning-item-1",
        type: "reasoning",
        summary: ["Thinking"],
      },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "reasoning", text: "Think" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "reasoning", text: "ing" },
      },
    ]);
  });

  test("emits only the missing reasoning suffix when completed reasoning extends streamed deltas", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("item/reasoning/summaryTextDelta", {
      itemId: "reasoning-item-2",
      delta: "Think",
    });
    asInternals(session).handleNotification("item/reasoning/summaryTextDelta", {
      itemId: "reasoning-item-2",
      delta: "ing",
    });
    asInternals(session).handleNotification("item/completed", {
      item: {
        id: "reasoning-item-2",
        type: "reasoning",
        summary: ["Thinking!"],
      },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "reasoning", text: "Think" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "reasoning", text: "ing" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "reasoning", text: "!" },
      },
    ]);
  });

  test("approving a synthetic Codex plan permission disables plan mode, preserves fast mode, and returns follow-up prompt", async () => {
    const session = createSession({
      featureValues: { plan_mode: true, fast_mode: true },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("turn/started", {
      turn: { id: "turn-plan-2" },
    });
    asInternals(session).handleNotification("turn/plan/updated", {
      plan: [{ step: "Implement the new flow", status: "pending" }],
    });
    asInternals(session).handleNotification("turn/completed", {
      turn: { status: "completed", error: null },
    });

    const request = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
        event.type === "permission_requested" && event.request.kind === "plan",
    );
    expect(request).toBeDefined();
    if (!request) {
      throw new Error("Expected synthetic plan approval permission");
    }

    const result = await session.respondToPermission(request.request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });

    expect(asInternals(session).serviceTier).toBe("fast");
    expect(asInternals(session).planModeEnabled).toBe(false);
    expect(asInternals(session).config.featureValues).toEqual({
      plan_mode: false,
      fast_mode: true,
    });
    // The session returns the follow-up prompt instead of calling startTurn directly.
    // The caller (session/agent-manager) is responsible for sending it through streamAgent.
    expect(result).toBeDefined();
    expect(result!.followUpPrompt).toEqual(
      expect.stringContaining("The user approved the plan. Implement it now."),
    );
    expect(events.at(-1)).toEqual({
      type: "permission_resolved",
      provider: "codex",
      requestId: request.request.id,
      resolution: {
        behavior: "allow",
        selectedActionId: "implement",
      },
    });
  });

  test("approving a synthetic Codex plan permission keeps fast mode disabled when it started disabled", async () => {
    const session = createSession({
      featureValues: { plan_mode: true, fast_mode: false },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("turn/started", {
      turn: { id: "turn-plan-3" },
    });
    asInternals(session).handleNotification("turn/plan/updated", {
      plan: [{ step: "Implement the safe flow", status: "pending" }],
    });
    asInternals(session).handleNotification("turn/completed", {
      turn: { status: "completed", error: null },
    });

    const request = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
        event.type === "permission_requested" && event.request.kind === "plan",
    );
    expect(request).toBeDefined();
    if (!request) {
      throw new Error("Expected synthetic plan approval permission");
    }

    const result = await session.respondToPermission(request.request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });

    expect(asInternals(session).serviceTier).toBeNull();
    expect(asInternals(session).planModeEnabled).toBe(false);
    expect(asInternals(session).config.featureValues).toEqual({
      plan_mode: false,
      fast_mode: false,
    });
    expect(result?.followUpPrompt).toEqual(
      expect.stringContaining("The user approved the plan. Implement it now."),
    );
  });

  test("follow-up implementation turn keeps fast service tier and switches back to code collaboration mode", async () => {
    const session = createSession({
      featureValues: { plan_mode: true, fast_mode: true },
    });
    asInternals(session).collaborationModes = [
      {
        name: "Code",
        mode: "code",
        developer_instructions: "Built-in code mode",
      },
      {
        name: "Plan",
        mode: "plan",
        developer_instructions: "Built-in plan mode",
      },
    ];
    asInternals(session).refreshResolvedCollaborationMode();
    const request = vi.fn(async (method: string) => {
      if (method === "thread/loaded/list") {
        return { data: ["test-thread"] };
      }
      if (method === "turn/start") {
        return {};
      }
      throw new Error(`Unexpected request: ${method}`);
    });

    session.activeForegroundTurnId = null;
    session.client = createStub<CodexClientLike>({ request });

    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    asInternals(session).handleNotification("turn/started", {
      turn: { id: "turn-plan-4" },
    });
    asInternals(session).handleNotification("turn/plan/updated", {
      plan: [{ step: "Implement the fast flow", status: "pending" }],
    });
    asInternals(session).handleNotification("turn/completed", {
      turn: { status: "completed", error: null },
    });

    const permissionRequest = events.find(
      (event): event is Extract<AgentStreamEvent, { type: "permission_requested" }> =>
        event.type === "permission_requested" && event.request.kind === "plan",
    );
    expect(permissionRequest).toBeDefined();
    if (!permissionRequest) {
      throw new Error("Expected synthetic plan approval permission");
    }

    const result = await session.respondToPermission(permissionRequest.request.id, {
      behavior: "allow",
      selectedActionId: "implement",
    });
    expect(result?.followUpPrompt).toEqual(expect.any(String));

    await session.startTurn(result!.followUpPrompt!);

    const turnStartCall = request.mock.calls.find(([method]) => method === "turn/start");
    expect(turnStartCall?.[1]).toEqual(
      expect.objectContaining({
        serviceTier: "fast",
        collaborationMode: expect.objectContaining({
          mode: "code",
        }),
      }),
    );
  });
});

describe("Codex importable sessions", () => {
  test("listImportableSessions uses thread list metadata without hydrating thread history", async () => {
    const allThreads = [
      {
        id: "thread-a1",
        cwd: "/workspace/project-a",
        preview: "First A session",
        name: "Named first A session",
        createdAt: 1000,
        updatedAt: 2000,
      },
      {
        id: "thread-a2",
        cwd: "/workspace/project-a",
        preview: "Second A session",
        createdAt: 1500,
        updatedAt: 2500,
      },
      {
        id: "thread-b1",
        cwd: "/workspace/project-b",
        preview: "B session",
        createdAt: 3000,
        updatedAt: 4000,
      },
    ];
    const calls: Array<{ method: string; params?: unknown }> = [];

    const fakeClient = {
      request: async (method: string, params?: unknown) => {
        calls.push({ method, params });
        if (method === "thread/list") return { data: allThreads };
        return {};
      },
      notify: () => {},
      dispose: async () => {},
    };

    const provider = new CodexAppServerAgentClient(createTestLogger(), undefined, {
      _createCodexClient: () => fakeClient,
    });
    castInternals<{ spawnAppServer: () => Promise<ChildProcessWithoutNullStreams> }>(
      provider,
    ).spawnAppServer = async () => {
      const child = new EventEmitter() as ChildProcessWithoutNullStreams;
      child.exitCode = 0;
      child.signalCode = null;
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = vi.fn(() => true) as ChildProcessWithoutNullStreams["kill"];
      return child;
    };

    const sessions = await provider.listImportableSessions({ cwd: "/workspace/project-a" });

    expect(sessions.map((session) => session.providerHandleId).sort()).toEqual([
      "thread-a1",
      "thread-a2",
    ]);
    expect(sessions.every((session) => session.cwd === "/workspace/project-a")).toBe(true);
    expect(sessions[0]).toEqual(
      expect.objectContaining({
        providerHandleId: "thread-a1",
        title: "Named first A session",
        firstPromptPreview: "First A session",
        lastPromptPreview: "First A session",
      }),
    );
    expect(calls).toEqual([
      {
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex_app_server_daemon",
            title: "Codex App Server Daemon",
            version: "0.0.0",
          },
          capabilities: { experimentalApi: true },
        },
      },
      { method: "thread/list", params: { limit: 50, cwd: "/workspace/project-a" } },
    ]);
  });
});
