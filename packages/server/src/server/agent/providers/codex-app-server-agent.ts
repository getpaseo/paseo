import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCommandResult,
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
  AgentUsage,
  ListModelsOptions,
  ListPersistedAgentsOptions,
  PersistedAgentDescriptor,
  ToolCallTimelineItem,
} from "../agent-sdk-types.js";
import type { Logger } from "pino";

import { execSync, spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs/promises";
import { Dirent } from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";


const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const CODEX_PROVIDER = "codex" as const;

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

function createToolCallTimelineItem(
  data: Omit<ToolCallTimelineItem, "type">
): AgentTimelineItem {
  return { type: "tool_call", ...data };
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

function extractContentText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    if (item && typeof item === "object") {
      const obj = item as { text?: string };
      if (typeof obj.text === "string") {
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

function threadItemToTimeline(
  item: any,
  options?: { includeUserMessage?: boolean }
): AgentTimelineItem | null {
  if (!item || typeof item !== "object") return null;
  const includeUserMessage = options?.includeUserMessage ?? true;
  switch (item.type) {
    case "userMessage": {
      if (!includeUserMessage) {
        return null;
      }
      const text = extractUserText(item.content) ?? "";
      return { type: "user_message", text };
    }
    case "agentMessage": {
      return { type: "assistant_message", text: item.text ?? "" };
    }
    case "plan": {
      const text = item.text ?? "";
      const items = parsePlanTextToTodoItems(text);
      return { type: "todo", items };
    }
    case "reasoning": {
      const summary = Array.isArray(item.summary) ? item.summary.join("\n") : "";
      const content = Array.isArray(item.content) ? item.content.join("\n") : "";
      const text = summary || content;
      return text ? { type: "reasoning", text } : null;
    }
    case "commandExecution": {
      const output = {
        type: "command",
        command: item.command,
        output: item.aggregatedOutput ?? "",
        exitCode: item.exitCode ?? undefined,
      };
      return createToolCallTimelineItem({
        name: "shell",
        status: item.status,
        callId: item.id,
        input: { command: item.command, cwd: item.cwd },
        output,
      });
    }
    case "fileChange": {
      const files = Array.isArray(item.changes)
        ? item.changes.map((change: any) => ({
            path: change.path,
            kind: change.kind,
          }))
        : [];
      const outputFiles = Array.isArray(item.changes)
        ? item.changes.map((change: any) => ({
            path: change.path,
            patch: change.diff,
            kind: change.kind,
          }))
        : [];
      return createToolCallTimelineItem({
        name: "apply_patch",
        status: item.status,
        callId: item.id,
        input: { files },
        output: { files: outputFiles },
      });
    }
    case "mcpToolCall": {
      if (item.tool === "read_file") {
        const pathValue = item.arguments?.path ?? item.arguments?.file_path ?? null;
        const content = extractContentText(item.result?.content) ?? "";
        return createToolCallTimelineItem({
          name: "read_file",
          status: item.status,
          callId: item.id,
          input: pathValue ? { path: pathValue } : item.arguments,
          output: pathValue
            ? { type: "read_file", path: pathValue, content }
            : item.result ?? undefined,
          error: item.error ?? undefined,
        });
      }
      return createToolCallTimelineItem({
        name: `${item.server}.${item.tool}`,
        status: item.status,
        callId: item.id,
        input: item.arguments,
        output: item.result ?? undefined,
        error: item.error ?? undefined,
      });
    }
    case "webSearch": {
      return createToolCallTimelineItem({
        name: "web_search",
        status: "completed",
        callId: item.id,
        input: { query: item.query },
        output: item.action ?? undefined,
      });
    }
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
  private latestUsage: AgentUsage | undefined;
  private connected = false;
  private paseoInstructionsInjected = false;
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
    logger: Logger
  ) {
    this.logger = logger.child({ module: "agent", provider: CODEX_PROVIDER });
    if (config.modeId === undefined) {
      throw new Error("Codex agent requires modeId to be specified");
    }
    validateCodexMode(config.modeId);
    this.currentMode = config.modeId;
    this.config = config;

    if (this.resumeHandle?.sessionId) {
      this.currentThreadId = this.resumeHandle.sessionId;
      this.historyPending = true;
      this.paseoInstructionsInjected = true;
    }
  }

  get id(): string | null {
    return this.currentThreadId;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const binaryPath = resolveCodexBinary();
    const child = spawn(binaryPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
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
      this.logger.debug({ error }, "Failed to load collaboration modes");
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
      this.logger.debug({ error }, "Failed to load skills list");
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
    if (match.developer_instructions) settings.developer_instructions = match.developer_instructions;
    if (this.config.model) settings.model = this.config.model;
    if (this.config.reasoningEffort) settings.reasoning_effort = this.config.reasoningEffort;
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
      const response = (await this.client.request("thread/read", {
        threadId: this.currentThreadId,
        includeTurns: true,
      })) as { thread?: { turns?: Array<{ items?: any[] }> } };
      const thread = response?.thread;
      if (!thread || !Array.isArray(thread.turns)) return;
      const timeline: AgentTimelineItem[] = [];
      for (const turn of thread.turns) {
        const items = Array.isArray(turn.items) ? turn.items : [];
        for (const item of items) {
          const timelineItem = threadItemToTimeline(item);
          if (timelineItem) {
            timeline.push(timelineItem);
          }
        }
      }
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
      await this.client.request("thread/resume", { threadId: this.currentThreadId });
    } catch (error) {
      this.logger.warn({ error }, "Failed to resume Codex thread, starting new thread");
      this.currentThreadId = null;
      await this.ensureThread();
    }
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    const events = this.stream(prompt, options);
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
      const input = this.buildUserInput(prompt);
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
      if (this.config.reasoningEffort) {
        params.effort = this.config.reasoningEffort;
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

      await this.client.request("turn/start", params);

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
    const info: AgentRuntimeInfo = {
      provider: CODEX_PROVIDER,
      sessionId: this.currentThreadId,
      model: this.config.model ?? null,
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
    this.pendingPermissionHandlers.delete(requestId);
    this.pendingPermissions.delete(requestId);
    this.resolvedPermissionRequests.add(requestId);

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
        reasoningEffort: this.config.reasoningEffort ?? null,
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

  async executeCommand(commandName: string, args?: string): Promise<AgentCommandResult> {
    if (commandName.startsWith("prompts:")) {
      const promptName = commandName.slice("prompts:".length);
      const codexHome = resolveCodexHomeDir();
      const promptPath = path.join(codexHome, "prompts", `${promptName}.md`);
      const raw = await fs.readFile(promptPath, "utf8");
      const parsed = parseFrontMatter(raw);
      const expanded = expandCodexCustomPrompt(parsed.body, args);
      const result = await this.run(expanded);
      return { text: result.finalText, timeline: result.timeline, usage: result.usage };
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
      const result = await this.run(input);
      return { text: result.finalText, timeline: result.timeline, usage: result.usage };
    }

    const skillPrompt = args ? `$${commandName} ${args}` : `$${commandName}`;
    const result = await this.run(skillPrompt);
    return { text: result.finalText, timeline: result.timeline, usage: result.usage };
  }

  private async ensureThread(): Promise<void> {
    if (!this.client) return;
    if (this.currentThreadId) return;
    const preset = MODE_PRESETS[this.currentMode] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
    const approvalPolicy = this.config.approvalPolicy ?? preset.approvalPolicy;
    const sandbox = this.config.sandboxMode ?? preset.sandbox;
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
    const response = (await this.client.request("thread/start", {
      model: this.config.model ?? null,
      cwd: this.config.cwd ?? null,
      approvalPolicy,
      sandbox,
      ...(Object.keys(innerConfig).length > 0 ? { config: innerConfig } : {}),
    })) as { thread?: { id?: string } };
    const threadId = response?.thread?.id;
    if (!threadId) {
      throw new Error("Codex app-server did not return thread id");
    }
    this.currentThreadId = threadId;
  }

  private buildUserInput(prompt: AgentPromptInput): unknown[] {
    if (typeof prompt === "string") {
      this.paseoInstructionsInjected = true;
      return [{ type: "text", text: prompt }];
    }
    const blocks = prompt as AgentPromptContentBlock[];
    if (this.paseoInstructionsInjected) {
      return blocks;
    }
    this.paseoInstructionsInjected = true;
    return blocks;
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
    this.emitEvent({ type: "provider_event", provider: CODEX_PROVIDER, raw: { method, params } });

    switch (method) {
      case "thread/started": {
        const threadId = (params as any)?.thread?.id;
        if (threadId) {
          this.currentThreadId = threadId;
          this.emitEvent({ type: "thread_started", provider: CODEX_PROVIDER, sessionId: threadId });
        }
        break;
      }
      case "turn/started": {
        const turnId = (params as any)?.turn?.id;
        if (turnId) {
          this.currentTurnId = turnId;
        }
        this.emitEvent({ type: "turn_started", provider: CODEX_PROVIDER });
        break;
      }
      case "turn/completed": {
        const turn = (params as any)?.turn;
        const status = turn?.status;
        if (status === "failed") {
          const message = turn?.error?.message ?? "Codex turn failed";
          this.emitEvent({ type: "turn_failed", provider: CODEX_PROVIDER, error: message });
        } else if (status === "interrupted") {
          this.emitEvent({ type: "turn_canceled", provider: CODEX_PROVIDER, reason: "interrupted" });
        } else {
          this.emitEvent({ type: "turn_completed", provider: CODEX_PROVIDER, usage: this.latestUsage });
        }
        this.eventQueue?.end();
        break;
      }
      case "turn/plan/updated": {
        const steps = (params as any)?.plan;
        if (Array.isArray(steps)) {
          const items = planStepsToTodoItems(
            steps.map((entry: any) => ({
              step: entry.step ?? "",
              status: entry.status ?? "pending",
            }))
          );
          this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: { type: "todo", items },
          });
        }
        break;
      }
      case "turn/diff/updated": {
        const diff = (params as any)?.diff;
        if (typeof diff === "string" && diff.trim().length > 0) {
          this.emitEvent({
            type: "timeline",
            provider: CODEX_PROVIDER,
            item: createToolCallTimelineItem({
              name: "apply_patch",
              status: "running",
              output: { diff },
            }),
          });
        }
        break;
      }
      case "thread/tokenUsage/updated": {
        const tokenUsage = (params as any)?.tokenUsage;
        this.latestUsage = toAgentUsage(tokenUsage);
        break;
      }
      case "item/agentMessage/delta": {
        const itemId = (params as any)?.itemId;
        const delta = (params as any)?.delta;
        if (itemId && typeof delta === "string") {
          const prev = this.pendingAgentMessages.get(itemId) ?? "";
          this.pendingAgentMessages.set(itemId, prev + delta);
        }
        break;
      }
      case "item/reasoning/summaryTextDelta": {
        const itemId = (params as any)?.itemId;
        const delta = (params as any)?.delta;
        if (itemId && typeof delta === "string") {
          const prev = this.pendingReasoning.get(itemId) ?? [];
          prev.push(delta);
          this.pendingReasoning.set(itemId, prev);
        }
        break;
      }
      case "item/completed": {
        const item = (params as any)?.item;
        const timelineItem = threadItemToTimeline(item, { includeUserMessage: false });
        if (timelineItem) {
          if (timelineItem.type === "assistant_message" && item?.id) {
            const buffered = this.pendingAgentMessages.get(item.id);
            if (buffered && buffered.length > 0) {
              timelineItem.text = buffered;
            }
          }
          if (timelineItem.type === "reasoning" && item?.id) {
            const buffered = this.pendingReasoning.get(item.id);
            if (buffered && buffered.length > 0) {
              timelineItem.text = buffered.join("");
            }
          }
          this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
        }
        break;
      }
      case "item/started": {
        const item = (params as any)?.item;
        const timelineItem = threadItemToTimeline(item, { includeUserMessage: false });
        if (timelineItem && timelineItem.type === "tool_call") {
          this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
        }
        break;
      }
      default:
        break;
    }
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

  constructor(private readonly logger: Logger) {}

  async createSession(config: AgentSessionConfig): Promise<AgentSession> {
    const sessionConfig: AgentSessionConfig = { ...config, provider: CODEX_PROVIDER };
    const session = new CodexAppServerAgentSession(sessionConfig, null, this.logger);
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
    const session = new CodexAppServerAgentSession(merged, handle, this.logger);
    await session.connect();
    return session;
  }

  async listPersistedAgents(
    options?: ListPersistedAgentsOptions
  ): Promise<PersistedAgentDescriptor[]> {
    const binaryPath = resolveCodexBinary();
    const child = spawn(binaryPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
          const read = (await client.request("thread/read", {
            threadId,
            includeTurns: true,
          })) as { thread?: { turns?: Array<{ items?: any[] }> } };
          const turns = read.thread?.turns ?? [];
          const items: AgentTimelineItem[] = [];
          for (const turn of turns) {
            for (const item of turn.items ?? []) {
              const timelineItem = threadItemToTimeline(item);
              if (timelineItem) items.push(timelineItem);
            }
          }
          timeline = items;
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
    const binaryPath = resolveCodexBinary();
    const child = spawn(binaryPath, ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
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
      return models.map((model) => ({
        provider: CODEX_PROVIDER,
        id: model.id,
        label: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
        metadata: {
          model: model.model,
          defaultReasoningEffort: model.defaultReasoningEffort,
          supportedReasoningEfforts: model.supportedReasoningEfforts,
        },
      }));
    } finally {
      await client.dispose();
    }
  }
}
