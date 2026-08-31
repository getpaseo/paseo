import type { CodexThreadRevertParams, CodexThreadRevertResponse } from "./app-server-transport.js";
import { parseCodexThreadRevertResponse } from "./app-server-transport.js";

export interface CodexRewindClient {
  revertThread?(params: CodexThreadRevertParams): Promise<CodexThreadRevertResponse>;
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown>;
}

export interface CodexUserMessageTurnIndex {
  resolve(messageId: string): { turnId: string | null } | null;
}

async function revertCodexThread(
  client: CodexRewindClient,
  params: CodexThreadRevertParams,
): Promise<CodexThreadRevertResponse> {
  if (client.revertThread) {
    return client.revertThread(params);
  }
  return parseCodexThreadRevertResponse(await client.request("thread/revert", params));
}

// Codex dropped `thread/fork` + `thread/rollback` in favour of `thread/revert`:
// every thread a modern Codex creates is `historyMode: "paginated"`, and rollback
// answers `paginated threads do not support thread/rollback` (-32600) there.
// There is no fallback — an old binary gets a clear "upgrade codex" error from
// the version gate in codex-app-server-agent.ts.
export async function revertCodexConversation(input: {
  client: CodexRewindClient;
  threadId: string | null;
  messageId: string;
  userMessageTurns: CodexUserMessageTurnIndex;
  setThreadId: (
    threadId: string,
    options?: { turnsBackwardsCursor?: string | null },
  ) => void | Promise<void>;
}): Promise<void> {
  if (!input.threadId) {
    throw new Error("Codex thread is not ready for rewind");
  }

  const targetTurn = input.userMessageTurns.resolve(input.messageId);
  if (targetTurn === null) {
    throw new Error(`Codex could not find user message ${input.messageId} in the current thread`);
  }
  if (!targetTurn.turnId) {
    throw new Error(
      `Codex could not resolve the turn for user message ${input.messageId}; the thread did not report a turn id`,
    );
  }

  const reverted = await revertCodexThread(input.client, {
    threadId: input.threadId,
    beforeTurnId: targetTurn.turnId,
  });
  await input.setThreadId(reverted.thread.id, {
    turnsBackwardsCursor: reverted.turnsBackwardsCursor ?? null,
  });
}
