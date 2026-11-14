import path from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import { forkSession } from "@anthropic-ai/claude-agent-sdk";
import { projectFolderSessionStore } from "./rewind-session-store.js";

export interface ClaudeForkRequest {
  sessionId: string;
  upToMessageId: string;
  transcriptPath: string;
}

export type ClaudeForkReply =
  | { kind: "forked"; sessionId: string }
  | {
      kind: "failed";
      message: string;
      stack: string | undefined;
      properties: Record<string, unknown>;
    };

const port = parentPort!;
const request: ClaudeForkRequest = workerData;
try {
  // On its own, the SDK looks for the session under the daemon's CLAUDE_CONFIG_DIR, while a
  // provider can point Claude Code at another one. Forking through a store rooted at the
  // transcript's folder reads the session where Claude Code wrote it and writes the fork beside it.
  const fork = await forkSession(request.sessionId, {
    upToMessageId: request.upToMessageId,
    sessionStore: projectFolderSessionStore(path.dirname(request.transcriptPath)),
  });
  port.postMessage({ kind: "forked", sessionId: fork.sessionId } satisfies ClaudeForkReply);
} catch (cause) {
  const error = cause instanceof Error ? cause : new Error(String(cause));
  const failure = { kind: "failed", message: error.message, stack: error.stack } as const;
  try {
    port.postMessage({ ...failure, properties: { ...error } } satisfies ClaudeForkReply);
  } catch (cloneError) {
    if (!(cloneError instanceof DOMException) || cloneError.name !== "DataCloneError") {
      throw cloneError;
    }
    port.postMessage({ ...failure, properties: {} } satisfies ClaudeForkReply);
  }
}
