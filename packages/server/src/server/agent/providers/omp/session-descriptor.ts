import { homedir } from "node:os";
import path from "node:path";

import type {
  ImportableProviderSession,
  ListImportableSessionsOptions,
} from "../../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { createRealpathAwarePathMatcher } from "../../../../utils/path.js";
import {
  createLaunchFileSystem,
  type LaunchFileSystem,
} from "../../../devcontainer/launch-filesystem.js";
import type { ProcessLaunchStrategy } from "../../../devcontainer/launch-strategy.js";

const OMP_CONFIG_DIR_NAME = ".omp";
const OMP_AGENT_DIR_ENV = "OMP_AGENT_DIR";
const OMP_SESSION_DIR_ENV = "OMP_SESSION_DIR";
// Import listing intentionally bounds header parsing to this window. Sessions
// with unusually large preambles may omit their first-prompt preview.
const HEAD_BYTES = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const FULL_SCAN_LINE_LIMIT = 2_000;
// Rank all discovered files cheaply, then parse only a bounded recent window.
// OMP keeps nested completed-subagent transcripts importable, so discovery
// remains recursive rather than applying Pi's historical parent-only depth cap.
const IMPORT_CANDIDATE_OVERSCAN = 40;
const IMPORT_CANDIDATE_MIN = 400;
// Deep enough for nested subagent transcripts without walking a whole HOME.
const SESSION_SEARCH_DEPTH = 8;

