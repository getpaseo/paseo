import { describe, expect, test } from "vitest";

import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
} from "./app-server-transport.js";
import {
  type CodexUserMessageTurnIndex,
  type CodexRewindClient,
  branchCodexConversation,
  revertCodexConversation,
} from "./rewind.js";

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

class CodexMessageTurns implements CodexUserMessageTurnIndex {
  constructor(
    private readonly indexesByMessageId: Map<string, number>,
    private readonly turnIdsByMessageId: Map<string, string> = new Map(),
  ) {}

  resolve(messageId: string): { index: number; turnId: string | null } | null {
    const index = this.indexesByMessageId.get(messageId);
    return index === undefined
      ? null
      : { index, turnId: this.turnIdsByMessageId.get(messageId) ?? null };
  }

  count(): number {
    return this.indexesByMessageId.size;
  }
}

describe("Codex Rewind", () => {
  test("rewinds the conversation by forking the thread and rolling back past the native user message", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessageTurns,
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
        excludeTurns: true,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("rewinds the conversation using native user message ids hydrated from app-server history", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
        ["codex-third", 2],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-second",
      userMessageTurns,
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
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", 0],
        ["codex-second", 1],
      ]),
      new Map([
        ["codex-first", "turn-first"],
        ["codex-second", "turn-second"],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      userMessageTurns,
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
        excludeTurns: true,
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
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", 0]]));
    let reboundThreadId: string | null = null;

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "codex-first",
        cwd: "/workspace/project",
        model: "gpt-5.4-mini",
        serviceTier: null,
        userMessageTurns,
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
    const userMessageTurns = new CodexMessageTurns(new Map([["codex-first", 0]]));

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "missing-message",
        userMessageTurns,
        threadRollbackAvailable: true,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
  });
});

const HISTORY_TURNS = [
  {
    id: "turn-1",
    items: [
      { type: "userMessage", id: "user-1" },
      { type: "agentMessage", id: "assistant-1" },
    ],
  },
  {
    id: "turn-2",
    items: [
      { type: "userMessage", id: "user-2" },
      { type: "reasoning", id: "reasoning-2" },
      { type: "agentMessage", id: "assistant-2" },
    ],
  },
  {
    id: "turn-3",
    items: [
      { type: "userMessage", id: "user-3" },
      { type: "agentMessage", id: "assistant-3" },
    ],
  },
];

class LegacyHistoryCodex extends FakeCodex {
  override request(method: string, params?: unknown): Promise<unknown> {
    if (method === "thread/read") {
      const includeTurns = (params as { includeTurns?: boolean }).includeTurns === true;
      return Promise.resolve({
        thread: {
          id: "source-thread",
          historyMode: "legacy",
          ...(includeTurns ? { turns: HISTORY_TURNS } : {}),
        },
      });
    }
    throw new Error(`Unexpected request: ${method}`);
  }
}

class PaginatedHistoryCodex extends FakeCodex {
  override request(method: string): Promise<unknown> {
    if (method === "thread/read") {
      return Promise.resolve({ thread: { id: "source-thread", historyMode: "paginated" } });
    }
    if (method === "thread/items/list") {
      return Promise.resolve({
        data: HISTORY_TURNS.flatMap((turn) =>
          turn.items.map((item) => ({ turnId: turn.id, item })),
        ),
        nextCursor: null,
      });
    }
    throw new Error(`Unexpected request: ${method}`);
  }

  override rollbackThread(): Promise<CodexThreadRollbackResponse> {
    throw new Error("paginated threads do not support thread/rollback");
  }
}

const branchSettings = {
  threadId: "source-thread",
  cwd: "/workspace/branch",
  model: "gpt-5.4-mini",
  serviceTier: null,
  threadRollbackAvailable: true,
};

describe("Codex branch", () => {
  test("forks a paginated thread before the turn after the selected assistant message", async () => {
    const codex = new PaginatedHistoryCodex();

    const threadId = await branchCodexConversation({
      ...branchSettings,
      client: codex,
      messageId: "assistant-2",
    });

    expect(threadId).toBe("forked-thread");
    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        beforeTurnId: "turn-3",
        cwd: "/workspace/branch",
        model: "gpt-5.4-mini",
        serviceTier: null,
        excludeTurns: true,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([]);
  });

  test("forks the whole thread when the selected assistant message ends the latest turn", async () => {
    const codex = new PaginatedHistoryCodex();

    await branchCodexConversation({ ...branchSettings, client: codex, messageId: "assistant-3" });

    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        cwd: "/workspace/branch",
        model: "gpt-5.4-mini",
        serviceTier: null,
        excludeTurns: true,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([]);
  });

  test("forks a legacy thread and rolls back the turns after the selected assistant message", async () => {
    const codex = new LegacyHistoryCodex();

    const threadId = await branchCodexConversation({
      ...branchSettings,
      client: codex,
      messageId: "assistant-1",
    });

    expect(codex.recordedForks).toMatchObject([{ threadId: "source-thread" }]);
    expect(codex.recordedForks[0]).not.toHaveProperty("beforeTurnId");
    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(threadId).toBe("forked-thread");
  });

  test("declines to branch when the assistant message is not in the thread", async () => {
    const codex = new PaginatedHistoryCodex();

    await expect(
      branchCodexConversation({ ...branchSettings, client: codex, messageId: "missing-message" }),
    ).rejects.toThrow("Codex fork target missing-message is not in the thread");
    expect(codex.recordedForks).toEqual([]);
  });
});
