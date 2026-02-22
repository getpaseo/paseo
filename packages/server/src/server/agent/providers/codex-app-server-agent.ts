import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentMode,
  AgentModelDefinition,
  McpServerConfig,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPromptContentBlock,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentTimelineItem,
  ToolCallTimelineItem,
  AgentUsage,
  ListModelsOptions,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
} from "../agent-sdk-types.js";
import type { Logger } from "pino";

import { execSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import { loadCodexPersistedTimeline } from "./codex-rollout-timeline.js";
import {
  mapCodexRolloutToolCall,
  mapCodexToolCallFromThreadItem,
} from "./codex/tool-call-mapper.js";
import {
  applyProviderEnv,
  isProviderCommandAvailable,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";


const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const TURN_START_TIMEOUT_MS = 90 * 1000;
const CODEX_PROVIDER = "codex" as const;
const CODEX_IMAGE_ATTACHMENT_DIR = "paseo-attachments";

const CODEX_APP_SERVER_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const CODEX_MODES: AgentMode[] = [
  {
    id: "read-only",
    label: "Read Only",
    description:
      "Read files and answer questions. Manual approval required for edits, commands, or network ops.",
  },
  {
    id: "auto",
    label: "Auto",
    description:
      "Edit files and run commands but still request approval before escalating scope.",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Edit files, run commands, and access the network without additional prompts.",
  },
];

const DEFAULT_CODEX_MODE_ID = "auto";

const MODE_PRESETS: Record<
  string,
  { approvalPolicy: string; sandbox: string; networkAccess?: boolean }
> = {
  "read-only": {
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  auto: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  "full-access": {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  },
};

function validateCodexMode(modeId: string): void {
  if (!(modeId in MODE_PRESETS)) {
    const validModes = Object.keys(MODE_PRESETS).join(", ");
    throw new Error(
      `Invalid Codex mode "${modeId}". Valid modes are: ${validModes}`
    );
  }
}

function normalizeCodexThinkingOptionId(
  thinkingOptionId: string | null | undefined
): string | undefined {
  if (typeof thinkingOptionId !== "string") {
    return undefined;
  }
  const normalized = thinkingOptionId.trim();
  if (!normalized || normalized === "default") {
    return undefined;
  }
  return normalized;
}

function normalizeCodexModelId(modelId: string | null | undefined): string | undefined {
  if (typeof modelId !== "string") {
    return undefined;
  }
  const normalized = modelId.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized;
}

type CodexConfiguredDefaults = {
  model?: string;
  thinkingOptionId?: string;
};

function mergeCodexConfiguredDefaults(
  primary: CodexConfiguredDefaults,
  fallback: CodexConfiguredDefaults
): CodexConfiguredDefaults {
  return {
    model: primary.model ?? fallback.model,
    thinkingOptionId: primary.thinkingOptionId ?? fallback.thinkingOptionId,
  };
}

function resolveCodexBinary(): string {
  try {
    const codexPath = execSync("which codex", { encoding: "utf8" }).trim();
    if (codexPath) {
      return codexPath;
    }
  } catch {
    // Fall through to error
  }
  throw new Error(
    "Codex CLI not found. Please install codex globally: npm install -g @openai/codex"
  );
}

function resolveCodexLaunchPrefix(
  runtimeSettings?: ProviderRuntimeSettings
): { command: string; args: string[] } {
  return resolveProviderCommandPrefix(
    runtimeSettings?.command,
    resolveCodexBinary
  );
}

function resolveCodexHomeDir(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i]!;
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < args.length) {
        const next = args[i + 1]!;
        if (next === quote || next === "\\" || next === "n" || next === "t") {
          i += 1;
          current += next === "n" ? "\n" : next === "t" ? "\t" : next;
          continue;
        }
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

function parseFrontMatter(markdown: string): {
  frontMatter: Record<string, string>;
  body: string;
} {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") {
    return { frontMatter: {}, body: markdown };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      end = i;
      break;
    }
  }
  if (end === -1) {
    return { frontMatter: {}, body: markdown };
  }
  const metaLines = lines.slice(1, end);
  const body = lines.slice(end + 1).join("\n");
  const frontMatter: Record<string, string> = {};
  for (const line of metaLines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf(":");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    value = value.replace(/^['"]/, "").replace(/['"]$/, "");
    if (key && value) {
      frontMatter[key] = value;
    }
  }
  return { frontMatter, body };
}

async function listCodexCustomPrompts(): Promise<AgentSlashCommand[]> {
  const codexHome = resolveCodexHomeDir();
  const promptsDir = path.join(codexHome, "prompts");
  let entries: Dirent[];
  try {
    entries = await fs.readdir(promptsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const commands: AgentSlashCommand[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.endsWith(".md")) {
      continue;
    }
    const name = entry.name.slice(0, -".md".length);
    if (!name) {
      continue;
    }
    const fullPath = path.join(promptsDir, entry.name);
    let content: string;
    try {
      content = await fs.readFile(fullPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseFrontMatter(content);
    const description = parsed.frontMatter["description"] ?? "Custom prompt";
    const argumentHint =
      parsed.frontMatter["argument-hint"] ??
      parsed.frontMatter["argument_hint"] ??
      "";
    commands.push({
      name: `prompts:${name}`,
      description,
      argumentHint,
    });
  }
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function listCodexSkills(cwd: string): Promise<AgentSlashCommand[]> {
  const candidates: string[] = [];
  candidates.push(path.join(cwd, ".codex", "skills"));

  const repoRoot = (() => {
    try {
      const output = execSync("git rev-parse --show-toplevel", {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const trimmed = output.trim();
      return trimmed ? trimmed : null;
    } catch {
      return null;
    }
  })();
  if (repoRoot) {
    candidates.push(path.join(path.dirname(cwd), ".codex", "skills"));
    candidates.push(path.join(repoRoot, ".codex", "skills"));
  }

  candidates.push(path.join(resolveCodexHomeDir(), "skills"));

  const commandsByName = new Map<string, AgentSlashCommand>();

  for (const dir of candidates) {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) {
        continue;
      }
      const skillDir = path.join(dir, entry.name);
      const skillPath = path.join(skillDir, "SKILL.md");
      let content: string;
      try {
        content = await fs.readFile(skillPath, "utf8");
      } catch {
        continue;
      }
      const { frontMatter } = parseFrontMatter(content);
      const name = frontMatter["name"];
      const description = frontMatter["description"];
      if (!name || !description) {
        continue;
      }
      if (!commandsByName.has(name)) {
        commandsByName.set(name, {
          name,
          description,
          argumentHint: "",
        });
      }
    }
  }

  return Array.from(commandsByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandCodexCustomPrompt(template: string, args: string | undefined): string {
  const trimmedArgs = args ? args.trim() : "";
  const tokens = trimmedArgs ? tokenizeCommandArgs(trimmedArgs) : [];
  const named: Record<string, string> = {};
  const positional: string[] = [];

  for (const token of tokens) {
    const idx = token.indexOf("=");
    if (idx > 0) {
      const key = token.slice(0, idx);
      const value = token.slice(idx + 1);
      if (key) {
        named[key] = value;
        continue;
      }
    }
    positional.push(token);
  }

  const dollarPlaceholder = "__CODEX_DOLLAR_PLACEHOLDER__";
  let out = template.split("$$").join(dollarPlaceholder);

  out = out.split("$ARGUMENTS").join(trimmedArgs);

  for (let i = 1; i <= 9; i += 1) {
    const value = positional[i - 1] ?? "";
    out = out.split(`$${i}`).join(value);
  }

  const namedKeys = Object.keys(named).sort((a, b) => b.length - a.length);
  for (const key of namedKeys) {
    const value = named[key] ?? "";
    const re = new RegExp(`\\$${escapeRegExp(key)}\\b`, "g");
    out = out.replace(re, value);
  }

  out = out.split(dollarPlaceholder).join("$");
  return out;
}

interface CodexMcpServerConfig {
  url?: string;
  http_headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  tool_timeout_sec?: number;
}

function toCodexMcpConfig(config: McpServerConfig): CodexMcpServerConfig {
  switch (config.type) {
    case "stdio":
      return {
        command: config.command,
        args: config.args,
        env: config.env,
      };
    case "http":
      return {
        url: config.url,
        http_headers: config.headers,
      };
    case "sse":
      return {
        url: config.url,
        http_headers: config.headers,
      };
  }
}

class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: ((value: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T) {
    if (this.closed) {
      return;
    }
    if (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: item, done: false });
    } else {
      this.queue.push(item);
    }
  }

  end() {
    this.closed = true;
    while (this.resolvers.length > 0) {
      const resolve = this.resolvers.shift()!;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T, void> {
    return {
      next: (): Promise<IteratorResult<T, void>> => {
        if (this.queue.length > 0) {
          const value = this.queue.shift()!;
          return Promise.resolve({ value, done: false });
        }
        if (this.closed) {
          return Promise.resolve({ value: undefined, done: true });
        }
        return new Promise<IteratorResult<T, void>>((resolve) => {
          this.resolvers.push(resolve);
        });
      },
    };
  }
}

type JsonRpcRequest = {
  id: number;
  method: string;
  params?: unknown;
};

type JsonRpcResponse = {
  id: number;
  result?: unknown;
  error?: { code?: number; message: string };
};

type JsonRpcNotification = {
  method: string;
  params?: unknown;
};

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type RequestHandler = (params: unknown) => Promise<unknown> | unknown;

type NotificationHandler = (method: string, params: unknown) => void;

// Codex app-server API response types
interface CodexModel {
  id: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  model?: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: string[];
}

interface CodexModelListResponse {
  data?: CodexModel[];
}

interface CodexThreadStartResponse {
  thread?: { id?: string };
}

class CodexAppServerClient {
  private readonly rl: readline.Interface;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly requestHandlers = new Map<string, RequestHandler>();
  private notificationHandler: NotificationHandler | null = null;
  private nextId = 1;
  private disposed = false;
  private stderrBuffer = "";

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly logger: Logger
  ) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > 8192) {
        this.stderrBuffer = this.stderrBuffer.slice(-8192);
      }
    });

    child.on("exit", (code, signal) => {
      const message =
        code === 0 && !signal
          ? "Codex app-server exited"
          : `Codex app-server exited with code ${code ?? "null"} and signal ${signal ?? "null"}`;
      const error = new Error(`${message}\n${this.stderrBuffer}`.trim());
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(error);
      }
      this.pending.clear();
      this.disposed = true;
    });
  }

  setNotificationHandler(handler: NotificationHandler): void {
    this.notificationHandler = handler;
  }

  setRequestHandler(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  request(method: string, params?: unknown, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("Codex app-server client is closed"));
    }
    const id = this.nextId++;
    const payload: JsonRpcRequest = { id, method, params };
    const serialized = JSON.stringify(payload);
    this.child.stdin.write(`${serialized}\n`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out for ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.disposed) {
      return;
    }
    const payload: JsonRpcNotification = { method, params };
    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rl.close();
    try {
      this.child.kill();
    } catch {
      // ignore
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line);
    } catch (error) {
      this.logger.warn({ error, line }, "Failed to parse Codex app-server JSON");
      return;
    }

    if (typeof (msg as JsonRpcResponse).id === "number") {
      const id = (msg as JsonRpcResponse).id;
      if ((msg as JsonRpcResponse).result !== undefined || (msg as JsonRpcResponse).error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if ((msg as JsonRpcResponse).error) {
          pending.reject(new Error((msg as JsonRpcResponse).error?.message ?? "Unknown error"));
        } else {
          pending.resolve((msg as JsonRpcResponse).result);
        }
        return;
      }

      // Server-initiated request
      if (typeof (msg as JsonRpcRequest).method === "string") {
        const request = msg as JsonRpcRequest;
        const handler = this.requestHandlers.get(request.method);
        try {
          const result = handler ? await handler(request.params) : {};
          const response: JsonRpcResponse = { id: request.id, result };
          this.child.stdin.write(`${JSON.stringify(response)}\n`);
        } catch (error) {
          const response: JsonRpcResponse = {
            id: request.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          };
          this.child.stdin.write(`${JSON.stringify(response)}\n`);
        }
        return;
      }
    }

    if (typeof (msg as JsonRpcNotification).method === "string") {
      const notification = msg as JsonRpcNotification;
      this.notificationHandler?.(notification.method, notification.params);
    }
  }
}

function toAgentUsage(tokenUsage: unknown): AgentUsage | undefined {
  if (!tokenUsage || typeof tokenUsage !== "object") return undefined;
  const usage = tokenUsage as { last?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } };
  return {
    inputTokens: usage.last?.inputTokens,
    cachedInputTokens: usage.last?.cachedInputTokens,
    outputTokens: usage.last?.outputTokens,
  };
}

