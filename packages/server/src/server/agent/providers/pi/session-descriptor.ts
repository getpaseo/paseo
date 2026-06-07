import { open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type {
  AgentPersistenceHandle,
  AgentTimelineItem,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "../../agent-sdk-types.js";
import { createRealpathAwarePathMatcher, expandTilde } from "../../../../utils/path.js";

const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;

interface ListPiJsonlPersistedAgentsInput {
  provider: string;
  sessionDir: string;
  options?: ListPersistedAgentsOptions;
}

interface PiSessionHeader {
  sessionId: string;
  cwd: string;
  createdAt: Date | null;
}

interface PiSessionPreview {
  title: string | null;
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastActivityAt: Date | null;
}

export async function listPiJsonlPersistedAgents({
  provider,
  sessionDir,
  options,
}: ListPiJsonlPersistedAgentsInput): Promise<PersistedAgentDescriptor[]> {
  const files = await walkJsonlFiles(resolveSessionDir(sessionDir));
  const matchesCwd = options?.cwd ? createRealpathAwarePathMatcher(options.cwd) : null;
  const limit = options?.limit ?? 20;
  const descriptors: PersistedAgentDescriptor[] = [];

  for (const filePath of files) {
    const firstLine = await readFirstLine(filePath);
    if (!firstLine) continue;
    const header = parseSessionHeader(firstLine);
    if (!header) continue;
    if (matchesCwd && !matchesCwd(header.cwd)) continue;

    const preview = await readSessionPreview(filePath);
    const lastActivityAt =
      preview.lastActivityAt ?? (await readFileMtime(filePath)) ?? header.createdAt ?? new Date(0);
    const persistence: AgentPersistenceHandle = {
      provider,
      sessionId: header.sessionId,
      nativeHandle: filePath,
      metadata: {
        cwd: header.cwd,
      },
    };

    descriptors.push({
      provider,
      sessionId: header.sessionId,
      cwd: header.cwd,
      title: preview.title ?? preview.firstUserMessage,
      lastActivityAt,
      persistence,
      timeline: buildPreviewTimeline(preview),
    });
  }

  return descriptors
    .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime())
    .slice(0, limit);
}

function resolveSessionDir(value: string): string {
  const expanded = expandTilde(value);
  return path.isAbsolute(expanded) ? expanded : path.resolve(process.cwd(), expanded);
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(root, entry.name);
      if (entry.isDirectory()) {
        return await walkJsonlFiles(entryPath);
      }
      return entry.isFile() && entry.name.endsWith(".jsonl") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

async function readFirstLine(filePath: string): Promise<string | null> {
  const chunk = await readChunk(filePath, HEAD_BYTES, 0);
  if (!chunk) return null;
  const newlineIndex = chunk.indexOf("\n");
  return (newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex)).trim();
}

async function readSessionPreview(filePath: string): Promise<PiSessionPreview> {
  const head = await readChunk(filePath, HEAD_BYTES, 0);
  const tail = await readTail(filePath);
  return mergePreviews(
    parsePreviewLines(head ?? "", "forward"),
    parsePreviewLines(tail, "reverse"),
  );
}

async function readChunk(
  filePath: string,
  length: number,
  position: number,
): Promise<string | null> {
  const handle = await open(filePath, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead <= 0) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTail(filePath: string): Promise<string> {
  try {
    const fileStats = await stat(filePath);
    const start = Math.max(0, fileStats.size - TAIL_BYTES);
    return (await readChunk(filePath, fileStats.size - start, start)) ?? "";
  } catch {
    return "";
  }
}

async function readFileMtime(filePath: string): Promise<Date | null> {
  try {
    return (await stat(filePath)).mtime;
  } catch {
    return null;
  }
}

function parseSessionHeader(firstLine: string): PiSessionHeader | null {
  const entry = parseJsonRecord(firstLine);
  if (!entry || entry.type !== "session") return null;
  const sessionId = typeof entry.id === "string" ? entry.id : null;
  const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
  if (!sessionId || !cwd) return null;
  return { sessionId, cwd, createdAt: parseDate(entry.timestamp) };
}

function parsePreviewLines(input: string, order: "forward" | "reverse"): PiSessionPreview {
  const lines = input.split(/\r?\n/u);
  const iterable = order === "forward" ? lines : lines.toReversed();
  let title: string | null = null;
  let firstUserMessage: string | null = null;
  let lastUserMessage: string | null = null;
  let lastActivityAt: Date | null = null;

  for (const rawLine of iterable) {
    const entry = parseJsonRecord(rawLine.trim());
    if (!entry) continue;

    if (!title && entry.type === "session_info") {
      title = readNonEmptyString(entry.name);
    }

    const entryTimestamp = parseDate(entry.timestamp);
    if (!lastActivityAt && entryTimestamp) {
      lastActivityAt = entryTimestamp;
    }

    if (entry.type === "message" && isRecord(entry.message) && entry.message.role === "user") {
      const text = extractMessageText(entry.message.content);
      if (order === "forward" && !firstUserMessage) {
        firstUserMessage = text;
      }
      if (order === "reverse" && !lastUserMessage) {
        lastUserMessage = text;
      }
    }

    const hasPreview = order === "forward" ? title && firstUserMessage : lastUserMessage;
    if (hasPreview && lastActivityAt) {
      break;
    }
  }

  return { title, firstUserMessage, lastUserMessage, lastActivityAt };
}

function mergePreviews(head: PiSessionPreview, tail: PiSessionPreview): PiSessionPreview {
  return {
    title: tail.title ?? head.title,
    firstUserMessage: head.firstUserMessage ?? tail.firstUserMessage,
    lastUserMessage: tail.lastUserMessage ?? head.lastUserMessage,
    lastActivityAt: tail.lastActivityAt ?? head.lastActivityAt,
  };
}

function buildPreviewTimeline(preview: PiSessionPreview): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  if (preview.firstUserMessage) {
    items.push({ type: "user_message", text: preview.firstUserMessage });
  }
  if (preview.lastUserMessage && preview.lastUserMessage !== preview.firstUserMessage) {
    items.push({ type: "user_message", text: preview.lastUserMessage });
  }
  return items;
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractMessageText(content: unknown): string | null {
  if (typeof content === "string") {
    return content.trim() || null;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .flatMap((part) =>
      isRecord(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : [],
    )
    .join("\n\n")
    .trim();
  return text || null;
}
