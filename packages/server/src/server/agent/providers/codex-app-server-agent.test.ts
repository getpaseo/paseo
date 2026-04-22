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

function createSession(configOverrides: Partial<AgentSessionConfig> = {}) {
  const session = new __codexAppServerInternals.CodexAppServerAgentSession(
    createConfig(configOverrides),
    null,
    createTestLogger(),
    () => {
      throw new Error("Test session cannot spawn Codex app-server");
    },
  ) as unknown as AgentSession & { [key: string]: unknown };
  session.connected = true;
  session.currentThreadId = "test-thread";
  session.activeForegroundTurnId = "test-turn";
  return session;
}

describe("Codex app-server provider", () => {
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
    session.client = { request } as any;

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
        text: expect.stringContaining("GitHub PR #123: Fix race in worktree setup"),
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

    void (session as any).handleToolApprovalRequest({
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

  test("maps question responses from headers back to question ids and completes the tool call", async () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    const pendingResponse = (session as any).handleToolApprovalRequest({
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

    (session as any).handleNotification("turn/started", {
      turn: { id: "turn-plan-1" },
    });
    (session as any).handleNotification("turn/plan/updated", {
      plan: [
        { step: "Inspect the existing auth flow", status: "completed" },
        { step: "Implement the button behavior", status: "pending" },
      ],
    });
    (session as any).handleNotification("turn/completed", {
      turn: { status: "completed", error: null },
    });

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

  test("emits usage_updated on token usage updates and keeps usage on turn completion", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    (session as any).handleNotification("thread/tokenUsage/updated", {
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
    (session as any).handleNotification("turn/completed", {
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

  test("approving a synthetic Codex plan permission disables plan and fast mode and returns follow-up prompt", async () => {
    const session = createSession({
      featureValues: { plan_mode: true, fast_mode: true },
    });
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    (session as any).handleNotification("turn/started", {
      turn: { id: "turn-plan-2" },
    });
    (session as any).handleNotification("turn/plan/updated", {
      plan: [{ step: "Implement the new flow", status: "pending" }],
    });
    (session as any).handleNotification("turn/completed", {
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

    expect((session as any).serviceTier).toBeNull();
    expect((session as any).planModeEnabled).toBe(false);
    expect((session as any).config.featureValues).toEqual({
      plan_mode: false,
      fast_mode: false,
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
});
