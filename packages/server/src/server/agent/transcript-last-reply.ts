import { open, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Replies sit at the end; a long session's transcript can be hundreds of megabytes.
const TAIL_BYTES = 512 * 1024;
const CODEX_INDEX_TTL_MS = 5 * 60 * 1000;

interface CodexIndex {
  home: string;
  builtAt: number;
  byThreadId: Map<string, string>;
}
let codexIndex: CodexIndex | null = null;

async function dotDirs(home: string, prefix: string): Promise<string[]> {
  const entries = await readdir(home, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => path.join(home, entry.name));
}

async function readTail(file: string): Promise<string[]> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    const lines = buffer.toString("utf8").split("\n");
    return start > 0 ? lines.slice(1) : lines;
  } finally {
    await handle.close();
  }
}

function parseLines(lines: readonly string[]): unknown[] {
  const parsed: unknown[] = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // A line cut by the tail window or still being written.
    }
  }
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOfContent(content: unknown, textType: string): string | null {
  if (!Array.isArray(content)) return null;
  const texts = content
    .filter((part) => isRecord(part) && part.type === textType && typeof part.text === "string")
    .map((part) => (part as { text: string }).text);
  const joined = texts.join("\n").trim();
  return joined || null;
}

/** The last assistant text in a Claude Code transcript's lines. */
export function lastClaudeReply(entries: readonly unknown[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || entry.type !== "assistant" || !isRecord(entry.message)) continue;
    const text = textOfContent(entry.message.content, "text");
    if (text) return text;
  }
  return null;
}

/** The last agent message in a Codex rollout's lines. */
export function lastCodexReply(entries: readonly unknown[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!isRecord(entry) || !isRecord(entry.payload)) continue;
    const payload = entry.payload;
    if (payload.type === "task_complete" && typeof payload.last_agent_message === "string") {
      if (payload.last_agent_message.trim()) return payload.last_agent_message;
    }
    if (payload.type === "message" && payload.role === "assistant") {
      const text = textOfContent(payload.content, "output_text");
      if (text) return text;
    }
  }
  return null;
}

async function findClaudeTranscript(home: string, sessionId: string): Promise<string | null> {
  for (const root of await dotDirs(home, ".claude")) {
    const projects = path.join(root, "projects");
    const dirs = await readdir(projects, { withFileTypes: true }).catch(() => []);
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const candidate = path.join(projects, dir.name, `${sessionId}.jsonl`);
      if (
        await stat(candidate).then(
          () => true,
          () => false,
        )
      )
        return candidate;
    }
  }
  return null;
}

async function walkRollouts(dir: string, into: Map<string, string>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkRollouts(full, into);
    } else if (entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      const threadId = entry.name.slice(-"00000000-0000-0000-0000-000000000000.jsonl".length, -6);
      into.set(threadId, full);
    }
  }
}

async function findCodexRollout(home: string, threadId: string): Promise<string | null> {
  if (
    !codexIndex ||
    codexIndex.home !== home ||
    Date.now() - codexIndex.builtAt > CODEX_INDEX_TTL_MS
  ) {
    const byThreadId = new Map<string, string>();
    for (const root of await dotDirs(home, ".codex")) {
      await walkRollouts(path.join(root, "sessions"), byThreadId);
    }
    codexIndex = { home, builtAt: Date.now(), byThreadId };
  }
  return codexIndex.byThreadId.get(threadId) ?? null;
}

/**
 * The last reply of a provider session, read from the provider's own transcript on disk. Used
 * for agents that are not loaded: reading a file never starts or resumes anything.
 */
export async function readTranscriptLastReply(
  persistence: { provider: string; sessionId: string; metadata?: Record<string, unknown> } | null,
  home: string = os.homedir(),
): Promise<string | null> {
  if (!persistence?.sessionId) return null;
  const kind =
    typeof persistence.metadata?.provider === "string"
      ? persistence.metadata.provider
      : persistence.provider;
  if (kind.startsWith("claude")) {
    const file = await findClaudeTranscript(home, persistence.sessionId);
    return file ? lastClaudeReply(parseLines(await readTail(file))) : null;
  }
  if (kind.startsWith("codex")) {
    const file = await findCodexRollout(home, persistence.sessionId);
    return file ? lastCodexReply(parseLines(await readTail(file))) : null;
  }
  return null;
}
