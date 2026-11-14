import { createReadStream } from "node:fs";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

const APPEND_CHUNK_LENGTH = 1 << 20;

export function projectFolderSessionStore(projectFolder: string): SessionStore {
  const transcriptPath = (sessionId: string) => path.join(projectFolder, `${sessionId}.jsonl`);
  return {
    async load({ sessionId }) {
      const input = createReadStream(transcriptPath(sessionId), { encoding: "utf8" });
      const lines = createInterface({ input, crlfDelay: Infinity });
      const entries: SessionStoreEntry[] = [];
      try {
        for await (const line of lines) {
          const entry = parseTranscriptEntry(line);
          if (entry) entries.push(entry);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
      } finally {
        lines.close();
        input.destroy();
      }
      return entries;
    },
    async append({ sessionId }, entries) {
      let chunk = "";
      for (const entry of entries) {
        chunk += `${JSON.stringify(entry)}\n`;
        if (chunk.length >= APPEND_CHUNK_LENGTH) {
          await appendFile(transcriptPath(sessionId), chunk, "utf8");
          chunk = "";
        }
      }
      await appendFile(transcriptPath(sessionId), chunk, "utf8");
    },
  };
}

function parseTranscriptEntry(line: string): SessionStoreEntry | null {
  if (!line.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // Skip a line that is not JSON, as the SDK's own transcript reader does.
    return null;
  }
  return isSessionStoreEntry(parsed) ? parsed : null;
}

function isSessionStoreEntry(value: unknown): value is SessionStoreEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  );
}
