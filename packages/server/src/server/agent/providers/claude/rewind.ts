import { createReadStream } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import {
  forkSession as claudeForkSession,
  type Query,
  type SessionStore,
  type SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

export interface ClaudeRewindSdk {
  forkSession(
    sessionId: string,
    options: { upToMessageId: string; transcriptPath: string },
  ): Promise<{ sessionId: string }>;
}

// On its own, the SDK looks for the session under the daemon's CLAUDE_CONFIG_DIR, while a
// provider can point Claude Code at another one. Forking through a store rooted at the
// transcript's folder reads the session where Claude Code wrote it and writes the fork beside it.
export const realClaudeRewindSdk: ClaudeRewindSdk = {
  forkSession: (sessionId, options) =>
    claudeForkSession(sessionId, {
      upToMessageId: options.upToMessageId,
      sessionStore: projectFolderSessionStore(path.dirname(options.transcriptPath)),
    }),
};

function projectFolderSessionStore(projectFolder: string): SessionStore {
  const transcriptPath = (sessionId: string) => path.join(projectFolder, `${sessionId}.jsonl`);
  return {
    async load({ sessionId }) {
      let text: string;
      try {
        text = await readFile(transcriptPath(sessionId), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      }
      return parseTranscriptEntries(text);
    },
    async append({ sessionId }, entries) {
      const lines = entries.map((entry) => `${JSON.stringify(entry)}\n`).join("");
      await appendFile(transcriptPath(sessionId), lines, "utf8");
    },
  };
}

function parseTranscriptEntries(text: string): SessionStoreEntry[] {
  const entries: SessionStoreEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Skip a line that is not JSON, as the SDK's own transcript reader does.
      continue;
    }
    if (isSessionStoreEntry(parsed)) entries.push(parsed);
  }
  return entries;
}

function isSessionStoreEntry(value: unknown): value is SessionStoreEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}

/**
 * The uuid of the transcript entry that ends the assistant message `messageId`, the place to fork
 * a conversation after that message. `messageId` is either an entry uuid (rows replayed from the
 * transcript) or the API message id (rows streamed live). Claude Code writes one entry per content
 * block, all sharing the API message id, so the message ends at the last of them. Null when the
 * main conversation holds no such message; subagent sidechains are skipped, since forkSession
 * cannot resolve their uuids.
 */
export async function findAssistantMessageEnd(
  transcriptPath: string,
  messageId: string,
): Promise<string | null> {
  const input = createReadStream(transcriptPath, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let apiMessageId: string | null = null;
  let end: string | null = null;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = parsed as {
        type?: unknown;
        uuid?: unknown;
        isSidechain?: unknown;
        message?: { id?: unknown };
      };
      if (entry.isSidechain === true || typeof entry.uuid !== "string") continue;
      const entryApiId = entry.type === "assistant" ? entry.message?.id : undefined;
      if (apiMessageId === null) {
        if (entry.uuid !== messageId && entryApiId !== messageId) continue;
        if (typeof entryApiId !== "string") return entry.uuid;
        apiMessageId = entryApiId;
      }
      if (entryApiId === apiMessageId) end = entry.uuid;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  return end;
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
