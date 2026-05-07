import { describe, expect, test, vi } from "vitest";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import type {
  AgentLaunchContext,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
} from "../agent-sdk-types.js";
import {
  __codexAppServerInternals,
  codexAppServerTurnInputFromPrompt,
} from "./codex-app-server-agent.js";
import { createTestLogger } from "../../../test-utils/test-logger.js";
import { asInternals as castInternals, createStub } from "../../test-utils/class-mocks.js";

interface CollaborationModeRecord {
  name: string;
  mode?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  developer_instructions?: string | null;
}

interface CodexSessionTestAccess {
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
  options: { goalsEnabled?: boolean } = {},
): CodexTestSession {
  const session = new __codexAppServerInternals.CodexAppServerAgentSession(
    createConfig(configOverrides),
    null,
    createTestLogger(),
    () => {
      throw new Error("Test session cannot spawn Codex app-server");
    },
    {},
    false,
    options.goalsEnabled === true,
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

describe("Codex app-server provider", () => {
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

    const session = new __codexAppServerInternals.CodexAppServerAgentSession(
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

    const session = new __codexAppServerInternals.CodexAppServerAgentSession(
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
    const client = new __codexAppServerInternals.CodexAppServerClient(child, createTestLogger());

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
      await expect(
        __codexAppServerInternals.listCodexSkills(cwd, workspaceGitService),
      ).resolves.toContainEqual({
        name: "shipper",
        description: "Ship changes carefully.",
        argumentHint: "",
      });
      expect(workspaceGitService.resolveRepoRoot).toHaveBeenCalledWith(cwd);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  const logger = createTestLogger();

  test("extracts context window usage from snake_case token payloads", () => {
    expect(
      __codexAppServerInternals.toAgentUsage({
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
      __codexAppServerInternals.toAgentUsage({
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
      __codexAppServerInternals.toAgentUsage({
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
      __codexAppServerInternals.toAgentUsage({
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

    const normalized = __codexAppServerInternals.normalizeCodexOutputSchema(input);

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
            text: "in a worktree, remember to use Claude for the UI",
            text_elements: [],
          },
        ],
      }),
    );
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
    const item = __codexAppServerInternals.mapCodexPatchNotificationToToolCall({
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
    const item = __codexAppServerInternals.mapCodexPlanToToolCall({
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
    const item = __codexAppServerInternals.mapCodexPatchNotificationToToolCall({
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
    const item = __codexAppServerInternals.mapCodexPatchNotificationToToolCall({
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
    const env = __codexAppServerInternals.buildCodexAppServerEnv(
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
        item: {
          type: "assistant_message",
          text: "History loaded.",
        },
      },
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
        item: { type: "assistant_message", text: "Hel" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "assistant_message", text: "lo" },
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
        item: { type: "assistant_message", text: "Hel" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "assistant_message", text: "lo" },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: { type: "assistant_message", text: "!" },
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
          text: "I’m in the waiting phase now. The next read is intentionally delayed so we get meaningful CI state instead of churn.",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "assistant_message",
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