interface OmpSessionDescriptorOptions extends ListImportableSessionsOptions {
  sessionDir?: string;
  runtimeSettings?: ProviderRuntimeSettings;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

interface OmpSessionHeader {
  sessionId: string;
  cwd: string;
  createdAt: Date | null;
}

interface OmpSessionTail {
  title: string | null;
  lastActivityAt: Date | null;
  lastUserMessage: string | null;
  model: string | null;
  thinkingOptionId: string | null;
}

interface OmpSessionHead {
  title: string | null;
  firstUserMessage: string | null;
  model: string | null;
  thinkingOptionId: string | null;
}

interface OmpSessionDescriptor {
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

export interface OmpImportSessionConfig {
  model?: string;
  thinkingOptionId?: string;
}

export async function listOmpImportableSessions(
  options: OmpSessionDescriptorOptions = {},
): Promise<ImportableProviderSession[]> {
  // For a container workspace the sessions are the container's: written by the
  // agent inside it, under its HOME. Reading the host's would list another
  // machine's conversations.
  const files = createLaunchFileSystem(options.launchStrategy);
  const sessionsDir = await resolveOmpSessionsDir(options, files);
  // Session records carry the cwd the agent ran in, which inside a container
  // is the container's path rather than the host's.
  const matchCwd =
    options.cwd && options.launchStrategy?.isIsolated
      ? options.launchStrategy.resolveCwd(options.cwd)
      : options.cwd;
  const matchesCwd = matchCwd ? createRealpathAwarePathMatcher(matchCwd) : null;
  const limit = options.limit ?? 20;
  const ranked = await rankSessionFilesByMtime(files, sessionsDir);
  const candidateLimit = Math.max(limit * IMPORT_CANDIDATE_OVERSCAN, IMPORT_CANDIDATE_MIN);
  const candidates = matchesCwd ? ranked : ranked.slice(0, candidateLimit);
  const sessions: ImportableProviderSession[] = [];

  for (const entry of candidates) {
    const session = await readOmpImportableSession(files, entry.file);
    if (!session) continue;
    if (matchesCwd && !matchesCwd(session.cwd)) continue;
    sessions.push(session);
    if (sessions.length >= limit) {
      break;
    }
  }

  return sessions.sort(
    (left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime(),
  );
}

export async function readOmpImportSessionConfig(
  filePath: string,
  launchStrategy?: ProcessLaunchStrategy,
): Promise<OmpImportSessionConfig> {
  // The transcript being imported lives wherever the agent wrote it.
  const descriptor = await readOmpSessionDescriptor(
    createLaunchFileSystem(launchStrategy),
    filePath,
  );
  if (!descriptor) return {};
  return toOmpImportSessionConfig(descriptor);
}

async function resolveOmpSessionsDir(
  options: OmpSessionDescriptorOptions,
  files: LaunchFileSystem,
): Promise<string> {
  // The container has its own HOME and its own settings file; the daemon's
  // environment says nothing about either.
  const env = files.isIsolated ? {} : (options.env ?? process.env);
  const homeDir = files.isIsolated ? await files.homeDir() : (options.homeDir ?? homedir());
  const baseDir =
    options.cwd && options.launchStrategy?.isIsolated
      ? options.launchStrategy.resolveCwd(options.cwd)
      : (options.cwd ?? process.cwd());

  if (options.sessionDir?.trim()) {
    return resolveConfigPath(options.sessionDir, { baseDir, homeDir });
  }

  const agentDir = resolveOmpAgentDir({ runtimeSettings: options.runtimeSettings, env, homeDir });

  const envSessionDir =
    options.runtimeSettings?.env?.[OMP_SESSION_DIR_ENV] ?? env[OMP_SESSION_DIR_ENV];
  if (envSessionDir?.trim()) {
    return resolveConfigPath(envSessionDir, { baseDir, homeDir });
  }

  const settingsSessionDir = await readConfiguredSessionDir({
    agentDir,
    cwd: baseDir,
    files,
  });
  if (settingsSessionDir?.trim()) {
    return resolveConfigPath(settingsSessionDir, { baseDir, homeDir });
  }

  return path.join(agentDir, "sessions");
}

function resolveOmpAgentDir(input: {
  runtimeSettings?: ProviderRuntimeSettings;
  env: NodeJS.ProcessEnv;
  homeDir: string;
}): string {
  const configured =
    input.runtimeSettings?.env?.[OMP_AGENT_DIR_ENV] ?? input.env[OMP_AGENT_DIR_ENV];
  if (configured?.trim()) {
    return resolveConfigPath(configured, { baseDir: process.cwd(), homeDir: input.homeDir });
  }
  return path.join(input.homeDir, OMP_CONFIG_DIR_NAME, "agent");
}

async function readConfiguredSessionDir(input: {
  agentDir: string;
  cwd: string | undefined;
  files: LaunchFileSystem;
}): Promise<string | null> {
  const values = await Promise.all([
    readSessionDirFromSettings(input.files, path.join(input.agentDir, "settings.json")),
    input.cwd
      ? readSessionDirFromSettings(
          input.files,
          path.join(input.cwd, OMP_CONFIG_DIR_NAME, "settings.json"),
        )
      : null,
  ]);
  return values[1] ?? values[0] ?? null;
}

async function readSessionDirFromSettings(
  files: LaunchFileSystem,
  settingsPath: string,
): Promise<string | null> {
  try {
    const content = await files.readFile(settingsPath);
    if (content === null) return null;
    const parsed = JSON.parse(content) as unknown;
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

/**
 * Newest first. OMP keeps nested completed-subagent transcripts importable, so
 * discovery stays recursive rather than applying Pi's parent-only depth cap.
 */
async function rankSessionFilesByMtime(
  files: LaunchFileSystem,
  root: string,
): Promise<RankedSessionFile[]> {
  const found = await files.listFiles(root, { suffix: ".jsonl", maxDepth: SESSION_SEARCH_DEPTH });
  return found
    .map((entry) => ({ file: entry.path, mtime: new Date(entry.mtimeMs) }))
    .sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
}

async function readOmpImportableSession(
  files: LaunchFileSystem,
  filePath: string,
): Promise<ImportableProviderSession | null> {
  const descriptor = await readOmpSessionDescriptor(files, filePath);
  if (!descriptor) return null;

  return {
    providerHandleId: filePath,
    cwd: descriptor.cwd,
    title: descriptor.title,
    firstPromptPreview: normalizePromptPreview(descriptor.firstUserMessage),
    lastPromptPreview: normalizePromptPreview(
      descriptor.lastUserMessage ?? descriptor.firstUserMessage,
    ),
    lastActivityAt: descriptor.lastActivityAt,
  };
}

async function readOmpSessionDescriptor(
  files: LaunchFileSystem,
  filePath: string,
): Promise<OmpSessionDescriptor | null> {
  // OMP may emit title/session_info lines before the session header.
  const headChunk = await files.readHead(filePath, HEAD_BYTES);
  if (!headChunk) return null;
  const header = parseSessionHeaderFromChunk(headChunk);
  if (!header) return null;

  const tail = (await files.readTail(filePath, TAIL_BYTES)) ?? "";
  const tailInfo = parseSessionTail(tail);
  const headInfo = parseSessionHeadFromChunk(headChunk);
  const title =
    tailInfo.title ??
    headInfo.title ??
    readReadableSessionTitleFromPath(filePath) ??
    headInfo.firstUserMessage;
  const model = tailInfo.model ?? headInfo.model;
  const thinkingOptionId = tailInfo.thinkingOptionId ?? headInfo.thinkingOptionId;
  const lastActivityAt =
    tailInfo.lastActivityAt ??
    (await readFileMtime(files, filePath)) ??
    header.createdAt ??
    new Date(0);

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

function toOmpImportSessionConfig(descriptor: OmpSessionDescriptor): OmpImportSessionConfig {
  return {
    ...(descriptor.model ? { model: descriptor.model } : {}),
    ...(descriptor.thinkingOptionId ? { thinkingOptionId: descriptor.thinkingOptionId } : {}),
  };
}

function parseSessionHeaderFromChunk(chunk: string): OmpSessionHeader | null {
  for (const line of chunk.split(/\r?\n/u)) {
    const header = parseSessionHeader(line.trim());
    if (header) return header;
  }
  return null;
}

function parseSessionHeadFromChunk(chunk: string): OmpSessionHead {
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
    if (entry.type === "title") {
      title = readNonEmptyString(entry.title) ?? title;
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

async function readFileMtime(files: LaunchFileSystem, filePath: string): Promise<Date | null> {
  const [entry] = await files.listFiles(path.dirname(filePath), {
    suffix: path.basename(filePath),
    maxDepth: 1,
  });
  return entry ? new Date(entry.mtimeMs) : null;
}

function parseSessionHeader(firstLine: string): OmpSessionHeader | null {
  const entry = parseJsonRecord(firstLine);
  if (!entry || entry.type !== "session") return null;
  const sessionId = typeof entry.id === "string" ? entry.id : null;
  const cwd = typeof entry.cwd === "string" ? entry.cwd : null;
  if (!sessionId || !cwd) return null;
  const createdAt = parseDate(entry.timestamp);
  return { sessionId, cwd, createdAt };
}

function parseSessionTail(tail: string): OmpSessionTail {
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
    if (!title && entry.type === "title") {
      title = readNonEmptyString(entry.title);
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
    // Pi records provider + modelId; OMP records a combined model string.
    return buildModelId(entry.provider, entry.modelId) ?? readNonEmptyString(entry.model);
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

function readReadableSessionTitleFromPath(filePath: string): string | null {
  const stem = path.basename(filePath, ".jsonl").trim();
  if (!stem) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}[-:]\d{2}[-:]\d{2}/u.test(stem)) {
    return null;
  }
  if (/^[0-9a-f]{8,}$/iu.test(stem)) {
    return null;
  }
  return stem;
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