function extractUserText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const obj = item as { type?: string; text?: string };
      if (obj.type === "text" && typeof obj.text === "string") {
        parts.push(obj.text);
      }
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function parsePlanTextToTodoItems(text: string): { text: string; completed: boolean }[] {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    return [{ text, completed: false }];
  }
  return lines.map((line) => ({
    text: line.replace(/^[-*]\s+/, ""),
    completed: false,
  }));
}

function planStepsToTodoItems(steps: Array<{ step: string; status: string }>): {
  text: string;
  completed: boolean;
}[] {
  return steps.map((entry) => ({
    text: entry.step,
    completed: entry.status === "completed",
  }));
}

type CodexPatchFileChange = {
  path: string;
  kind?: string;
  content?: string;
};

function extractPatchLikeText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const candidates = [
    record.diff,
    record.patch,
    record.unified_diff,
    record.unifiedDiff,
    record.content,
    record.newString,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function normalizeCodexThreadItemType(rawType: string | undefined): string | undefined {
  if (!rawType) {
    return rawType;
  }
  switch (rawType) {
    case "UserMessage":
      return "userMessage";
    case "AgentMessage":
      return "agentMessage";
    case "Reasoning":
      return "reasoning";
    case "Plan":
      return "plan";
    case "CommandExecution":
      return "commandExecution";
    case "FileChange":
      return "fileChange";
    case "McpToolCall":
      return "mcpToolCall";
    case "WebSearch":
      return "webSearch";
    default:
      return rawType;
  }
}

function normalizeCodexCommandValue(
  value: unknown
): string | string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.length) {
      return null;
    }
    const wrapperMatch = trimmed.match(
      /^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/
    );
    if (!wrapperMatch) {
      return trimmed;
    }
    const candidate = wrapperMatch[1]?.trim() ?? "";
    if (!candidate.length) {
      return trimmed;
    }
    if (
      (candidate.startsWith('"') && candidate.endsWith('"')) ||
      (candidate.startsWith("'") && candidate.endsWith("'"))
    ) {
      return candidate.slice(1, -1);
    }
    return candidate;
  }
  if (!Array.isArray(value)) {
    return null;
  }
  const parts = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  if (parts.length === 0) {
    return null;
  }
  if (parts.length >= 3 && (parts[1] === "-lc" || parts[1] === "-c")) {
    return parts[2] ?? parts;
  }
  return parts;
}

function parseCodexPatchChanges(changes: unknown): CodexPatchFileChange[] {
  if (!changes || typeof changes !== "object") {
    return [];
  }

  if (Array.isArray(changes)) {
    return changes
      .map((entry): CodexPatchFileChange | null => {
        if (!entry || typeof entry !== "object") {
          return null;
        }
        const record = entry as Record<string, unknown>;
        const pathValue =
          typeof record.path === "string" && record.path.trim().length > 0
            ? record.path.trim()
            : "";
        if (!pathValue) {
          return null;
        }
        return {
          path: pathValue,
          kind:
            (typeof record.kind === "string" && record.kind) ||
            (typeof record.type === "string" && record.type) ||
            undefined,
          content: extractPatchLikeText(record),
        };
      })
      .filter((entry): entry is CodexPatchFileChange => entry !== null);
  }

  const recordChanges = changes as Record<string, unknown>;
  if (typeof recordChanges.path === "string" && recordChanges.path.trim().length > 0) {
    return [
      {
        path: recordChanges.path.trim(),
        kind:
          (typeof recordChanges.kind === "string" && recordChanges.kind) ||
          (typeof recordChanges.type === "string" && recordChanges.type) ||
          undefined,
        content: extractPatchLikeText(recordChanges),
      },
    ];
  }

  return Object.entries(recordChanges)
    .map(([path, value]): CodexPatchFileChange | null => {
      const normalizedPath = path.trim();
      if (!normalizedPath) {
        return null;
      }
      return {
        path: normalizedPath,
        kind:
          value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"
            ? ((value as { type?: string }).type ?? undefined)
            : undefined,
        content: extractPatchLikeText(value),
      };
    })
    .filter((entry): entry is CodexPatchFileChange => entry !== null);
}

function codexPatchTextFields(
  text: string | null | undefined
): { patch?: string; content?: string } {
  if (typeof text !== "string") {
    return {};
  }
  const normalized = text.trimStart();
  const looksLikeUnifiedDiff =
    normalized.startsWith("diff --git") ||
    normalized.startsWith("@@") ||
    normalized.startsWith("--- ") ||
    normalized.startsWith("+++ ");
  return looksLikeUnifiedDiff ? { patch: text } : { content: text };
}

function toRunningToolCall(item: ToolCallTimelineItem): ToolCallTimelineItem {
  return {
    ...item,
    status: "running",
    error: null,
  };
}

function isEditToolCallWithoutContent(item: ToolCallTimelineItem): boolean {
  if (item.type !== "tool_call") {
    return false;
  }
  if (item.detail.type !== "edit") {
    return false;
  }
  const hasDiff =
    typeof item.detail.unifiedDiff === "string" &&
    item.detail.unifiedDiff.trim().length > 0;
  const hasNewString =
    typeof item.detail.newString === "string" &&
    item.detail.newString.trim().length > 0;
  return !hasDiff && !hasNewString;
}

function decodeCodexOutputDeltaChunk(chunk: string): string {
  const trimmed = chunk.trim();
  if (trimmed.length === 0) {
    return chunk;
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(trimmed) || trimmed.length % 4 !== 0) {
    return chunk;
  }

  try {
    const decoded = Buffer.from(trimmed, "base64").toString("utf8");
    if (decoded.length === 0) {
      return chunk;
    }
    const normalizedInput = trimmed.replace(/=+$/, "");
    const normalizedRoundTrip = Buffer.from(decoded, "utf8")
      .toString("base64")
      .replace(/=+$/, "");
    return normalizedRoundTrip === normalizedInput ? decoded : chunk;
  } catch {
    return chunk;
  }
}

function mapCodexExecNotificationToToolCall(params: {
  callId?: string | null;
  command: unknown;
  cwd?: string | null;
  output?: string | null;
  exitCode?: number | null;
  success?: boolean | null;
  stderr?: string | null;
  running: boolean;
}): ToolCallTimelineItem | null {
  const command = normalizeCodexCommandValue(params.command);
  if (!command) {
    return null;
  }
  const isFailure =
    params.running
      ? false
      : params.success === false ||
        (typeof params.exitCode === "number" && params.exitCode !== 0);
  const output =
    params.running
      ? null
      : {
          command,
          ...(params.output !== null && params.output !== undefined
            ? { output: params.output }
            : {}),
          ...(params.exitCode !== null && params.exitCode !== undefined
            ? { exitCode: params.exitCode }
            : {}),
        };
  const mapped = mapCodexRolloutToolCall({
    callId: params.callId ?? null,
    name: "shell",
    input: {
      command,
      ...(params.cwd ? { cwd: params.cwd } : {}),
    },
    output,
    error: isFailure
      ? { message: params.stderr?.trim() || "Command failed" }
      : null,
    cwd: params.cwd ?? null,
  });
  if (!mapped) {
    return null;
  }
  return params.running ? toRunningToolCall(mapped) : mapped;
}

function mapCodexPatchNotificationToToolCall(params: {
  callId?: string | null;
  changes: unknown;
  cwd?: string | null;
  stdout?: string | null;
  stderr?: string | null;
  success?: boolean | null;
  running: boolean;
}): ToolCallTimelineItem | null {
  const files = parseCodexPatchChanges(params.changes);
  const firstPath = files[0]?.path;
  const firstPatchText = files
    .map((file) => file.content?.trim())
    .find((value): value is string => typeof value === "string" && value.length > 0);
  const patchText = firstPatchText;
  const patchFields = codexPatchTextFields(patchText);
  const mapped = mapCodexRolloutToolCall({
    callId: params.callId ?? null,
    name: "apply_patch",
    input: firstPath
      ? {
          path: firstPath,
          ...patchFields,
          files: files.map((file) => ({ path: file.path, kind: file.kind })),
        }
      : {
          changes: params.changes ?? null,
          ...patchFields,
        },
    output: params.running
      ? null
      : {
          ...(files.length > 0
            ? {
                files: files.map((file) => ({
                  path: file.path,
                  ...(file.kind ? { kind: file.kind } : {}),
                  ...codexPatchTextFields(file.content ?? patchText),
                })),
              }
            : {}),
          ...(params.stdout ? { stdout: params.stdout } : {}),
          ...(params.stderr ? { stderr: params.stderr } : {}),
          ...(params.success !== null && params.success !== undefined
            ? { success: params.success }
            : {}),
        },
    error:
      params.running || params.success !== false
        ? null
        : { message: params.stderr?.trim() || "Patch apply failed" },
    cwd: params.cwd ?? null,
  });
  if (!mapped) {
    return null;
  }
  return params.running ? toRunningToolCall(mapped) : mapped;
}

