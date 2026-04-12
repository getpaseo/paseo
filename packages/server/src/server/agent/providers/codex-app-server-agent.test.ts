import { describe, expect, test } from "vitest";
import { existsSync, rmSync } from "node:fs";

import type { AgentLaunchContext, AgentSession, AgentSessionConfig, AgentStreamEvent } from "../agent-sdk-types.js";
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
  const logger = createTestLogger();

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
          options: [
            { label: "Coffee", description: "Default" },
            { label: "Tea" },
          ],
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
                options: [
                  { label: "Coffee", description: "Default" },
                  { label: "Tea" },
                ],
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
                options: [
                  { label: "Coffee", description: "Default" },
                  { label: "Tea" },
                ],
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
                options: [
                  { label: "Coffee", description: "Default" },
                  { label: "Tea" },
                ],
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

  test("emits all buffered assistant text before task_complete closes the turn", () => {
    const session = createSession();
    const events: AgentStreamEvent[] = [];
    session.subscribe((event) => events.push(event));

    ;(session as any).handleNotification("item/agentMessage/delta", {
      itemId: "msg-late-final-1",
      delta: "FIRST_BUFFERED_MESSAGE",
    });

    ;(session as any).handleNotification("item/agentMessage/delta", {
      itemId: "msg-late-final-2",
      delta: "SECOND_BUFFERED_MESSAGE",
    });

    ;(session as any).handleNotification("codex/event/task_complete", {
      msg: { type: "task_complete" },
    });

    expect(events).toEqual([
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "assistant_message",
          text: "FIRST_BUFFERED_MESSAGE",
        },
      },
      {
        type: "timeline",
        provider: "codex",
        turnId: "test-turn",
        item: {
          type: "assistant_message",
          text: "SECOND_BUFFERED_MESSAGE",
        },
      },
      {
        type: "turn_completed",
        provider: "codex",
        turnId: "test-turn",
        usage: undefined,
      },
    ]);
  });
});
