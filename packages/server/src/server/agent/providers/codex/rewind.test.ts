import { describe, expect, test } from "vitest";

import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
  CodexThreadRevertParams,
  CodexThreadRevertResponse,
} from "./app-server-transport.js";
import { CodexAppServerRpcError } from "./app-server-transport.js";
import {
  type CodexUserMessageTurn,
  type CodexUserMessageTurnIndex,
  type CodexRewindClient,
  revertCodexConversation,
} from "./rewind.js";

class FakeCodex implements CodexRewindClient {
  readonly recordedForks: CodexThreadForkParams[] = [];
  readonly recordedRollbacks: CodexThreadRollbackParams[] = [];
  readonly recordedReverts: CodexThreadRevertParams[] = [];

  constructor(private readonly revertMode: "supported" | "unsupported" = "unsupported") {}

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

  async revertThread(params: CodexThreadRevertParams): Promise<CodexThreadRevertResponse> {
    this.recordedReverts.push(params);
    if (this.revertMode === "unsupported") {
      throw new CodexAppServerRpcError("Method not found: thread/revert", -32601, null);
    }
    return {
      thread: {
        id: params.threadId,
        sessionId: "source-session",
        turns: [],
      },
      turnsBackwardsCursor: null,
      itemsBackwardsCursor: null,
    };
  }

  request(): Promise<unknown> {
    throw new Error("FakeCodex uses typed thread methods");
  }
}

class CodexMessageTurns implements CodexUserMessageTurnIndex {
  constructor(private readonly turnsByMessageId: Map<string, CodexUserMessageTurn>) {}

  resolve(messageId: string): CodexUserMessageTurn | null {
    return this.turnsByMessageId.get(messageId) ?? null;
  }

  count(): number {
    return this.turnsByMessageId.size;
  }
}

describe("Codex Rewind", () => {
  test("rewinds the conversation by forking the thread and rolling back past the native user message", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", { index: 0, turnId: null }],
        ["codex-second", { index: 1, turnId: null }],
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
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", { index: 0, turnId: null }],
        ["codex-second", { index: 1, turnId: null }],
        ["codex-third", { index: 2, turnId: null }],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-second",
      userMessageTurns,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("rewinds a paginated conversation with thread/revert before the target turn", async () => {
    const codex = new FakeCodex("supported");
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", { index: 0, turnId: "turn-first" }],
        ["codex-second", { index: 1, turnId: "turn-second" }],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      userMessageTurns,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedReverts).toEqual([
      { threadId: "source-thread", beforeTurnId: "turn-first" },
    ]);
    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
    expect(reboundThreadId).toBe("source-thread");
  });

  test("falls back to fork and rollback when thread/revert is unavailable", async () => {
    const codex = new FakeCodex("unsupported");
    const userMessageTurns = new CodexMessageTurns(
      new Map([
        ["codex-first", { index: 0, turnId: "turn-first" }],
        ["codex-second", { index: 1, turnId: "turn-second" }],
      ]),
    );

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "codex-first",
      userMessageTurns,
      setThreadId: () => undefined,
    });

    expect(codex.recordedReverts).toEqual([
      { threadId: "source-thread", beforeTurnId: "turn-first" },
    ]);
    expect(codex.recordedForks).toEqual([
      {
        threadId: "source-thread",
        cwd: null,
        model: null,
        serviceTier: null,
        excludeTurns: false,
        persistExtendedHistory: true,
      },
    ]);
    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
  });

  test("declines to rewind when the user message is not in the Codex thread", async () => {
    const codex = new FakeCodex();
    const userMessageTurns = new CodexMessageTurns(
      new Map([["codex-first", { index: 0, turnId: null }]]),
    );

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "missing-message",
        userMessageTurns,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
  });
});