function threadItemToTimeline(
  item: any,
  options?: { includeUserMessage?: boolean; cwd?: string | null }
): AgentTimelineItem | null {
  if (!item || typeof item !== "object") return null;
  const includeUserMessage = options?.includeUserMessage ?? true;
  const cwd = options?.cwd ?? null;
  const normalizedType = normalizeCodexThreadItemType(
    typeof item.type === "string" ? item.type : undefined
  );
  const normalizedItem =
    normalizedType && normalizedType !== item.type
      ? ({ ...item, type: normalizedType } as typeof item)
      : item;

  switch (normalizedType) {
    case "userMessage": {
      if (!includeUserMessage) {
        return null;
      }
      const text = extractUserText(normalizedItem.content) ?? "";
      return { type: "user_message", text };
    }
    case "agentMessage": {
      return { type: "assistant_message", text: normalizedItem.text ?? "" };
    }
    case "plan": {
      const text = normalizedItem.text ?? "";
      const items = parsePlanTextToTodoItems(text);
      return { type: "todo", items };
    }
    case "reasoning": {
      const summary = Array.isArray(normalizedItem.summary)
        ? normalizedItem.summary.join("\n")
        : "";
      const content = Array.isArray(normalizedItem.content)
        ? normalizedItem.content.join("\n")
        : "";
      const text = summary || content;
      return text ? { type: "reasoning", text } : null;
    }
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "webSearch":
      return mapCodexToolCallFromThreadItem(normalizedItem, { cwd });
    default:
      return null;
  }
}

function toSandboxPolicy(type: string, networkAccess?: boolean): Record<string, unknown> {
  switch (type) {
    case "read-only":
      return { type: "readOnly" };
    case "workspace-write":
      return { type: "workspaceWrite", networkAccess: networkAccess ?? false };
    case "danger-full-access":
      return { type: "dangerFullAccess" };
    default:
      return { type: "workspaceWrite", networkAccess: networkAccess ?? false };
  }
}

function getImageExtension(mimeType: string): string {
  switch (mimeType) {
    case "image/jpeg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/webp":
      return "webp";
    case "image/gif":
      return "gif";
    case "image/bmp":
      return "bmp";
    case "image/tiff":
      return "tiff";
    default:
      return "bin";
  }
}

type ImageDataPayload = { mimeType: string; data: string };

function normalizeImageData(mimeType: string, data: string): ImageDataPayload {
  if (data.startsWith("data:")) {
    const match = data.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
  }
  return { mimeType, data };
}

const ThreadStartedNotificationSchema = z.object({
  thread: z.object({ id: z.string() }).passthrough(),
}).passthrough();

const TurnStartedNotificationSchema = z.object({
  turn: z.object({ id: z.string() }).passthrough(),
}).passthrough();

const TurnCompletedNotificationSchema = z.object({
  turn: z
    .object({
      status: z.string(),
      error: z
        .object({
          message: z.string().optional(),
        })
        .passthrough()
        .nullable()
        .optional(),
    })
    .passthrough(),
}).passthrough();

const TurnPlanUpdatedNotificationSchema = z.object({
  plan: z.array(
    z
      .object({
        step: z.string().optional(),
        status: z.string().optional(),
      })
      .passthrough()
  ),
}).passthrough();

const TurnDiffUpdatedNotificationSchema = z.object({
  diff: z.string(),
}).passthrough();

const ThreadTokenUsageUpdatedNotificationSchema = z.object({
  tokenUsage: z.unknown(),
}).passthrough();

const ItemTextDeltaNotificationSchema = z.object({
  itemId: z.string(),
  delta: z.string(),
}).passthrough();

const ItemLifecycleNotificationSchema = z.object({
  item: z
    .object({
      id: z.string().optional(),
      type: z.string().optional(),
    })
    .passthrough(),
}).passthrough();

const CodexEventTurnAbortedNotificationSchema = z.object({
  msg: z
    .object({
      type: z.literal("turn_aborted"),
      reason: z.string().optional(),
    })
    .passthrough(),
}).passthrough();

const CodexEventTaskCompleteNotificationSchema = z.object({
  msg: z
    .object({
      type: z.literal("task_complete"),
    })
    .passthrough(),
}).passthrough();

const CodexEventItemLifecycleNotificationSchema = z.object({
  msg: z
    .object({
      type: z.enum(["item_started", "item_completed"]),
      item: z
        .object({
          id: z.string().optional(),
          type: z.string().optional(),
        })
        .passthrough(),
    })
    .passthrough(),
}).passthrough();

const CodexEventExecCommandBeginNotificationSchema = z.object({
  msg: z
    .object({
      type: z.literal("exec_command_begin"),
      call_id: z.string().optional(),
      command: z.unknown().optional(),
      cwd: z.string().optional(),
    })
    .passthrough(),
}).passthrough();

const CodexEventExecCommandEndNotificationSchema = z.object({
  msg: z
    .object({
      type: z.literal("exec_command_end"),
      call_id: z.string().optional(),
      command: z.unknown().optional(),
      cwd: z.string().optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
      aggregated_output: z.string().optional(),
      aggregatedOutput: z.string().optional(),
      formatted_output: z.string().optional(),
      exit_code: z.number().nullable().optional(),
      exitCode: z.number().nullable().optional(),
      success: z.boolean().optional(),
    })
    .passthrough(),
}).passthrough();

const CodexEventExecCommandOutputDeltaNotificationSchema = z.object({
  msg: z
    .object({
      type: z.literal("exec_command_output_delta"),
      call_id: z.string().optional(),
      stream: z.string().optional(),
      chunk: z.string().optional(),
      delta: z.string().optional(),
    })
    .passthrough(),
}).passthrough();

const CodexEventPatchApplyBeginNotificationSchema = z.object({
  msg: z
    .object({
      type: z.literal("patch_apply_begin"),
      call_id: z.string().optional(),
      changes: z.unknown().optional(),
    })
    .passthrough(),
}).passthrough();

const CodexEventPatchApplyEndNotificationSchema = z.object({
  msg: z
    .object({
      type: z.literal("patch_apply_end"),
      call_id: z.string().optional(),
      changes: z.unknown().optional(),
      stdout: z.string().optional(),
      stderr: z.string().optional(),
      success: z.boolean().optional(),
    })
    .passthrough(),
}).passthrough();

const ItemFileChangeOutputDeltaNotificationSchema = z.object({
  itemId: z.string(),
  delta: z.string().optional(),
  chunk: z.string().optional(),
}).passthrough();

const CodexEventTurnDiffNotificationSchema = z.object({
  msg: z
    .object({
      type: z.literal("turn_diff"),
      unified_diff: z.string().optional(),
      diff: z.string().optional(),
    })
    .passthrough(),
}).passthrough();

type ParsedCodexNotification =
  | { kind: "thread_started"; threadId: string }
  | { kind: "turn_started"; turnId: string }
  | { kind: "turn_completed"; status: string; errorMessage: string | null }
  | { kind: "plan_updated"; plan: Array<{ step: string | null; status: string | null }> }
  | { kind: "diff_updated"; diff: string }
  | { kind: "token_usage_updated"; tokenUsage: unknown }
  | { kind: "agent_message_delta"; itemId: string; delta: string }
  | { kind: "reasoning_delta"; itemId: string; delta: string }
  | {
      kind: "item_completed";
      source: "item" | "codex_event";
      item: { id?: string; type?: string; [key: string]: unknown };
    }
  | {
      kind: "item_started";
      source: "item" | "codex_event";
      item: { id?: string; type?: string; [key: string]: unknown };
    }
  | {
      kind: "exec_command_started";
      callId: string | null;
      command: unknown;
      cwd: string | null;
    }
  | {
      kind: "exec_command_completed";
      callId: string | null;
      command: unknown;
      cwd: string | null;
      output: string | null;
      exitCode: number | null;
      success: boolean | null;
      stderr: string | null;
    }
  | {
      kind: "exec_command_output_delta";
      callId: string | null;
      stream: string | null;
      chunk: string | null;
    }
  | {
      kind: "patch_apply_started";
      callId: string | null;
      changes: unknown;
    }
  | {
      kind: "patch_apply_completed";
      callId: string | null;
      changes: unknown;
      stdout: string | null;
      stderr: string | null;
      success: boolean | null;
    }
  | {
      kind: "file_change_output_delta";
      itemId: string;
      delta: string | null;
    }
  | { kind: "invalid_payload"; method: string; params: unknown }
  | { kind: "unknown_method"; method: string; params: unknown };

