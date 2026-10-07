import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
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

export async function revertClaudeConversation(input: {
  sdk: ClaudeRewindSdk;
  sessionId: string | null;
  transcriptPath: string | null;
  messageId: string;
  resolveMessageId?: (messageId: string) => string | Promise<string>;
  setSessionId: (sessionId: string) => void;
}): Promise<void> {
  if (!input.sessionId || !input.transcriptPath) {
    throw new Error("Claude session is not ready for rewind");
  }
  const messageId = (await input.resolveMessageId?.(input.messageId)) ?? input.messageId;
  const fork = await input.sdk.forkSession(input.sessionId, {
    upToMessageId: messageId,
    transcriptPath: input.transcriptPath,
  });
  input.setSessionId(fork.sessionId);
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
  setSessionId: (sessionId: string) => void;
}): Promise<void> {
  await revertClaudeFiles({
    query: input.query,
    messageId: input.messageId,
    resolveMessageId: input.resolveMessageId,
  });
  await revertClaudeConversation(input);
}
