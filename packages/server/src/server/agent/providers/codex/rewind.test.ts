import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import type {
  CodexThreadForkParams,
  CodexThreadForkResponse,
  CodexThreadRollbackParams,
  CodexThreadRollbackResponse,
} from "./app-server-transport.js";
import {
  type CodexMessageTurnIndexResolver,
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

class LiveCodexMessageTurns implements CodexMessageTurnIndexResolver {
  constructor(private readonly indexesByMessageId: Map<string, number>) {}

  resolve(messageId: string): number | null {
    return this.indexesByMessageId.get(messageId) ?? null;
  }

  count(): number {
    return this.indexesByMessageId.size;
  }
}

let tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tmpRoots = [];
});

function writeRollout(input: { threadId: string; ids: string[] }): string {
  const root = mkdtempSync(path.join(tmpdir(), "codex-rewind-test-"));
  tmpRoots.push(root);
  const rolloutPath = path.join(root, `rollout-${input.threadId}.jsonl`);
  const lines = input.ids.map((id, index) =>
    JSON.stringify({
      type: "response_item",
      item: {
        type: "message",
        role: "user",
        id,
        content: [{ type: "input_text", text: `user prompt ${index + 1}` }],
      },
    }),
  );
  writeFileSync(rolloutPath, `${lines.join("\n")}\n`, "utf8");
  return root;
}

describe("Codex Rewind", () => {
  test("rewinds the conversation by forking the thread and rolling back past the live user message", async () => {
    const codex = new FakeCodex();
    const liveTurns = new LiveCodexMessageTurns(
      new Map([
        ["paseo-first", 0],
        ["paseo-second", 1],
      ]),
    );
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "paseo-first",
      cwd: "/workspace/project",
      model: "gpt-5.4-mini",
      serviceTier: null,
      liveAlias: liveTurns,
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

  test("rewinds the conversation by resolving the persisted rollout user message id", async () => {
    const codex = new FakeCodex();
    const sessionRoot = writeRollout({
      threadId: "source-thread",
      ids: ["paseo-first", "paseo-second", "paseo-third"],
    });
    let reboundThreadId: string | null = null;

    await revertCodexConversation({
      client: codex,
      threadId: "source-thread",
      messageId: "paseo-second",
      sessionRoot,
      setThreadId: (threadId) => {
        reboundThreadId = threadId;
      },
    });

    expect(codex.recordedRollbacks).toEqual([{ threadId: "forked-thread", numTurns: 2 }]);
    expect(reboundThreadId).toBe("forked-thread");
  });

  test("declines to rewind when the user message is not in the Codex thread", async () => {
    const codex = new FakeCodex();
    const sessionRoot = writeRollout({
      threadId: "source-thread",
      ids: ["paseo-first"],
    });

    await expect(
      revertCodexConversation({
        client: codex,
        threadId: "source-thread",
        messageId: "missing-message",
        sessionRoot,
        setThreadId: () => undefined,
      }),
    ).rejects.toThrow("Codex could not find user message missing-message");
    expect(codex.recordedForks).toEqual([]);
    expect(codex.recordedRollbacks).toEqual([]);
  });
});