const CodexNotificationSchema = z.union([
  z.object({ method: z.literal("thread/started"), params: ThreadStartedNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({ kind: "thread_started", threadId: params.thread.id })
  ),
  z.object({ method: z.literal("thread/started"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({ method: z.literal("turn/started"), params: TurnStartedNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({ kind: "turn_started", turnId: params.turn.id })
  ),
  z.object({ method: z.literal("turn/started"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({ method: z.literal("turn/completed"), params: TurnCompletedNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "turn_completed",
      status: params.turn.status,
      errorMessage: params.turn.error?.message ?? null,
    })
  ),
  z.object({ method: z.literal("turn/completed"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({ method: z.literal("turn/plan/updated"), params: TurnPlanUpdatedNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "plan_updated",
      plan: params.plan.map((entry) => ({
        step: entry.step ?? null,
        status: entry.status ?? null,
      })),
    })
  ),
  z.object({ method: z.literal("turn/plan/updated"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({ method: z.literal("turn/diff/updated"), params: TurnDiffUpdatedNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({ kind: "diff_updated", diff: params.diff })
  ),
  z.object({ method: z.literal("turn/diff/updated"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("thread/tokenUsage/updated"),
    params: ThreadTokenUsageUpdatedNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({ kind: "token_usage_updated", tokenUsage: params.tokenUsage })
  ),
  z.object({ method: z.literal("thread/tokenUsage/updated"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({ method: z.literal("item/agentMessage/delta"), params: ItemTextDeltaNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "agent_message_delta",
      itemId: params.itemId,
      delta: params.delta,
    })
  ),
  z.object({ method: z.literal("item/agentMessage/delta"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("item/reasoning/summaryTextDelta"),
    params: ItemTextDeltaNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "reasoning_delta",
      itemId: params.itemId,
      delta: params.delta,
    })
  ),
  z.object({ method: z.literal("item/reasoning/summaryTextDelta"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({ method: z.literal("item/completed"), params: ItemLifecycleNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({ kind: "item_completed", source: "item", item: params.item })
  ),
  z.object({ method: z.literal("item/completed"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({ method: z.literal("item/started"), params: ItemLifecycleNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({ kind: "item_started", source: "item", item: params.item })
  ),
  z.object({ method: z.literal("item/started"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/item_started"),
    params: CodexEventItemLifecycleNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "item_started",
      source: "codex_event",
      item: params.msg.item,
    })
  ),
  z.object({ method: z.literal("codex/event/item_started"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/item_completed"),
    params: CodexEventItemLifecycleNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "item_completed",
      source: "codex_event",
      item: params.msg.item,
    })
  ),
  z.object({ method: z.literal("codex/event/item_completed"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/exec_command_begin"),
    params: CodexEventExecCommandBeginNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "exec_command_started",
      callId: params.msg.call_id ?? null,
      command: params.msg.command ?? null,
      cwd: params.msg.cwd ?? null,
    })
  ),
  z.object({ method: z.literal("codex/event/exec_command_begin"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/exec_command_end"),
    params: CodexEventExecCommandEndNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "exec_command_completed",
      callId: params.msg.call_id ?? null,
      command: params.msg.command ?? null,
      cwd: params.msg.cwd ?? null,
      output:
        params.msg.aggregated_output ??
        params.msg.aggregatedOutput ??
        params.msg.formatted_output ??
        params.msg.stdout ??
        null,
      exitCode: params.msg.exit_code ?? params.msg.exitCode ?? null,
      success: params.msg.success ?? null,
      stderr: params.msg.stderr ?? null,
    })
  ),
  z.object({ method: z.literal("codex/event/exec_command_end"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/exec_command_output_delta"),
    params: CodexEventExecCommandOutputDeltaNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "exec_command_output_delta",
      callId: params.msg.call_id ?? null,
      stream: params.msg.stream ?? null,
      chunk: params.msg.chunk ?? params.msg.delta ?? null,
    })
  ),
  z.object({
    method: z.literal("codex/event/exec_command_output_delta"),
    params: z.unknown(),
  }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/patch_apply_begin"),
    params: CodexEventPatchApplyBeginNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "patch_apply_started",
      callId: params.msg.call_id ?? null,
      changes: params.msg.changes ?? null,
    })
  ),
  z.object({ method: z.literal("codex/event/patch_apply_begin"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/patch_apply_end"),
    params: CodexEventPatchApplyEndNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "patch_apply_completed",
      callId: params.msg.call_id ?? null,
      changes: params.msg.changes ?? null,
      stdout: params.msg.stdout ?? null,
      stderr: params.msg.stderr ?? null,
      success: params.msg.success ?? null,
    })
  ),
  z.object({ method: z.literal("codex/event/patch_apply_end"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("item/fileChange/outputDelta"),
    params: ItemFileChangeOutputDeltaNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "file_change_output_delta",
      itemId: params.itemId,
      delta: params.delta ?? params.chunk ?? null,
    })
  ),
  z.object({ method: z.literal("item/fileChange/outputDelta"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/turn_diff"),
    params: CodexEventTurnDiffNotificationSchema,
  }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "diff_updated",
      diff: params.msg.unified_diff ?? params.msg.diff ?? "",
    })
  ),
  z.object({ method: z.literal("codex/event/turn_diff"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/turn_aborted"),
    params: CodexEventTurnAbortedNotificationSchema,
  }).transform(
    (): ParsedCodexNotification => ({
      kind: "turn_completed",
      status: "interrupted",
      errorMessage: null,
    })
  ),
  z.object({ method: z.literal("codex/event/turn_aborted"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({
    method: z.literal("codex/event/task_complete"),
    params: CodexEventTaskCompleteNotificationSchema,
  }).transform(
    (): ParsedCodexNotification => ({
      kind: "turn_completed",
      status: "completed",
      errorMessage: null,
    })
  ),
  z.object({ method: z.literal("codex/event/task_complete"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "invalid_payload", method, params })
  ),
  z.object({ method: z.string(), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({ kind: "unknown_method", method, params })
  ),
]);

async function writeImageAttachment(mimeType: string, data: string): Promise<string> {
  const attachmentsDir = path.join(os.tmpdir(), CODEX_IMAGE_ATTACHMENT_DIR);
  await fs.mkdir(attachmentsDir, { recursive: true });
  const normalized = normalizeImageData(mimeType, data);
  const extension = getImageExtension(normalized.mimeType);
  const filename = `${randomUUID()}.${extension}`;
  const filePath = path.join(attachmentsDir, filename);
  await fs.writeFile(filePath, Buffer.from(normalized.data, "base64"));
  return filePath;
}

async function readCodexConfiguredDefaults(
  client: CodexAppServerClient,
  logger: Logger
): Promise<CodexConfiguredDefaults> {
  let savedConfigDefaults: CodexConfiguredDefaults = {};
  try {
    const response = (await client.request("getUserSavedConfig", {})) as {
      config?: {
        model?: string | null;
        modelReasoningEffort?: string | null;
      };
    };
    savedConfigDefaults = {
      model: normalizeCodexModelId(response?.config?.model),
      thinkingOptionId: normalizeCodexThinkingOptionId(
        response?.config?.modelReasoningEffort ?? null
      ),
    };
  } catch (error) {
    logger.debug({ error }, "Failed to read Codex saved config defaults");
  }

  if (savedConfigDefaults.model && savedConfigDefaults.thinkingOptionId) {
    return savedConfigDefaults;
  }

  let configReadDefaults: CodexConfiguredDefaults = {};
  try {
    const response = (await client.request("config/read", {})) as {
      config?: {
        model?: string | null;
        model_reasoning_effort?: string | null;
      };
    };
    configReadDefaults = {
      model: normalizeCodexModelId(response?.config?.model),
      thinkingOptionId: normalizeCodexThinkingOptionId(
        response?.config?.model_reasoning_effort ?? null
      ),
    };
  } catch (error) {
    logger.debug({ error }, "Failed to read Codex config defaults");
  }

  return mergeCodexConfiguredDefaults(savedConfigDefaults, configReadDefaults);
}

export async function codexAppServerTurnInputFromPrompt(
  prompt: AgentPromptInput,
  logger: Logger
): Promise<unknown[]> {
  if (typeof prompt === "string") {
    return [{ type: "text", text: prompt }];
  }

  const blocks = prompt as Array<unknown>;
  const output: unknown[] = [];
  for (const block of blocks) {
    if (!block || typeof block !== "object") {
      output.push(block);
      continue;
    }
    const record = block as { type?: unknown; mimeType?: unknown; data?: unknown };
    if (
      record.type === "image" &&
      typeof record.mimeType === "string" &&
      typeof record.data === "string"
    ) {
      try {
        const filePath = await writeImageAttachment(record.mimeType, record.data);
        output.push({ type: "localImage", path: filePath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ message }, "Failed to write Codex image attachment");
        output.push({
          type: "text",
          text: `User attached image (failed to write temp file): ${message}`,
        });
      }
      continue;
    }
    output.push(block);
  }
  return output;
}

export const __codexAppServerInternals = {
  mapCodexPatchNotificationToToolCall,
};

class CodexAppServerAgentSession implements AgentSession {
  readonly provider = CODEX_PROVIDER;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;

  private readonly logger: Logger;
  private readonly config: AgentSessionConfig;
  private currentMode: string;
  private currentThreadId: string | null = null;
  private currentTurnId: string | null = null;
  private client: CodexAppServerClient | null = null;
  private eventQueue: Pushable<AgentStreamEvent> | null = null;
  private cachedRuntimeInfo: AgentRuntimeInfo | null = null;
  private historyPending = false;
  private persistedHistory: AgentTimelineItem[] = [];
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private pendingPermissionHandlers = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      kind: "command" | "file" | "tool";
      questions?: Array<{ id: string; options?: Array<{ label?: string; value?: string }> }>;
    }
  >();
  private resolvedPermissionRequests = new Set<string>();
  private pendingAgentMessages = new Map<string, string>();
  private pendingReasoning = new Map<string, string[]>();
  private pendingCommandOutputDeltas = new Map<string, string[]>();
  private pendingFileChangeOutputDeltas = new Map<string, string[]>();
  private emittedExecCommandStartedCallIds = new Set<string>();
  private emittedExecCommandCompletedCallIds = new Set<string>();
  private emittedItemStartedIds = new Set<string>();
  private emittedItemCompletedIds = new Set<string>();
  private warnedUnknownNotificationMethods = new Set<string>();
  private warnedInvalidNotificationPayloads = new Set<string>();
  private warnedIncompleteEditToolCallIds = new Set<string>();
  private latestUsage: AgentUsage | undefined;
  private connected = false;
  private collaborationModes: Array<{
    name: string;
    mode?: string | null;
    model?: string | null;
    reasoning_effort?: string | null;
    developer_instructions?: string | null;
  }> = [];
  private resolvedCollaborationMode: { mode: string; settings: Record<string, unknown>; name: string } | null = null;
  private cachedSkills: Array<{ name: string; description: string; path: string }> = [];

  constructor(
    config: AgentSessionConfig,
    private readonly resumeHandle: { sessionId: string; metadata?: Record<string, unknown> } | null,
    logger: Logger,
    private readonly spawnAppServer: () => ChildProcessWithoutNullStreams
  ) {
    this.logger = logger.child({ module: "agent", provider: CODEX_PROVIDER });
    if (config.modeId === undefined) {
      throw new Error("Codex agent requires modeId to be specified");
    }
    validateCodexMode(config.modeId);
    this.currentMode = config.modeId;
    this.config = config;
    this.config.thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);

    if (this.resumeHandle?.sessionId) {
      this.currentThreadId = this.resumeHandle.sessionId;
      this.historyPending = true;
    }
  }

  get id(): string | null {
    return this.currentThreadId;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const child = this.spawnAppServer();
    this.client = new CodexAppServerClient(child, this.logger);
    this.client.setNotificationHandler((method, params) => this.handleNotification(method, params));
    this.registerRequestHandlers();

    await this.client.request("initialize", {
      clientInfo: {
        name: "paseo",
        title: "Paseo",
        version: "0.0.0",
      },
    });
    this.client.notify("initialized", {});

    await this.loadCollaborationModes();
    await this.loadSkills();

    if (this.currentThreadId) {
      await this.loadPersistedHistory();
      await this.ensureThreadLoaded();
    }

    this.connected = true;
  }

  private async loadCollaborationModes(): Promise<void> {
    if (!this.client) return;
    try {
      const response = (await this.client.request("collaborationMode/list", {})) as {
        data?: Array<any>;
      };
      const data = Array.isArray(response?.data) ? response.data : [];
      this.collaborationModes = data.map((entry) => ({
        name: String(entry.name ?? ""),
        mode: entry.mode ?? null,
        model: entry.model ?? null,
        reasoning_effort: entry.reasoning_effort ?? null,
        developer_instructions: entry.developer_instructions ?? null,
      }));
    } catch (error) {
      this.logger.trace({ error }, "Failed to load collaboration modes");
      this.collaborationModes = [];
    }
    this.resolvedCollaborationMode = this.resolveCollaborationMode(this.currentMode);
  }

  private async loadSkills(): Promise<void> {
    if (!this.client) return;
    try {
      const response = (await this.client.request("skills/list", {
        cwd: [this.config.cwd],
      })) as { data?: Array<any> };
      const entries = Array.isArray(response?.data) ? response.data : [];
      const skills: Array<{ name: string; description: string; path: string }> = [];
      for (const entry of entries) {
        const list = Array.isArray(entry.skills) ? entry.skills : [];
        for (const skill of list) {
          if (!skill?.name || !skill?.path) continue;
          skills.push({
            name: skill.name,
            description: skill.description ?? skill.shortDescription ?? "Skill",
            path: skill.path,
          });
        }
      }
      this.cachedSkills = skills;
    } catch (error) {
      this.logger.trace({ error }, "Failed to load skills list");
      this.cachedSkills = [];
    }
  }

  private resolveCollaborationMode(modeId: string): { mode: string; settings: Record<string, unknown>; name: string } | null {
    if (this.collaborationModes.length === 0) return null;
    const normalized = modeId.toLowerCase();
    const findByName = (predicate: (name: string) => boolean) =>
      this.collaborationModes.find((entry) => predicate(entry.name.toLowerCase()));
    let match =
      normalized === "read-only"
        ? findByName((name) => name.includes("read") || name.includes("plan"))
        : normalized === "full-access"
          ? findByName((name) => name.includes("full") || name.includes("exec"))
          : findByName((name) => name.includes("auto") || name.includes("code"));
    if (!match) {
      match = this.collaborationModes[0] ?? null;
    }
    if (!match) return null;
    const settings: Record<string, unknown> = {};
    if (match.model) settings.model = match.model;
    if (match.reasoning_effort) settings.reasoning_effort = match.reasoning_effort;
    const developerInstructions = [
      match.developer_instructions?.trim(),
      this.config.systemPrompt?.trim(),
    ]
      .filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
      .join("\n\n");
    if (developerInstructions) settings.developer_instructions = developerInstructions;
    if (this.config.model) settings.model = this.config.model;
    const thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
    if (thinkingOptionId) settings.reasoning_effort = thinkingOptionId;
    return { mode: match.mode ?? "code", settings, name: match.name };
  }

  private registerRequestHandlers(): void {
    if (!this.client) return;

    this.client.setRequestHandler("item/commandExecution/requestApproval", (params) =>
      this.handleCommandApprovalRequest(params)
    );
    this.client.setRequestHandler("item/fileChange/requestApproval", (params) =>
      this.handleFileChangeApprovalRequest(params)
    );
    this.client.setRequestHandler("tool/requestUserInput", (params) =>
      this.handleToolApprovalRequest(params)
    );
  }

  private async loadPersistedHistory(): Promise<void> {
    if (!this.client || !this.currentThreadId) return;
    try {
      let rolloutTimeline: AgentTimelineItem[] = [];
      try {
        rolloutTimeline = await loadCodexPersistedTimeline(
          this.currentThreadId,
          undefined,
          this.logger
        );
      } catch {
        rolloutTimeline = [];
      }

      const response = (await this.client.request("thread/read", {
        threadId: this.currentThreadId,
        includeTurns: true,
      })) as { thread?: { turns?: Array<{ items?: any[] }> } };
      const thread = response?.thread;
      const threadTimeline: AgentTimelineItem[] = [];
      if (thread && Array.isArray(thread.turns)) {
        for (const turn of thread.turns) {
          const items = Array.isArray(turn.items) ? turn.items : [];
          for (const item of items) {
            const timelineItem = threadItemToTimeline(item, {
              cwd: this.config.cwd ?? null,
            });
            if (timelineItem) {
              if (timelineItem.type === "tool_call") {
                this.warnOnIncompleteEditToolCall(timelineItem, "thread_read", item);
              }
              threadTimeline.push(timelineItem);
            }
          }
        }
      }

      const timeline =
        rolloutTimeline.length > 0 ? rolloutTimeline : threadTimeline;

      if (timeline.length > 0) {
        this.persistedHistory = timeline;
        this.historyPending = true;
      }
    } catch (error) {
      this.logger.warn({ error }, "Failed to load Codex thread history");
    }
  }

  private async ensureThreadLoaded(): Promise<void> {
    if (!this.client || !this.currentThreadId) return;
    try {
      const loaded = (await this.client.request("thread/loaded/list", {})) as { data?: string[] };
      const ids = Array.isArray(loaded?.data) ? loaded.data : [];
      if (ids.includes(this.currentThreadId)) {
        return;
      }
      const params: Record<string, unknown> = { threadId: this.currentThreadId };
      if (this.config.systemPrompt?.trim()) {
        params.developerInstructions = this.config.systemPrompt.trim();
      }
      const codexConfig = this.buildCodexInnerConfig();
      if (codexConfig) {
        params.config = codexConfig;
      }
      await this.client.request("thread/resume", params);
    } catch (error) {
      this.logger.warn({ error }, "Failed to resume Codex thread, starting new thread");
      this.currentThreadId = null;
      await this.ensureThread();
    }
  }

  private parseSlashCommandInput(
    text: string
  ): { commandName: string; args?: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || trimmed.length <= 1) {
      return null;
    }
    const withoutPrefix = trimmed.slice(1);
    const firstWhitespaceIdx = withoutPrefix.search(/\s/);
    const commandName =
      firstWhitespaceIdx === -1
        ? withoutPrefix
        : withoutPrefix.slice(0, firstWhitespaceIdx);
    if (!commandName || commandName.includes("/")) {
      return null;
    }
    const rawArgs =
      firstWhitespaceIdx === -1
        ? ""
        : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
    return rawArgs.length > 0 ? { commandName, args: rawArgs } : { commandName };
  }

  private async resolveSlashCommandInvocation(
    prompt: AgentPromptInput
  ): Promise<{ commandName: string; args?: string } | null> {
    if (typeof prompt !== "string") {
      return null;
    }
    const parsed = this.parseSlashCommandInput(prompt);
    if (!parsed) {
      return null;
    }
    try {
      const commands = await this.listCommands();
      return commands.some((command) => command.name === parsed.commandName)
        ? parsed
        : null;
    } catch (error) {
      this.logger.warn(
        { err: error, commandName: parsed.commandName },
        "Failed to resolve slash command; falling back to plain prompt input"
      );
      return null;
    }
  }

  private async buildCommandPromptInput(
    commandName: string,
    args?: string
  ): Promise<AgentPromptInput> {
    if (commandName.startsWith("prompts:")) {
      const promptName = commandName.slice("prompts:".length);
      const codexHome = resolveCodexHomeDir();
      const promptPath = path.join(codexHome, "prompts", `${promptName}.md`);
      const raw = await fs.readFile(promptPath, "utf8");
      const parsed = parseFrontMatter(raw);
      return expandCodexCustomPrompt(parsed.body, args);
    }

    if (!this.connected) {
      await this.connect();
    } else {
      await this.loadSkills();
    }
    const skill = this.cachedSkills.find((entry) => entry.name === commandName);
    if (skill) {
      const input = [
        { type: "skill", name: skill.name, path: skill.path },
      ] as unknown as AgentPromptContentBlock[];
      if (args && args.trim().length > 0) {
        input.push({ type: "text", text: args.trim() });
      } else {
        input.push({ type: "text", text: `$${skill.name}` });
      }
      return input;
    }

    return args ? `$${commandName} ${args}` : `$${commandName}`;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const slashCommand = await this.resolveSlashCommandInvocation(prompt);
    if (slashCommand) {
      const commandInput = await this.buildCommandPromptInput(
        slashCommand.commandName,
        slashCommand.args
      );
      return this.runInternal(commandInput, options);
    }
    return this.runInternal(prompt, options);
  }

  private async runInternal(
    prompt: AgentPromptInput,
    options?: AgentRunOptions
  ): Promise<AgentRunResult> {
    const events = this.streamInternal(prompt, options);
    const timeline: AgentTimelineItem[] = [];
    let finalText = "";
    let usage: AgentUsage | undefined;

    for await (const event of events) {
      if (event.type === "timeline") {
        timeline.push(event.item);
        if (event.item.type === "assistant_message") {
          finalText = event.item.text;
        }
      } else if (event.type === "turn_completed") {
        usage = event.usage;
      } else if (event.type === "turn_failed") {
        throw new Error(event.error);
      }
    }

    const info = await this.getRuntimeInfo();
    return {
      sessionId: info.sessionId ?? "",
      finalText,
      usage,
      timeline,
    };
  }

  async *stream(
    prompt: AgentPromptInput,
    options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
    const slashCommand = await this.resolveSlashCommandInvocation(prompt);
    if (slashCommand) {
      const commandInput = await this.buildCommandPromptInput(
        slashCommand.commandName,
        slashCommand.args
      );
      yield* this.streamInternal(commandInput, options);
      return;
    }
    yield* this.streamInternal(prompt, options);
  }

  private async *streamInternal(
    prompt: AgentPromptInput,
    options?: AgentRunOptions
  ): AsyncGenerator<AgentStreamEvent> {
    await this.connect();
    if (!this.client) return;

    const queue = new Pushable<AgentStreamEvent>();
    this.eventQueue = queue;

    try {
      if (this.currentThreadId) {
        await this.ensureThreadLoaded();
      } else {
        await this.ensureThread();
      }
      const input = await this.buildUserInput(prompt);
      const preset = MODE_PRESETS[this.currentMode] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
      const approvalPolicy = this.config.approvalPolicy ?? preset.approvalPolicy;
      const sandboxPolicyType = this.config.sandboxMode ?? preset.sandbox;

      const params: Record<string, unknown> = {
        threadId: this.currentThreadId,
        input,
        approvalPolicy,
        sandboxPolicy: toSandboxPolicy(
          sandboxPolicyType,
          typeof this.config.networkAccess === "boolean"
            ? this.config.networkAccess
            : preset.networkAccess
        ),
      };

      if (this.config.model) {
        params.model = this.config.model;
      }
      const thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
      if (thinkingOptionId) {
        params.effort = thinkingOptionId;
      }
      if (this.resolvedCollaborationMode) {
        params.collaborationMode = {
          mode: this.resolvedCollaborationMode.mode,
          settings: this.resolvedCollaborationMode.settings,
        };
      }
      if (this.config.cwd) {
        params.cwd = this.config.cwd;
      }
      if (options?.outputSchema) {
        params.outputSchema = options.outputSchema;
      }
      if (this.config.systemPrompt?.trim()) {
        params.developerInstructions = this.config.systemPrompt.trim();
      }
      const codexConfig = this.buildCodexInnerConfig();
      if (codexConfig) {
        params.config = codexConfig;
      }

      await this.client.request("turn/start", params, TURN_START_TIMEOUT_MS);

      for await (const event of queue) {
        yield event;
        if (
          event.type === "turn_completed" ||
          event.type === "turn_failed" ||
          event.type === "turn_canceled"
        ) {
          break;
        }
      }
    } finally {
      if (this.eventQueue === queue) {
        this.eventQueue = null;
      }
    }
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (!this.historyPending || this.persistedHistory.length === 0) {
      return;
    }
    const history = this.persistedHistory;
    this.persistedHistory = [];
    this.historyPending = false;
    for (const item of history) {
      yield { type: "timeline", provider: CODEX_PROVIDER, item };
    }
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    if (this.cachedRuntimeInfo) return { ...this.cachedRuntimeInfo };
    if (!this.connected) {
      await this.connect();
    }
    if (!this.currentThreadId) {
      await this.ensureThread();
    }
    const info: AgentRuntimeInfo = {
      provider: CODEX_PROVIDER,
      sessionId: this.currentThreadId,
      model: this.config.model ?? null,
      thinkingOptionId: normalizeCodexThinkingOptionId(this.config.thinkingOptionId) ?? null,
      modeId: this.currentMode ?? null,
      extra: this.resolvedCollaborationMode
        ? { collaborationMode: this.resolvedCollaborationMode.name }
        : undefined,
    };
    this.cachedRuntimeInfo = info;
    return { ...info };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return CODEX_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode ?? null;
  }

  async setMode(modeId: string): Promise<void> {
    validateCodexMode(modeId);
    this.currentMode = modeId;
    this.resolvedCollaborationMode = this.resolveCollaborationMode(modeId);
    this.cachedRuntimeInfo = null;
  }

  async setModel(modelId: string | null): Promise<void> {
    this.config.model = modelId ?? undefined;
    this.resolvedCollaborationMode = this.resolveCollaborationMode(this.currentMode);
    this.cachedRuntimeInfo = null;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    this.config.thinkingOptionId = normalizeCodexThinkingOptionId(thinkingOptionId);
    this.resolvedCollaborationMode = this.resolveCollaborationMode(this.currentMode);
    this.cachedRuntimeInfo = null;
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values());
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    const pending = this.pendingPermissionHandlers.get(requestId);
    if (!pending) {
      throw new Error(`No pending Codex app-server permission request with id '${requestId}'`);
    }
    const pendingRequest = this.pendingPermissions.get(requestId) ?? null;
    this.pendingPermissionHandlers.delete(requestId);
    this.pendingPermissions.delete(requestId);
    this.resolvedPermissionRequests.add(requestId);

    if (response.behavior === "deny" && pendingRequest?.kind === "tool") {
      const fallbackName =
        pendingRequest.name === "CodexBash"
          ? "shell"
          : pendingRequest.name === "CodexFileChange"
            ? "apply_patch"
            : pendingRequest.name;
      this.emitEvent({
        type: "timeline",
        provider: CODEX_PROVIDER,
        item: {
          type: "tool_call",
          callId: requestId,
          name: fallbackName,
          status: "failed",
          error: { message: response.message ?? "Permission denied" },
          detail:
            pendingRequest.detail ?? {
              type: "unknown",
              input: pendingRequest.input ?? null,
              output: null,
            },
          metadata: {
            permissionRequestId: requestId,
            denied: true,
          },
        },
      });
    }

    this.emitEvent({
      type: "permission_resolved",
      provider: CODEX_PROVIDER,
      requestId,
      resolution: response,
    });

    if (pending.kind === "command") {
      const decision = response.behavior === "allow"
        ? "accept"
        : response.interrupt
          ? "cancel"
          : "decline";
      pending.resolve({ decision });
      return;
    }

    if (pending.kind === "file") {
      const decision = response.behavior === "allow"
        ? "accept"
        : response.interrupt
          ? "cancel"
          : "decline";
      pending.resolve({ decision });
      return;
    }

    // tool/requestUserInput
    const answers: Record<string, { answers: string[] }> = {};
    const questions = pending.questions ?? [];
    const decision = response.behavior === "allow" ? "accept" : response.interrupt ? "cancel" : "decline";
    for (const question of questions) {
      let picked = decision;
      const options = question.options ?? [];
      if (options.length > 0) {
        const byLabel = options.find((opt) => (opt.label ?? "").toLowerCase().includes(decision));
        const byValue = options.find((opt) => (opt.value ?? "").toLowerCase().includes(decision));
        const option = byLabel ?? byValue ?? options[0]!;
        picked = option.value ?? option.label ?? decision;
      }
      answers[question.id] = { answers: [picked] };
    }
    if (questions.length === 0) {
      answers["default"] = { answers: [decision] };
    }
    pending.resolve({ answers });
  }

  describePersistence(): { provider: typeof CODEX_PROVIDER; sessionId: string; nativeHandle: string; metadata: Record<string, unknown> } | null {
    if (!this.currentThreadId) return null;
    const thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId) ?? null;
    return {
      provider: CODEX_PROVIDER,
      sessionId: this.currentThreadId,
      nativeHandle: this.currentThreadId,
      metadata: {
        provider: CODEX_PROVIDER,
        cwd: this.config.cwd,
        title: this.config.title ?? null,
        threadId: this.currentThreadId,
        modeId: this.currentMode,
        model: this.config.model ?? null,
        thinkingOptionId,
        extra: this.config.extra,
        systemPrompt: this.config.systemPrompt,
        mcpServers: this.config.mcpServers,
      },
    };
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.currentThreadId || !this.currentTurnId) return;
    try {
      await this.client.request("turn/interrupt", {
        threadId: this.currentThreadId,
        turnId: this.currentTurnId,
      });
    } catch (error) {
      this.logger.warn({ error }, "Failed to interrupt Codex turn");
    }
  }

  async close(): Promise<void> {
    for (const pending of this.pendingPermissionHandlers.values()) {
      pending.resolve({ decision: "cancel" });
    }
    this.pendingPermissionHandlers.clear();
    this.pendingPermissions.clear();
    this.resolvedPermissionRequests.clear();
    this.eventQueue?.end();
    this.eventQueue = null;
    if (this.client) {
      await this.client.dispose();
    }
    this.client = null;
    this.connected = false;
    this.currentThreadId = null;
    this.currentTurnId = null;
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    const prompts = await listCodexCustomPrompts();
    if (!this.connected) {
      await this.connect();
    } else {
      await this.loadSkills();
    }
    const appServerSkills = this.cachedSkills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      argumentHint: "",
    }));
    const fallbackSkills = appServerSkills.length === 0 ? await listCodexSkills(this.config.cwd) : [];
    return [...appServerSkills, ...fallbackSkills, ...prompts].sort((a, b) =>
      a.name.localeCompare(b.name)
    );
  }

  private async ensureThread(): Promise<void> {
    if (!this.client) return;
    if (this.currentThreadId) return;

    // Resolve model + thinking defaults when omitted.
    let configuredDefaults: CodexConfiguredDefaults = {};
    let model = this.config.model;
    let thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
    if (!model || !thinkingOptionId) {
      configuredDefaults = await readCodexConfiguredDefaults(this.client, this.logger);
    }
    if (!model) {
      model = configuredDefaults.model;
    }
    if (!thinkingOptionId) {
      thinkingOptionId = configuredDefaults.thinkingOptionId;
    }

    if (!model || !thinkingOptionId) {
      const modelResponse = (await this.client.request("model/list", {})) as CodexModelListResponse;
      const models = modelResponse?.data ?? [];
      const defaultModel = models.find((m) => m.isDefault) ?? models[0];
      if (!defaultModel) {
        throw new Error("No models available from Codex app-server");
      }
      const selectedModel =
        (model ? models.find((candidate) => candidate.id === model) : undefined) ?? defaultModel;
      if (!model) {
        model = selectedModel.id;
      }
      if (!thinkingOptionId) {
        thinkingOptionId = normalizeCodexThinkingOptionId(selectedModel.defaultReasoningEffort);
      }
    }

    this.config.model = model;
    this.config.thinkingOptionId = thinkingOptionId;

    const preset = MODE_PRESETS[this.currentMode] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
    const approvalPolicy = this.config.approvalPolicy ?? preset.approvalPolicy;
    const sandbox = this.config.sandboxMode ?? preset.sandbox;
    const innerConfig = this.buildCodexInnerConfig();
    const response = (await this.client.request("thread/start", {
      model,
      cwd: this.config.cwd ?? null,
      approvalPolicy,
      sandbox,
      ...(this.config.systemPrompt?.trim()
        ? { developerInstructions: this.config.systemPrompt.trim() }
        : {}),
      ...(innerConfig ? { config: innerConfig } : {}),
    })) as CodexThreadStartResponse;
    const threadId = response?.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return thread id");
    }
    this.currentThreadId = threadId;
  }

  private buildCodexInnerConfig(): Record<string, unknown> | null {
    const innerConfig: Record<string, unknown> = {};
    if (this.config.mcpServers) {
      const mcpServers: Record<string, CodexMcpServerConfig> = {};
      for (const [name, serverConfig] of Object.entries(this.config.mcpServers)) {
        mcpServers[name] = toCodexMcpConfig(serverConfig);
      }
      innerConfig.mcp_servers = mcpServers;
    }
    if (this.config.extra?.codex) {
      Object.assign(innerConfig, this.config.extra.codex);
    }
    return Object.keys(innerConfig).length > 0 ? innerConfig : null;
  }

  private async buildUserInput(prompt: AgentPromptInput): Promise<unknown[]> {
    if (typeof prompt === "string") {
      return [{ type: "text", text: prompt }];
    }
    const blocks = prompt as AgentPromptContentBlock[];
    return await codexAppServerTurnInputFromPrompt(blocks, this.logger);
  }

  private emitEvent(event: AgentStreamEvent): void {
    if (event.type === "timeline") {
      if (event.item.type === "assistant_message") {
        this.pendingAgentMessages.clear();
      }
    }
    this.eventQueue?.push(event);
  }

  private handleNotification(method: string, params: unknown): void {
    const parsed = CodexNotificationSchema.parse({ method, params });

    if (parsed.kind === "thread_started") {
      this.currentThreadId = parsed.threadId;
      this.emitEvent({ type: "thread_started", provider: CODEX_PROVIDER, sessionId: parsed.threadId });
      return;
    }

    if (parsed.kind === "turn_started") {
      this.currentTurnId = parsed.turnId;
      this.emittedItemStartedIds.clear();
      this.emittedItemCompletedIds.clear();
      this.emittedExecCommandStartedCallIds.clear();
      this.emittedExecCommandCompletedCallIds.clear();
      this.pendingCommandOutputDeltas.clear();
      this.pendingFileChangeOutputDeltas.clear();
      this.warnedIncompleteEditToolCallIds.clear();
      this.emitEvent({ type: "turn_started", provider: CODEX_PROVIDER });
      return;
    }

    if (parsed.kind === "turn_completed") {
      if (parsed.status === "failed") {
        this.emitEvent({
          type: "turn_failed",
          provider: CODEX_PROVIDER,
          error: parsed.errorMessage ?? "Codex turn failed",
        });
      } else if (parsed.status === "interrupted") {
        this.emitEvent({ type: "turn_canceled", provider: CODEX_PROVIDER, reason: "interrupted" });
      } else {
        this.emitEvent({ type: "turn_completed", provider: CODEX_PROVIDER, usage: this.latestUsage });
      }
      this.emittedItemStartedIds.clear();
      this.emittedItemCompletedIds.clear();
      this.emittedExecCommandStartedCallIds.clear();
      this.emittedExecCommandCompletedCallIds.clear();
      this.pendingCommandOutputDeltas.clear();
      this.pendingFileChangeOutputDeltas.clear();
      this.warnedIncompleteEditToolCallIds.clear();
      this.eventQueue?.end();
      return;
    }

    if (parsed.kind === "plan_updated") {
      const items = planStepsToTodoItems(
        parsed.plan.map((entry) => ({
          step: entry.step ?? "",
          status: entry.status ?? "pending",
        }))
      );
      this.emitEvent({
        type: "timeline",
        provider: CODEX_PROVIDER,
        item: { type: "todo", items },
      });
      return;
    }

    if (parsed.kind === "diff_updated") {
      // NOTE: Codex app-server emits frequent `turn/diff/updated` notifications
      // containing a full accumulated unified diff for the *entire turn*.
      // This is not a concrete file-change tool call; it is progress telemetry.
      // We intentionally do NOT store every diff update in the timeline.
      return;
    }

    if (parsed.kind === "token_usage_updated") {
      this.latestUsage = toAgentUsage(parsed.tokenUsage);
      return;
    }

    if (parsed.kind === "agent_message_delta") {
      const prev = this.pendingAgentMessages.get(parsed.itemId) ?? "";
      this.pendingAgentMessages.set(parsed.itemId, prev + parsed.delta);
      return;
    }

    if (parsed.kind === "reasoning_delta") {
      const prev = this.pendingReasoning.get(parsed.itemId) ?? [];
      prev.push(parsed.delta);
      this.pendingReasoning.set(parsed.itemId, prev);
      return;
    }

    if (parsed.kind === "exec_command_output_delta") {
      this.appendOutputDeltaChunk(
        this.pendingCommandOutputDeltas,
        parsed.callId,
        parsed.chunk,
        { decodeBase64: true }
      );
      return;
    }

    if (parsed.kind === "file_change_output_delta") {
      this.appendOutputDeltaChunk(this.pendingFileChangeOutputDeltas, parsed.itemId, parsed.delta);
      return;
    }

    if (parsed.kind === "exec_command_started") {
      if (parsed.callId) {
        this.emittedExecCommandStartedCallIds.add(parsed.callId);
        this.pendingCommandOutputDeltas.delete(parsed.callId);
      }
      const timelineItem = mapCodexExecNotificationToToolCall({
        callId: parsed.callId,
        command: parsed.command,
        cwd: parsed.cwd ?? this.config.cwd ?? null,
        running: true,
      });
      if (timelineItem) {
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
      }
      return;
    }

    if (parsed.kind === "exec_command_completed") {
      const bufferedOutput = this.consumeOutputDelta(
        this.pendingCommandOutputDeltas,
        parsed.callId
      );
      const timelineItem = mapCodexExecNotificationToToolCall({
        callId: parsed.callId,
        command: parsed.command,
        cwd: parsed.cwd ?? this.config.cwd ?? null,
        output: parsed.output ?? bufferedOutput,
        exitCode: parsed.exitCode,
        success: parsed.success,
        stderr: parsed.stderr,
        running: false,
      });
      if (timelineItem) {
        this.emittedExecCommandCompletedCallIds.add(timelineItem.callId);
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
      }
      return;
    }

    if (parsed.kind === "patch_apply_started") {
      if (parsed.callId) {
        this.pendingFileChangeOutputDeltas.delete(parsed.callId);
      }
      const timelineItem = mapCodexPatchNotificationToToolCall({
        callId: parsed.callId,
        changes: parsed.changes,
        cwd: this.config.cwd ?? null,
        running: true,
      });
      if (timelineItem) {
        this.warnOnIncompleteEditToolCall(timelineItem, "patch_apply_started", {
          callId: parsed.callId,
          changes: parsed.changes,
        });
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
      }
      return;
    }

    if (parsed.kind === "patch_apply_completed") {
      const bufferedOutput = this.consumeOutputDelta(
        this.pendingFileChangeOutputDeltas,
        parsed.callId
      );
      const timelineItem = mapCodexPatchNotificationToToolCall({
        callId: parsed.callId,
        changes: parsed.changes,
        cwd: this.config.cwd ?? null,
        stdout: parsed.stdout ?? bufferedOutput,
        stderr: parsed.stderr,
        success: parsed.success,
        running: false,
      });
      if (timelineItem) {
        this.warnOnIncompleteEditToolCall(timelineItem, "patch_apply_completed", {
          callId: parsed.callId,
          changes: parsed.changes,
          stdout: parsed.stdout,
        });
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
      }
      return;
    }

    if (parsed.kind === "item_completed") {
      // Codex emits mirrored lifecycle notifications via both `codex/event/item_*`
      // and canonical `item/*`. We render only the canonical channel to avoid
      // duplicated assistant/reasoning rows.
      if (parsed.source === "codex_event") {
        return;
      }
      const timelineItem = threadItemToTimeline(parsed.item, {
        includeUserMessage: false,
        cwd: this.config.cwd ?? null,
      });
      if (timelineItem) {
        const normalizedItemType = normalizeCodexThreadItemType(
          typeof parsed.item.type === "string" ? parsed.item.type : undefined
        );
        const itemId = parsed.item.id;
        // For commandExecution items, codex/event/exec_command_* is authoritative.
        // Keep item/completed as fallback only when no exec_command completion was seen.
        if (
          timelineItem.type === "tool_call" &&
          normalizedItemType === "commandExecution"
        ) {
          const callId = timelineItem.callId || itemId;
          if (callId && this.emittedExecCommandCompletedCallIds.has(callId)) {
            return;
          }
        }
        if (itemId && this.emittedItemCompletedIds.has(itemId)) {
          return;
        }
        if (timelineItem.type === "assistant_message" && itemId) {
          const buffered = this.pendingAgentMessages.get(itemId);
          if (buffered && buffered.length > 0) {
            timelineItem.text = buffered;
          }
        }
        if (timelineItem.type === "reasoning" && itemId) {
          const buffered = this.pendingReasoning.get(itemId);
          if (buffered && buffered.length > 0) {
            timelineItem.text = buffered.join("");
          }
        }
        if (timelineItem.type === "tool_call") {
          this.warnOnIncompleteEditToolCall(timelineItem, "item_completed", parsed.item);
        }
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
        if (itemId) {
          this.emittedItemCompletedIds.add(itemId);
          this.emittedItemStartedIds.delete(itemId);
          this.pendingCommandOutputDeltas.delete(itemId);
          this.pendingFileChangeOutputDeltas.delete(itemId);
        }
      }
      return;
    }

    if (parsed.kind === "item_started") {
      if (parsed.source === "codex_event") {
        return;
      }
      const timelineItem = threadItemToTimeline(parsed.item, {
        includeUserMessage: false,
        cwd: this.config.cwd ?? null,
      });
      if (timelineItem && timelineItem.type === "tool_call") {
        const normalizedItemType = normalizeCodexThreadItemType(
          typeof parsed.item.type === "string" ? parsed.item.type : undefined
        );
        const itemId = parsed.item.id;
        if (normalizedItemType === "commandExecution") {
          const callId = timelineItem.callId || itemId;
          if (callId && this.emittedExecCommandStartedCallIds.has(callId)) {
            return;
          }
        }
        if (itemId && this.emittedItemStartedIds.has(itemId)) {
          return;
        }
        this.warnOnIncompleteEditToolCall(timelineItem, "item_started", parsed.item);
        this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
        if (itemId) {
          this.emittedItemStartedIds.add(itemId);
          this.pendingCommandOutputDeltas.delete(itemId);
          this.pendingFileChangeOutputDeltas.delete(itemId);
        }
      }
      return;
    }

    if (parsed.kind === "invalid_payload") {
      this.warnInvalidNotificationPayload(parsed.method, parsed.params);
      return;
    }

    this.warnUnknownNotificationMethod(parsed.method, parsed.params);
  }

  private warnUnknownNotificationMethod(method: string, params: unknown): void {
    if (this.warnedUnknownNotificationMethods.has(method)) {
      return;
    }
    this.warnedUnknownNotificationMethods.add(method);
    this.logger.trace({ method, params }, "Unhandled Codex app-server notification method");
  }

  private warnInvalidNotificationPayload(method: string, params: unknown): void {
    const key = method;
    if (this.warnedInvalidNotificationPayloads.has(key)) {
      return;
    }
    this.warnedInvalidNotificationPayloads.add(key);
    this.logger.warn(
      { method, params },
      "Invalid Codex app-server notification payload"
    );
  }

  private appendOutputDeltaChunk(
    store: Map<string, string[]>,
    id: string | null | undefined,
    chunk: string | null | undefined,
    options?: { decodeBase64?: boolean }
  ): void {
    if (!id || !chunk) {
      return;
    }
    const normalized = options?.decodeBase64 ? decodeCodexOutputDeltaChunk(chunk) : chunk;
    if (!normalized.length) {
      return;
    }
    const prev = store.get(id) ?? [];
    prev.push(normalized);
    store.set(id, prev);
  }

  private consumeOutputDelta(store: Map<string, string[]>, id: string | null | undefined): string | null {
    if (!id) {
      return null;
    }
    const buffered = store.get(id);
    if (!buffered || buffered.length === 0) {
      return null;
    }
    store.delete(id);
    return buffered.join("");
  }

  private warnOnIncompleteEditToolCall(
    item: ToolCallTimelineItem,
    source: string,
    payload: unknown
  ): void {
    if (!isEditToolCallWithoutContent(item)) {
      return;
    }
    const warnKey = `${source}:${item.callId}`;
    if (this.warnedIncompleteEditToolCallIds.has(warnKey)) {
      return;
    }
    this.warnedIncompleteEditToolCallIds.add(warnKey);
    this.logger.warn(
      {
        source,
        callId: item.callId,
        status: item.status,
        name: item.name,
        detail: item.detail,
        payload,
      },
      "Codex edit tool call is missing diff/content fields"
    );
  }

  private handleCommandApprovalRequest(params: unknown): Promise<unknown> {
    const parsed = params as {
      itemId: string;
      threadId: string;
      turnId: string;
      command?: string | null;
      cwd?: string | null;
      reason?: string | null;
    };
    const commandPreview = mapCodexExecNotificationToToolCall({
      callId: parsed.itemId,
      command: parsed.command,
      cwd: parsed.cwd ?? this.config.cwd ?? null,
      running: true,
    });
    const requestId = `permission-${parsed.itemId}`;
    const title = parsed.command ? `Run command: ${parsed.command}` : "Run command";
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: CODEX_PROVIDER,
      name: "CodexBash",
      kind: "tool",
      title,
      description: parsed.reason ?? undefined,
      input: {
        command: parsed.command ?? undefined,
        cwd: parsed.cwd ?? undefined,
      },
      detail:
        commandPreview?.detail ?? {
          type: "unknown",
          input: {
            command: parsed.command ?? null,
            cwd: parsed.cwd ?? null,
          },
          output: null,
        },
      metadata: {
        itemId: parsed.itemId,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
      },
    };
    this.pendingPermissions.set(requestId, request);
    this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
    return new Promise((resolve) => {
      this.pendingPermissionHandlers.set(requestId, { resolve, kind: "command" });
    });
  }

  private handleFileChangeApprovalRequest(params: unknown): Promise<unknown> {
    const parsed = params as { itemId: string; threadId: string; turnId: string; reason?: string | null };
    const requestId = `permission-${parsed.itemId}`;
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: CODEX_PROVIDER,
      name: "CodexFileChange",
      kind: "tool",
      title: "Apply file changes",
      description: parsed.reason ?? undefined,
      detail: {
        type: "unknown",
        input: {
          reason: parsed.reason ?? null,
        },
        output: null,
      },
      metadata: {
        itemId: parsed.itemId,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
      },
    };
    this.pendingPermissions.set(requestId, request);
    this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
    return new Promise((resolve) => {
      this.pendingPermissionHandlers.set(requestId, { resolve, kind: "file" });
    });
  }

  private handleToolApprovalRequest(params: unknown): Promise<unknown> {
    const parsed = params as { itemId: string; threadId: string; turnId: string; questions: any[] };
    const requestId = `permission-${parsed.itemId}`;
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: CODEX_PROVIDER,
      name: "CodexTool",
      kind: "tool",
      title: "Tool action requires approval",
      description: undefined,
      detail: {
        type: "unknown",
        input: {
          questions: Array.isArray(parsed.questions) ? parsed.questions : [],
        },
        output: null,
      },
      metadata: {
        itemId: parsed.itemId,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
        questions: parsed.questions,
      },
    };
    this.pendingPermissions.set(requestId, request);
    this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
    return new Promise((resolve) => {
      this.pendingPermissionHandlers.set(requestId, {
        resolve,
        kind: "tool",
        questions: Array.isArray(parsed.questions) ? parsed.questions : [],
      });
    });
  }
}

export class CodexAppServerAgentClient implements AgentClient {
  readonly provider = CODEX_PROVIDER;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;

  constructor(
    private readonly logger: Logger,
    private readonly runtimeSettings?: ProviderRuntimeSettings
  ) {}

  private spawnAppServer(): ChildProcessWithoutNullStreams {
    const launchPrefix = resolveCodexLaunchPrefix(this.runtimeSettings);
    return spawn(launchPrefix.command, [...launchPrefix.args, "app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: applyProviderEnv(process.env, this.runtimeSettings),
    });
  }

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionConfig: AgentSessionConfig = { ...config, provider: CODEX_PROVIDER };
    const session = new CodexAppServerAgentSession(
      sessionConfig,
      null,
      this.logger,
      () => this.spawnAppServer()
    );
    await session.connect();
    return session;
  }

  async resumeSession(handle: { sessionId: string; metadata?: Record<string, unknown> }, overrides?: Partial<AgentSessionConfig>): Promise<AgentSession> {
    const storedConfig = (handle.metadata ?? {}) as AgentSessionConfig;
    const merged: AgentSessionConfig = {
      ...storedConfig,
      ...overrides,
      provider: CODEX_PROVIDER,
      cwd: overrides?.cwd ?? storedConfig.cwd ?? process.cwd(),
    };
    const session = new CodexAppServerAgentSession(
      merged,
      handle,
      this.logger,
      () => this.spawnAppServer()
    );
    await session.connect();
    return session;
  }

  async listPersistedAgents(
    options?: ListPersistedAgentsOptions
  ): Promise<PersistedAgentDescriptor[]> {
    const child = this.spawnAppServer();
    const client = new CodexAppServerClient(child, this.logger);

    try {
      await client.request("initialize", {
        clientInfo: { name: "paseo", title: "Paseo", version: "0.0.0" },
      });
      client.notify("initialized", {});

      const limit = options?.limit ?? 20;
      const response = (await client.request("thread/list", { limit })) as {
        data?: Array<any>;
      };
      const threads = Array.isArray(response?.data) ? response.data : [];
      const descriptors: PersistedAgentDescriptor[] = [];

      for (const thread of threads.slice(0, limit)) {
        const threadId = thread.id;
        const cwd = thread.cwd ?? process.cwd();
        const title = thread.preview ?? null;
        let timeline: AgentTimelineItem[] = [];
        try {
          const rolloutTimeline = await loadCodexPersistedTimeline(
            threadId,
            undefined,
            this.logger
          );
          const read = (await client.request("thread/read", {
            threadId,
            includeTurns: true,
          })) as { thread?: { turns?: Array<{ items?: any[] }> } };
          const turns = read.thread?.turns ?? [];
          const itemsFromThreadRead: AgentTimelineItem[] = [];
          for (const turn of turns) {
            for (const item of turn.items ?? []) {
              const timelineItem = threadItemToTimeline(item, { cwd });
              if (timelineItem) itemsFromThreadRead.push(timelineItem);
            }
          }
          timeline =
            rolloutTimeline.length > 0
              ? rolloutTimeline
              : itemsFromThreadRead;
        } catch {
          timeline = [];
        }

        descriptors.push({
          provider: CODEX_PROVIDER,
          sessionId: threadId,
          cwd,
          title,
          lastActivityAt: new Date((thread.updatedAt ?? thread.createdAt ?? 0) * 1000),
          persistence: {
            provider: CODEX_PROVIDER,
            sessionId: threadId,
            nativeHandle: threadId,
            metadata: {
              provider: CODEX_PROVIDER,
              cwd,
              title,
              threadId,
            },
          },
          timeline,
        });
      }

      return descriptors;
    } finally {
      await client.dispose();
    }
  }

  async listModels(_options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const child = this.spawnAppServer();
    const client = new CodexAppServerClient(child, this.logger);

    try {
      await client.request("initialize", {
        clientInfo: {
          name: "paseo",
          title: "Paseo",
          version: "0.0.0",
        },
      });
      client.notify("initialized", {});

      const response = (await client.request("model/list", {})) as { data?: Array<any> };
      const models = Array.isArray(response?.data) ? response.data : [];
      const configuredDefaults = await readCodexConfiguredDefaults(client, this.logger);
      const configuredDefaultModelId = configuredDefaults.model;
      const configuredDefaultThinkingOptionId = configuredDefaults.thinkingOptionId;
      const hasConfiguredDefaultModel =
        typeof configuredDefaultModelId === "string"
          ? models.some((model) => model?.id === configuredDefaultModelId)
          : false;
      return models.map((model) => {
        const defaultReasoningEffort = normalizeCodexThinkingOptionId(
          typeof model.defaultReasoningEffort === "string"
            ? model.defaultReasoningEffort
            : null
        );
        const resolvedDefaultReasoningEffort =
          configuredDefaultThinkingOptionId ?? defaultReasoningEffort;

        const thinkingById = new Map<string, { id: string; label: string; description?: string }>();
        if (Array.isArray(model.supportedReasoningEfforts)) {
          for (const entry of model.supportedReasoningEfforts) {
            const id = normalizeCodexThinkingOptionId(
              typeof entry?.reasoningEffort === "string" ? entry.reasoningEffort : null
            );
            if (!id) continue;
            const description =
              typeof entry?.description === "string" && entry.description.trim().length > 0
                ? entry.description
                : undefined;
            thinkingById.set(id, { id, label: id, description });
          }
        }

        if (resolvedDefaultReasoningEffort && !thinkingById.has(resolvedDefaultReasoningEffort)) {
          thinkingById.set(resolvedDefaultReasoningEffort, {
            id: resolvedDefaultReasoningEffort,
            label: resolvedDefaultReasoningEffort,
            description:
              configuredDefaultThinkingOptionId === resolvedDefaultReasoningEffort
                ? "Configured default reasoning effort"
                : "Model default reasoning effort",
          });
        }

        const thinkingOptions = Array.from(thinkingById.values()).map((option) => ({
          ...option,
          isDefault: option.id === resolvedDefaultReasoningEffort,
        }));
        const defaultThinkingOptionId =
          resolvedDefaultReasoningEffort ??
          thinkingOptions.find((option) => option.isDefault)?.id ??
          thinkingOptions[0]?.id;
        const isDefaultModel = hasConfiguredDefaultModel
          ? model.id === configuredDefaultModelId
          : model.isDefault;

        return {
          provider: CODEX_PROVIDER,
          id: model.id,
          label: model.displayName,
          description: model.description,
          isDefault: isDefaultModel,
          thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
          defaultThinkingOptionId,
          metadata: {
            model: model.model,
            defaultReasoningEffort: model.defaultReasoningEffort,
            supportedReasoningEfforts: model.supportedReasoningEfforts,
          },
        };
      });
    } finally {
      await client.dispose();
    }
  }

  async isAvailable(): Promise<boolean> {
    return isProviderCommandAvailable(this.runtimeSettings?.command, resolveCodexBinary);
  }
}
