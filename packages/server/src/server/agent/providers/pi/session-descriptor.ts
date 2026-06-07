import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type {
  AgentPersistenceHandle,
  AgentTimelineItem,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { createRealpathAwarePathMatcher } from "../../../../utils/path.js";

const PI_PROVIDER = "pi";
const PI_CONFIG_DIR_NAME = ".pi";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const FULL_SCAN_LINE_LIMIT = 2_000;

interface PiSessionDescriptorOptions extends ListPersistedAgentsOptions {
  provider?: string;
  sessionDir?: string;
  runtimeSettings?: ProviderRuntimeSettings;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

interface PiSessionHeader {
  sessionId: string;
  cwd: string;
  createdAt: Date | null;
}

interface PiSessionTail {
  title: string | null;
  lastActivityAt: Date | null;
  lastUserMessage: string | null;
}

export async function listPiPersistedAgents(
  options: PiSessionDescriptorOptions = {},
): Promise<PersistedAgentDescriptor[]> {
  const provider = options.provider ?? PI_PROVIDER;
  const sessionsDir = await resolvePiSessionsDir(options);
  const files = await walkJsonlFiles(sessionsDir);
  const matchesCwd = options.cwd ? createRealpathAwarePathMatcher(options.cwd) : null;
  const limit = options.limit ?? 20;
  const descriptors: PersistedAgentDescriptor[] = [];

  for (const file of files) {
    const descriptor = await readPiSessionDescriptor(file, provider);
    if (!descriptor) continue;
    if (matchesCwd && !matchesCwd(descriptor.cwd)) continue;
    descriptors.push(descriptor);
  }

  return descriptors
    .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime())
    .slice(0, limit);
}

async function resolvePiSessionsDir(options: PiSessionDescriptorOptions): Promise<string> {
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? homedir();
  const baseDir = options.cwd ?? process.cwd();

  if (options.sessionDir?.trim()) {
    return resolveConfigPath(options.sessionDir, { baseDir, homeDir });
  }

  const agentDir = resolvePiAgentDir({ runtimeSettings: options.runtimeSettings, env, homeDir });

  const envSessionDir =
    options.runtimeSettings?.env?.[PI_SESSION_DIR_ENV] ?? env[PI_SESSION_DIR_ENV];
  if (envSessionDir?.trim()) {
    return resolveConfigPath(envSessionDir, { baseDir, homeDir });
  }

  const settingsSessionDir = await readConfiguredSessionDir({
    agentDir,
    cwd: options.cwd,
  });
  if (settingsSessionDir?.trim()) {
    return resolveConfigPath(settingsSessionDir, { baseDir, homeDir });
  }

  return path.join(agentDir, "sessions");
}

function resolvePiAgentDir(input: {
  runtimeSettings?: ProviderRuntimeSettings;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  const configured = input.runtimeSettings?.env?.[PI_AGENT_DIR_ENV] ?? input.env[PI_AGENT_DIR_ENV];
  if (configured?.trim()) {
    return resolveConfigPath(configured, { baseDir: process.cwd(), homeDir: input.homeDir });
  }
  return path.join(input.homeDir, PI_CONFIG_DIR_NAME, "agent");
}

async function readConfiguredSessionDir(input: {
  agentDir: string;
  cwd: string | undefined;
}): Promise<string | null> {
  const values = await Promise.all([
    readSessionDirFromSettings(path.join(input.agentDir, "settings.json")),
    input.cwd
      ? readSessionDirFromSettings(path.join(input.cwd, PI_CONFIG_DIR_NAME, "settings.json"))
      : null,
  ]);
  return values[1] ?? values[0] ?? null;
}

async function readSessionDirFromSettings(settingsPath: string): Promise<string | null> {
  try {
    const parsed = JSON.parse(await readFile(settingsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const sessionDir = Reflect.get(parsed, "sessionDir");
    return typeof sessionDir === "string" && sessionDir.trim() ? sessionDir : null;
  } catch {
    return null;
  }
}

function resolveConfigPath(value: string, options: { baseDir: string; homeDir: string }): string {
  if (value === "~") {
    return options.homeDir;
  }
  if (value.startsWith("~/")) {
    return path.join(options.homeDir, value.slice(2));
  }
  return path.isAbsolute(value) ? value : path.resolve(options.baseDir, value);
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

async function readPiSessionDescriptor(
  filePath: string,
  provider: string,
): Promise<PersistedAgentDescriptor | null> {
  const firstLine = await readFirstLine(filePath);
  if (!firstLine) return null;
  const header = parseSessionHeader(firstLine);
  if (!header) return null;

  const tail = await readTail(filePath).catch(() => "");
  const tailInfo = parseSessionTail(tail);
  const headInfo = await scanSessionHead(filePath);
  const title = tailInfo.title ?? headInfo.title ?? headInfo.firstUserMessage;
  const lastActivityAt =
    tailInfo.lastActivityAt ?? (await readFileMtime(filePath)) ?? header.createdAt ?? new Date(0);
  const timeline = buildPreviewTimeline({
    firstUserMessage: headInfo.firstUserMessage,
    lastUserMessage: tailInfo.lastUserMessage,
  });

  const persistence: AgentPersistenceHandle = {
    provider,
    sessionId: header.sessionId,
    nativeHandle: filePath,
    metadata: {
      provider,
      cwd: header.cwd,
    },
  };

  return {
    provider,
    sessionId: header.sessionId,
    cwd: header.cwd,
    title,
    lastActivityAt,
    persistence,
    timeline,
  };
}

async function readFirstLine(filePath: string): Promise<string | null> {
  const handle = await open(filePath, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return null;
    const chunk = buffer.subarray(0, bytesRead).toString("utf8");
    const newlineIndex = chunk.indexOf("\n");
    return (newlineIndex === -1 ? chunk : chunk.slice(0, newlineIndex)).trim();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readTail(filePath: string): Promise<string> {
  const fileStats = await stat(filePath);
  const start = Math.max(0, fileStats.size - TAIL_BYTES);
  const length = fileStats.size - start;
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
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
  const createdAt = parseDate(entry.timestamp);
  return { sessionId, cwd, createdAt };
}

function parseSessionTail(tail: string): PiSessionTail {
  const lines = tail.split(/\r?\n/u);
  let title: string | null = null;
  let lastActivityAt: Date | null = null;
  let fallbackTimestamp: Date | null = null;
  let lastUserMessage: string | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseJsonRecord(lines[index].trim());
    if (!entry) continue;

    if (!title && entry.type === "session_info") {
      title = readNonEmptyString(entry.name);
    }

    const entryTimestamp = parseDate(entry.timestamp);
    if (!fallbackTimestamp && entryTimestamp) {
      fallbackTimestamp = entryTimestamp;
    }

    if (entry.type !== "message") {
      continue;
    }

    if (!lastActivityAt && entryTimestamp) {
      lastActivityAt = entryTimestamp;
    }

    if (!lastUserMessage && isRecord(entry.message) && entry.message.role === "user") {
      lastUserMessage = extractMessageText(entry.message.content);
    }

    if (title && lastActivityAt && lastUserMessage) {
      break;
    }
  }

  return { title, lastActivityAt: lastActivityAt ?? fallbackTimestamp, lastUserMessage };
}

async function scanSessionHead(filePath: string): Promise<{
  title: string | null;
  firstUserMessage: string | null;
}> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch {
    return { title: null, firstUserMessage: null };
  }

  let title: string | null = null;
  let firstUserMessage: string | null = null;
  let lineCount = 0;

  for (const rawLine of content.split(/\r?\n/u)) {
    lineCount += 1;
    const entry = parseJsonRecord(rawLine.trim());
    if (!entry) continue;

    if (entry.type === "session_info") {
      title = readNonEmptyString(entry.name) ?? title;
    }

    if (!firstUserMessage && entry.type === "message" && isRecord(entry.message)) {
      if (entry.message.role === "user") {
        firstUserMessage = extractMessageText(entry.message.content);
      }
    }

    if (title && firstUserMessage) {
      break;
    }
    if (lineCount >= FULL_SCAN_LINE_LIMIT && firstUserMessage) {
      break;
    }
  }

  return { title, firstUserMessage };
}

function buildPreviewTimeline(input: {
  firstUserMessage: string | null;
  lastUserMessage: string | null;
}): AgentTimelineItem[] {
  const items: AgentTimelineItem[] = [];
  if (input.firstUserMessage) {
    items.push({ type: "user_message", text: input.firstUserMessage });
  }
  if (input.lastUserMessage && input.lastUserMessage !== input.firstUserMessage) {
    items.push({ type: "user_message", text: input.lastUserMessage });
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
