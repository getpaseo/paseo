import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import pLimit from "p-limit";
import { resolveWorkerEntrypoint } from "../../../../utils/worker-entrypoint.js";
import type { ClaudeForkReply, ClaudeForkRequest } from "./rewind-worker.js";

export interface ClaudeRewindSdk {
  forkSession(
    sessionId: string,
    options: { upToMessageId: string; transcriptPath: string },
  ): Promise<{ sessionId: string }>;
}

const source = import.meta.url.endsWith(".ts");
const workerUrl = new URL(source ? "./rewind-worker.ts" : "./rewind-worker.js", import.meta.url);
const rewindWorker = resolveWorkerEntrypoint(workerUrl);
const forks = pLimit(1);

export const realClaudeRewindSdk: ClaudeRewindSdk = {
  forkSession: (sessionId, options) =>
    forks(() =>
      forkInWorker({
        sessionId,
        upToMessageId: options.upToMessageId,
        transcriptPath: options.transcriptPath,
      }),
    ),
};

function forkInWorker(request: ClaudeForkRequest): Promise<{ sessionId: string }> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(rewindWorker.entrypoint, {
      eval: rewindWorker.eval,
      execArgv: [],
      workerData: request,
    });
    worker.once("message", (reply: ClaudeForkReply) => {
      void worker.terminate();
      if (reply.kind === "forked") {
        resolve({ sessionId: reply.sessionId });
        return;
      }
      const error = new Error(reply.message);
      error.stack = reply.stack;
      reject(Object.assign(error, reply.properties));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`Claude rewind worker exited (code ${code})`)));
  });
}

/**
 * The entry a message steered into a running turn follows. Claude Code gives such a message no
 * entry of its own: it records a queued_command attachment, under the uuid Paseo minted for the
 * message, hung off the entry it was read after. Forking at that entry drops the message and
 * everything after it. Null when the transcript holds no such attachment.
 */
export async function findSteeredMessageParent(
  transcriptPath: string,
  messageId: string,
): Promise<string | null> {
  const input = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({
    input,
    crlfDelay: Infinity,
  });
  try {
    for await (const line of lines) {
      if (!line.includes(messageId) || !line.includes('"queued_command"')) continue;
      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const record = entry as {
        type?: unknown;
        parentUuid?: unknown;
        attachment?: { type?: unknown; source_uuid?: unknown };
      };
      if (
        record.type === "attachment" &&
        record.attachment?.type === "queued_command" &&
        record.attachment.source_uuid === messageId &&
        typeof record.parentUuid === "string"
      ) {
        return record.parentUuid;
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  } finally {
    lines.close();
    input.destroy();
  }
  return null;
}

export async function revertClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void | Promise<void>;
}): Promise<void> {
  if (!input.sessionId || !input.transcriptPath) {
    throw new Error("Claude session is not ready for rewind");
  }
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: messageId,
    transcriptPath: input.transcriptPath,
  });
  await input.setSessionId(fork.sessionId);
}

export async function revertClaudeFiles(input: {
  query: Query;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
}): Promise<void> {
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const result = await input.query.rewindFiles(messageId, { dryRun: false });
  if (!result.canRewind) {
    throw new Error(result.error ?? `No file checkpoint found for message ${messageId}`);
  }
}

export async function revertClaudeConversationAndFiles(input: {
  sdk: ClaudeRewindSdk;
  query: Query;
  sessionId: string | null;
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void | Promise<void>;
}): Promise<void> {
  await revertClaudeFiles({
    query: input.query,
    messageId: input.messageId,
    resolveMessageId: input.resolveMessageId,
  });
  await revertClaudeConversation(input);
}
