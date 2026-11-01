import { createReadStream, createWriteStream, type Dirent } from "node:fs";
import { open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import type {
  ImportableProviderSession,
  ListImportableSessionsOptions,
} from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { createRealpathAwarePathMatcher } from "../../../../utils/path.js";

const PI_CONFIG_DIR_NAME = ".pi";
const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PI_SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
// Import listing intentionally bounds header parsing to this window. Sessions
// with unusually large preambles may omit their first-prompt preview.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const FULL_SCAN_LINE_LIMIT = 2_000;
const PI_SESSION_HEADER_SCAN_BYTES = 1024 * 1024;
// Rank all discovered files cheaply, then parse only a bounded recent window.
const IMPORT_CANDIDATE_OVERSCAN = 40;
const IMPORT_CANDIDATE_MIN = 400;

interface PiSessionDescriptorOptions extends ListImportableSessionsOptions {
  sessionDir?: string;
  runtimeSettings?: ProviderRuntimeSettings;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  reader?: PiSessionFileReader;
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
  model: string | null;
  thinkingOptionId: string | null;
}

interface PiSessionHead {
  title: string | null;
  firstUserMessage: string | null;
  model: string | null;
  thinkingOptionId: string | null;
}

interface PiSessionDescriptor {
  cwd: string;
  title: string | null;
  firstUserMessage: string | null;
  lastUserMessage: string | null;
  lastActivityAt: Date;
  model: string | null;
  thinkingOptionId: string | null;
}
interface RankedSessionFile {
  file: string;
  mtime: Date;
}

interface PiSessionFileReader {
  readHead(filePath: string): Promise<string | null>;
  readTail(filePath: string): Promise<string>;
}

interface PiSessionDescriptorReadOptions {
  filePath: string;
  reader?: PiSessionFileReader;
  matchesCwd?: ((cwd: string) => boolean) | null;
}

const sessionFileReader: PiSessionFileReader = { readHead: readHeadChunk, readTail };

export interface PiImportSessionConfig {
  model?: string;
  thinkingOptionId?: string;
}

export async function listPiImportableSessions(
  options: PiSessionDescriptorOptions = {},
): Promise<ImportableProviderSession[]> {
  const sessionsDir = await resolvePiSessionsDir(options);
  const files = await walkJsonlFiles(sessionsDir);
  const matchesCwd = options.cwd ? createRealpathAwarePathMatcher(options.cwd) : null;
  const limit = options.limit ?? 20;
  const ranked = await rankSessionFilesByMtime(files);
  const candidateLimit = Math.min(
    options.scanLimit ?? Math.max(limit * IMPORT_CANDIDATE_OVERSCAN, IMPORT_CANDIDATE_MIN),
    500,
  );
  const candidates =
    options.scanLimit === undefined && matchesCwd ? ranked : ranked.slice(0, candidateLimit);
  const sessions: ImportableProviderSession[] = [];

  for (const entry of candidates) {
    const session = await readPiImportableSession({
      filePath: entry.file,
      reader: options.reader,
      matchesCwd,
    });
    if (!session) continue;
    sessions.push(session);
    if (sessions.length >= limit) {
      break;
    }
  }

  return sessions.sort(
    (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
  );
}

export async function copyPiSessionFileWithCwd(input: {
  sourceFile: string;
  targetFile: string;
  cwd: string;
}): Promise<void> {
  const found = findSessionHeaderLine(
    await readSessionFileStart(input.sourceFile, PI_SESSION_HEADER_SCAN_BYTES),
  );
  if (!found) {
    throw new Error(`Pi session file has no session header: ${input.sourceFile}`);
  }
  await writeFile(input.targetFile, `${JSON.stringify({ ...found.header, cwd: input.cwd })}\n`, {
    mode: 0o600,
  });
  await pipeline(
    createReadStream(input.sourceFile, { start: found.bodyStart }),
    createWriteStream(input.targetFile, { flags: "a" }),
  );
}

function findSessionHeaderLine(
  scanned: Buffer,
): { header: Record<string, unknown>; bodyStart: number } | null {
  let lineStart = 0;
  while (lineStart < scanned.length) {
    const newline = scanned.indexOf(0x0a, lineStart);
    const bodyStart = newline === -1 ? scanned.length : newline + 1;
    const line = scanned.subarray(lineStart, bodyStart).toString("utf8").trim();
    if (line) {
      const header = parseJsonRecord(line);
      return header?.type === "session" ? { header, bodyStart } : null;
    }
    lineStart = bodyStart;
  }
  return null;
}

async function readSessionFileStart(filePath: string, maxBytes: number): Promise<Buffer> {
  const handle = await open(filePath, "r").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`Pi session file is missing: ${filePath}`);
    }
    throw error;
  });
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readPiImportSessionConfig(filePath: string): Promise<PiImportSessionConfig> {
  const descriptor = await readPiSessionDescriptor({ filePath });
  if (!descriptor) return {};
  return toPiImportSessionConfig(descriptor);
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
  let entries: Dirent[];
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

async function rankSessionFilesByMtime(files: string[]): Promise<RankedSessionFile[]> {
  const ranked = await Promise.all(
    files.map(async (file) => {
      const mtime = await readFileMtime(file);
      return mtime ? { file, mtime } : null;
    }),
  );
  return ranked
    .filter((entry): entry is RankedSessionFile => entry !== null)
    .sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
}

async function readPiImportableSession(
  options: PiSessionDescriptorReadOptions,
): Promise<ImportableProviderSession | null> {
  const descriptor = await readPiSessionDescriptor(options);
  if (!descriptor) return null;

  return {
    providerHandleId: options.filePath,
    cwd: descriptor.cwd,
    title: descriptor.title,
    firstPromptPreview: normalizePromptPreview(descriptor.firstUserMessage),
    lastPromptPreview: normalizePromptPreview(
      descriptor.lastUserMessage ?? descriptor.firstUserMessage,
    ),
    lastActivityAt: descriptor.lastActivityAt,
  };
}

async function readPiSessionDescriptor({
  filePath,
  reader = sessionFileReader,
  matchesCwd,
}: PiSessionDescriptorReadOptions): Promise<PiSessionDescriptor | null> {
  const headChunk = await reader.readHead(filePath);
  if (!headChunk) return null;
  const header = parseSessionHeader(headChunk.split(/\r?\n/u, 1)[0]?.trim() ?? "");
  if (!header) return null;
  // Workspace misses need only the header, even when the match is an older file.
  if (matchesCwd && !matchesCwd(header.cwd)) return null;

  const tail = await reader.readTail(filePath).catch(() => "");
  const tailInfo = parseSessionTail(tail);
  const headInfo = parseSessionHeadFromChunk(headChunk);
  const title = tailInfo.title ?? headInfo.title ?? headInfo.firstUserMessage;
  const model = tailInfo.model ?? headInfo.model;
  const thinkingOptionId = tailInfo.thinkingOptionId ?? headInfo.thinkingOptionId;
  const lastActivityAt =
    tailInfo.lastActivityAt ?? (await readFileMtime(filePath)) ?? header.createdAt ?? new Date(0);

  return {
    cwd: header.cwd,
    title,
    firstUserMessage: headInfo.firstUserMessage,
    lastUserMessage: tailInfo.lastUserMessage,
    lastActivityAt,
    model,
    thinkingOptionId,
  };
}

function toPiImportSessionConfig(descriptor: PiSessionDescriptor): PiImportSessionConfig {
  return {
    ...(descriptor.model ? { model: descriptor.model } : {}),
    ...(descriptor.thinkingOptionId ? { thinkingOptionId: descriptor.thinkingOptionId } : {}),
  };
}

async function readHeadChunk(filePath: string): Promise<string | null> {
  const handle = await open(filePath, "r").catch(() => null);
  if (!handle) return null;
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return null;
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseSessionHeadFromChunk(chunk: string): PiSessionHead {
  let title: string | null = null;
  let firstUserMessage: string | null = null;
  let model: string | null = null;
  let thinkingOptionId: string | null = null;
  let lineCount = 0;

  for (const rawLine of chunk.split(/\r?\n/u)) {
    lineCount += 1;
    const entry = parseJsonRecord(rawLine.trim());
    if (!entry) continue;

    if (entry.type === "session_info") {
      title = readNonEmptyString(entry.name) ?? title;
    }
    model = extractModel(entry) ?? model;
    thinkingOptionId = extractThinkingOptionId(entry) ?? thinkingOptionId;

    if (!firstUserMessage && entry.type === "message" && isRecord(entry.message)) {
      if (entry.message.role === "user") {
        firstUserMessage = extractMessageText(entry.message.content);
      }
    }

    if (title && firstUserMessage && model && thinkingOptionId) {
      break;
    }
    if (lineCount >= FULL_SCAN_LINE_LIMIT && firstUserMessage) {
      break;
    }
  }

  return { title, firstUserMessage, model, thinkingOptionId };
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
  let model: string | null = null;
  let thinkingOptionId: string | null = null;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseJsonRecord(lines[index].trim());
    if (!entry) continue;

    if (!title && entry.type === "session_info") {
      title = readNonEmptyString(entry.name);
    }
    if (!model) {
      model = extractModel(entry);
    }

    if (!thinkingOptionId) {
      thinkingOptionId = extractThinkingOptionId(entry);
    }

    const entryTimestamp = parseDate(entry.timestamp);
    if (!fallbackTimestamp && entryTimestamp) {
      fallbackTimestamp = entryTimestamp;
    }

    if (entry.type !== "message") continue;

    if (!lastActivityAt && entryTimestamp) {
      lastActivityAt = entryTimestamp;
    }

    if (!lastUserMessage && isRecord(entry.message) && entry.message.role === "user") {
      lastUserMessage = extractMessageText(entry.message.content);
    }
  }

  return {
    title,
    lastActivityAt: lastActivityAt ?? fallbackTimestamp,
    lastUserMessage,
    model,
    thinkingOptionId,
  };
}

function extractModel(entry: Record<string, unknown>): string | null {
  if (entry.type === "model_change") {
    return buildModelId(entry.provider, entry.modelId);
  }

  if (entry.type === "message" && isRecord(entry.message)) {
    return buildModelId(entry.message.provider, entry.message.model);
  }

  return null;
}

function extractThinkingOptionId(entry: Record<string, unknown>): string | null {
  return entry.type === "thinking_level_change" ? readNonEmptyString(entry.thinkingLevel) : null;
}

function buildModelId(provider: unknown, modelId: unknown): string | null {
  const providerName = readNonEmptyString(provider);
  const modelName = readNonEmptyString(modelId);
  if (!providerName || !modelName) {
    return null;
  }
  return `${providerName}/${modelName}`;
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

function normalizePromptPreview(text: string | null): string | null {
  const normalized = text?.trim().replace(/\s+/g, " ") ?? "";
  if (!normalized) return null;
  return normalized.length > 160 ? normalized.slice(0, 160) : normalized;
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
