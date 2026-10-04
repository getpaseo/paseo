import { describe, expect, test } from "vitest";

import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
} from "./app-server-transport.js";
import { type CodexRewindClient, revertCodexConversation } from "./rewind.js";

class FakeCodex implements CodexRewindClient {
  readonly recordedForks: CodexThreadForkParams[] = [];
  readonly recordedRollbacks: CodexThreadRollbackParams[] = [];

  async forkThread(params: CodexThreadForkParams): Promise<CodexThreadForkResponse> {
    this.recordedForks.push(params);
    return {
      thread: {
        id: "forked-thread",
        sessionId: "forked-session",
        forkedFromId: params.threadId,
        turns: [],
      },
      model: "gpt-5.4-mini",
      modelProvider: "openai",
      serviceTier: null,
      cwd: "/workspace/project",
      runtimeWorkspaceRoots: [],
      instructionSources: [],
      approvalPolicy: "on-request",
      approvalsReviewer: null,
      sandbox: { type: "workspaceWrite", networkAccess: false },
      activePermissionProfile: null,
      reasoningEffort: null,
    };
  }

  async rollbackThread(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse> {
    this.recordedRollbacks.push(params);
    return {
      thread: {
        id: params.threadId,
        sessionId: "forked-session",
        forkedFromId: "source-thread",
        turns: [],
      },
    };
  }

  request(method: string): Promise<unknown> {
    if (method === "thread/read") {
      return Promise.resolve({ thread: { id: "source-thread", historyMode: "legacy" } });
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

describe("Codex Rewind", () => {
  test("rewinds the conversation by forking the thread and rolling back past the native user message", async () => {
    const codex = new FakeCodex();
    const userMessages = [
      { messageId: "codex-first", turnId: null },
      { messageId: "codex-second", turnId: null },
    ];
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessages,
      threadRollbackAvailable: true,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        excludeTurns: false,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("rewinds the conversation using native user message ids hydrated from app-server history", async () => {
    const codex = new FakeCodex();
    const userMessages = [
      { messageId: "codex-first", turnId: null },
      { messageId: "codex-second", turnId: null },
      { messageId: "codex-third", turnId: null },
    ];
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-second",
      userMessages,
      threadRollbackAvailable: true,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("rewinds a paginated conversation with one bounded fork and no rollback", async () => {
    class PaginatedCodex extends FakeCodex {
      override request(method: string): Promise<unknown> {
        if (method === "thread/read") {
          return Promise.resolve({ thread: { id: "source-thread", historyMode: "paginated" } });
        }
        throw new Error(`Unexpected request: ${method}`);
      }

      override rollbackThread(): Promise<CodexThreadRollbackResponse> {
        throw new Error("paginated threads do not support thread/rollback");
      }
    }

    const codex = new PaginatedCodex();
    const userMessages = [
      { messageId: "codex-first", turnId: "turn-first" },
      { messageId: "codex-second", turnId: "turn-second" },
    ];
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessages,
      threadRollbackAvailable: true,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        beforeTurnId: "turn-first",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        excludeTurns: false,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("does not fork a paginated thread when the target turn id is unavailable", async () => {
    class PaginatedCodex extends FakeCodex {
      override request(method: string): Promise<unknown> {
        if (method === "thread/read") {
          return Promise.resolve({ thread: { id: "source-thread", historyMode: "paginated" } });
        }
        throw new Error(`Unexpected request: ${method}`);
      }
    }

    const codex = new PaginatedCodex();
    const userMessages = [{ messageId: "codex-first", turnId: null }];
    let reboundThreadId: string | null = null;

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "codex-first",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        userMessages,
        threadRollbackAvailable: true,
        setThreadId: (threadId) => {
          reboundThreadId = threadId;
        },
      }),
    ).rejects.toThrow("Codex could not find the turn containing user message codex-first");

    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
    expect(reboundThreadId).toBeNull();
  });

  test("declines to rewind when the user message is not in the Codex thread", async () => {
    const codex = new FakeCodex();
    const userMessages = [{ messageId: "codex-first", turnId: null }];

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "missing-message",
        userMessages,
        threadRollbackAvailable: true,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
  });

  test("rolls back whole turns when a later turn holds a steer message", async () => {
    const codex = new FakeCodex();

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-second",
      userMessages: [
        { messageId: "codex-first", turnId: "turn-first" },
        { messageId: "codex-second", turnId: "turn-second" },
        { messageId: "codex-steer", turnId: "turn-second" },
      ],
      threadRollbackAvailable: true,
      setThreadId: () => undefined,
    });

    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 1 }]);
  });

  test("declines to rewind a steer message without forking", async () => {
    const codex = new FakeCodex();
    let reboundThreadId: string | null = null;

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "codex-steer",
        userMessages: [
          { messageId: "codex-first", turnId: "turn-first" },
          { messageId: "codex-steer", turnId: "turn-first" },
        ],
        threadRollbackAvailable: true,
        setThreadId: (threadId) => {
          reboundThreadId = threadId;
        },
      }),
    ).rejects.toThrow("Select the first message in the turn instead");
    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
    expect(reboundThreadId).toBeNull();
  });
});
