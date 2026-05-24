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

  request(): Promise<unknown> {
    throw new Error("FakeCodex uses typed thread methods");
  }
}

class CodexMessageTurns implements CodexUserMessageTurnIndex {
  constructor(private readonly indexesByMessageId: Map<string, number>) {}

  resolve(messageId: string): number | null {
    return this.indexesByMessageId.get(messageId) ?? null;
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
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(reboundThreadId).toBe("forked-thread");
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
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
  });
});
