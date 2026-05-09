import type {
  AgentPermissionAction,
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentFeature,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  McpServerConfig,
  AgentPersistenceHandle,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPermissionResult,
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
import { homedir } from "node:os";

import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Dirent } from "node:fs";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { z } from "zod";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { curateAgentActivity } from "../activity-curator.js";
import {
  mapCodexRolloutToolCall,
  mapCodexToolCallFromThreadItem,
} from "./codex/tool-call-mapper.js";
import {
  createProviderEnv,
  createProviderEnvSpec,
  resolveProviderCommandPrefix,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { findExecutable, isCommandAvailable } from "../../../utils/executable.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { extractCodexTerminalSessionId, nonEmptyString } from "./tool-call-mapper-utils.js";
import { buildCodexFeatures, codexModelSupportsFastMode } from "./codex-feature-definitions.js";
import {
  renderProviderImageOutputAsAssistantMarkdown,
  type ProviderImageOutput,
} from "./provider-image-output.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";
import { runProviderTurn } from "./provider-runner.js";
import type { WorkspaceGitService } from "../../workspace-git-service.js";

function assertChildWithPipes(
  child: ChildProcess,
): asserts child is ChildProcessWithoutNullStreams {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("Child process did not expose stdio pipes");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

const DEFAULT_TIMEOUT_MS = 14 * 24 * 60 * 60 * 1000;
const TURN_START_TIMEOUT_MS = 90 * 1000;
const INTERRUPT_TIMEOUT_MS = 2_000;
const APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const CODEX_PROVIDER = "codex" as const;
const CODEX_IMAGE_ATTACHMENT_DIR = "paseo-attachments";
const ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN = "\n\n---\n\n";
const CODEX_TOOL_THREAD_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "collabAgentToolCall",
]);
const CODEX_PLAN_IMPLEMENTATION_PROMPT_PREFIX =
  "The user approved the plan. Implement it now. Do not restate or revise the plan unless blocked.";

// Codex's experimental `goals` feature ships in 0.128.0+. Older binaries reject
// `--enable goals` at launch, so we gate by version and silently skip the flag
// (and the /goal slash command) when the binary is too old.
const CODEX_GOALS_MIN_VERSION: readonly [number, number, number] = [0, 128, 0];

function parseCodexVersion(versionOutput: string): [number, number, number] | null {
  const match = versionOutput.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function codexVersionAtLeast(
  versionOutput: string,
  min: readonly [number, number, number],
): boolean {
  const parsed = parseCodexVersion(versionOutput);
  if (!parsed) return false;
  for (let i = 0; i < 3; i += 1) {
    if (parsed[i] > min[i]) return true;
    if (parsed[i] < min[i]) return false;
  }
  return true;
}

type GoalSubcommand =
  | { kind: "set"; objective: string }
  | { kind: "pause" }
  | { kind: "resume" }
  | { kind: "clear" }
  | { kind: "usage" };

function parseGoalSubcommand(args: string | undefined): GoalSubcommand {
  const trimmed = (args ?? "").trim();
  if (!trimmed) return { kind: "usage" };
  const lower = trimmed.toLowerCase();
  if (lower === "pause") return { kind: "pause" };
  if (lower === "resume") return { kind: "resume" };
  if (lower === "clear") return { kind: "clear" };
  return { kind: "set", objective: trimmed };
}

function formatOutOfBandStatusMessage(text: string): string {
  return `${text.replace(/\n+$/u, "")}\n\n`;
}

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
    id: "auto",
    label: "Default Permissions",
    description: "Edit files and run commands with Codex's default approval flow.",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Edit files, run commands, and access the network without additional prompts.",
  },
];

const DEFAULT_CODEX_MODE_ID = "auto";

interface CodexAppServerClientLike {
  request(method: string, params?: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  dispose(): Promise<void>;
}

interface CodexAppServerAgentDeps {
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  _createCodexClient?: (
    child: ChildProcessWithoutNullStreams,
    logger: Logger,
  ) => CodexAppServerClientLike;
}

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
    throw new Error(`Invalid Codex mode "${modeId}". Valid modes are: ${validModes}`);
  }
}

function normalizeCodexThinkingOptionId(
  thinkingOptionId: string | null | undefined,
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

function normalizeCodexModelLabel(displayName: string): string {
  return displayName.replace(/\bgpt\b/gi, "GPT");
}

function isSchemaRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObjectSchemaNode(schema: Record<string, unknown>): boolean {
  const type = schema.type;
  return (
    isSchemaRecord(schema.properties) ||
    type === "object" ||
    (Array.isArray(type) && type.includes("object"))
  );
}

function normalizeCodexOutputSchemaNode(schema: unknown, schemaPath: string): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry, index) =>
      normalizeCodexOutputSchemaNode(entry, `${schemaPath}[${index}]`),
    );
  }
  if (!isSchemaRecord(schema)) {
    return schema;
  }

  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(schema)) {
    normalized[key] = normalizeCodexOutputSchemaNode(value, `${schemaPath}.${key}`);
  }

  if (!isObjectSchemaNode(normalized)) {
    return normalized;
  }

  if (normalized.additionalProperties === undefined) {
    normalized.additionalProperties = false;
  } else if (normalized.additionalProperties !== false) {
    throw new Error(
      `Codex structured outputs require ${schemaPath} to set additionalProperties to false for object schemas.`,
    );
  }

  const properties = isSchemaRecord(normalized.properties) ? normalized.properties : null;
  if (!properties) {
    return normalized;
  }

  const propertyKeys = Object.keys(properties);
  const existingRequired = Array.isArray(normalized.required)
    ? normalized.required.filter((entry): entry is string => typeof entry === "string")
    : [];
  normalized.required = Array.from(new Set([...existingRequired, ...propertyKeys]));
  return normalized;
}

function normalizeCodexOutputSchema(schema: unknown): Record<string, unknown> {
  if (!isSchemaRecord(schema)) {
    throw new Error("Codex structured outputs require a JSON object schema.");
  }

  const normalized = normalizeCodexOutputSchemaNode(schema, "$");
  if (!isSchemaRecord(normalized) || !isObjectSchemaNode(normalized)) {
    throw new Error("Codex structured outputs require a root object schema.");
  }

  return normalized;
}

interface CodexConfiguredDefaults {
  model?: string;
  thinkingOptionId?: string;
}

function mergeCodexConfiguredDefaults(
  primary: CodexConfiguredDefaults,
  fallback: CodexConfiguredDefaults,
): CodexConfiguredDefaults {
  return {
    model: primary.model ?? fallback.model,
    thinkingOptionId: primary.thinkingOptionId ?? fallback.thinkingOptionId,
  };
}

async function resolveCodexBinary(): Promise<string> {
  const found = await findExecutable("codex");
  if (found) {
    return found;
  }
  throw new Error(
    "Codex binary not found. Install the Codex CLI (https://github.com/openai/codex) and ensure it is available in your shell PATH.",
  );
}

async function resolveCodexLaunchPrefix(runtimeSettings?: ProviderRuntimeSettings): Promise<{
  command: string;
  args: string[];
}> {
  return resolveProviderCommandPrefix(runtimeSettings?.command, resolveCodexBinary);
}

function resolveCodexHomeDir(): string {
  return process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

function decodeEscapedChar(next: string): string {
  if (next === "n") return "\n";
  if (next === "t") return "\t";
  return next;
}

function resolvePermissionDecision(
  response: AgentPermissionResponse,
): "accept" | "cancel" | "decline" {
  if (response.behavior === "allow") return "accept";
  if (response.interrupt) return "cancel";
  return "decline";
}

function firstPositiveFiniteNumber(primary: unknown, secondary: unknown): number | undefined {
  if (typeof primary === "number" && Number.isFinite(primary) && primary > 0) {
    return primary;
  }
  if (typeof secondary === "number" && Number.isFinite(secondary) && secondary > 0) {
    return secondary;
  }
  return undefined;
}

function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      if (ch === "\\" && i + 1 < args.length) {
        const next = args[i + 1];
        if (next === quote || next === "\\" || next === "n" || next === "t") {
          i += 1;
          current += decodeEscapedChar(next);
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

  const mdEntries = entries.filter(
    (entry) => entry.isFile() && entry.name.endsWith(".md") && entry.name.slice(0, -".md".length),
  );
  const parsedCommands = await Promise.all(
    mdEntries.map(async (entry): Promise<AgentSlashCommand | null> => {
      const name = entry.name.slice(0, -".md".length);
      const fullPath = path.join(promptsDir, entry.name);
      let content: string;
      try {
        content = await fs.readFile(fullPath, "utf8");
      } catch {
        return null;
      }
      const parsed = parseFrontMatter(content);
      const description = parsed.frontMatter["description"] ?? "Custom prompt";
      const argumentHint =
        parsed.frontMatter["argument-hint"] ?? parsed.frontMatter["argument_hint"] ?? "";
      return {
        name: `prompts:${name}`,
        description,
        argumentHint,
      };
    }),
  );
  const commands: AgentSlashCommand[] = parsedCommands.filter(
    (cmd): cmd is AgentSlashCommand => cmd !== null,
  );
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function listCodexSkills(
  cwd: string,
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">,
): Promise<AgentSlashCommand[]> {
  const candidates: string[] = [];
  candidates.push(path.join(cwd, ".codex", "skills"));

  const repoRoot = workspaceGitService
    ? await workspaceGitService.resolveRepoRoot(cwd).catch(() => null)
    : null;
  if (repoRoot) {
    candidates.push(path.join(path.dirname(cwd), ".codex", "skills"));
    candidates.push(path.join(repoRoot, ".codex", "skills"));
  }

  candidates.push(path.join(resolveCodexHomeDir(), "skills"));

  const candidateReads = await Promise.all(
    candidates.map(async (dir) => {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return [] as string[];
      }
      const dirEntries = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink());
      const skillContents = await Promise.all(
        dirEntries.map(async (entry) => {
          const skillDir = path.join(dir, entry.name);
          const skillPath = path.join(skillDir, "SKILL.md");
          try {
            return await fs.readFile(skillPath, "utf8");
          } catch {
            return null;
          }
        }),
      );
      return skillContents.filter((content): content is string => content !== null);
    }),
  );

  const commandsByName = new Map<string, AgentSlashCommand>();
  for (const skillContents of candidateReads) {
    for (const content of skillContents) {
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

  return Array.from(commandsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
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
    default: {
      const _exhaustive = config as { type: never };
      throw new Error(`Unsupported MCP config type: ${String(_exhaustive.type)}`);
    }
  }
}
interface JsonRpcRequest {
  id: number;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  id: number;
  result?: unknown;
  error?: { code?: number; message: string };
}

interface JsonRpcNotification {
  method: string;
  params?: unknown;
}

function isJsonRpcResponse(msg: unknown): msg is JsonRpcResponse {
  if (!isRecord(msg)) return false;
  if (typeof msg.id !== "number") return false;
  return msg.result !== undefined || !!msg.error;
}

function isJsonRpcRequest(msg: unknown): msg is JsonRpcRequest {
  if (!isRecord(msg)) return false;
  return typeof msg.id === "number" && typeof msg.method === "string";
}

function isJsonRpcNotification(msg: unknown): msg is JsonRpcNotification {
  if (!isRecord(msg)) return false;
  return typeof msg.method === "string" && typeof msg.id !== "number";
}

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

type RequestHandler = (params: unknown) => unknown;

type NotificationHandler = (method: string, params: unknown) => void;

// Codex app-server API response types
interface CodexReasoningEffortEntry {
  reasoningEffort?: string;
  description?: string;
}

interface CodexModel {
  id: string;
  displayName?: string;
  description?: string;
  isDefault?: boolean;
  model?: string;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: CodexReasoningEffortEntry[];
}

const CodexModelListResponseSchema = z.object({
  data: z
    .array(
      z.object({
        id: z.string(),
        displayName: z.string().optional(),
        description: z.string().optional(),
        isDefault: z.boolean().optional(),
        model: z.string().optional(),
        defaultReasoningEffort: z.string().optional(),
        supportedReasoningEfforts: z
          .array(
            z.object({
              reasoningEffort: z.string().optional(),
              description: z.string().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

function filterCodexThreadsByCwd(
  threads: Array<Record<string, unknown>>,
  cwd: string | undefined,
): Array<Record<string, unknown>> {
  if (!cwd) {
    return threads;
  }
  // thread/list rows carry an optional cwd. The descriptor builder later
  // falls back to process.cwd() if the field is missing, so we only match
  // here when the row genuinely carries a cwd string — otherwise threads
  // with no cwd would falsely match the daemon's own cwd.
  return threads.filter((thread) => typeof thread.cwd === "string" && thread.cwd === cwd);
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
    private readonly logger: Logger,
  ) {
    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    child.stderr.on("data", (chunk) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > 8192) {
        this.stderrBuffer = this.stderrBuffer.slice(-8192);
      }
    });

    child.on("error", (err) => {
      this.logger.error({ err }, "Codex app-server child process error");
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
      }
      this.pending.clear();
      this.disposed = true;
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

  private writeJsonRpcResponse(response: JsonRpcResponse): void {
    if (this.disposed || this.child.stdin.destroyed || !this.child.stdin.writable) {
      return;
    }
    try {
      this.child.stdin.write(`${JSON.stringify(response)}\n`);
    } catch (error) {
      this.logger.debug({ error }, "Failed to write Codex app-server JSON-RPC response");
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rl.close();
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
    const result = await terminateWithTreeKill(this.child, {
      gracefulTimeoutMs: APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.logger.warn(
          { timeoutMs: APP_SERVER_GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "Codex app-server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.logger.warn(
        { timeoutMs: APP_SERVER_FORCE_SHUTDOWN_TIMEOUT_MS },
        "Codex app-server did not report exit after SIGKILL",
      );
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (!line.trim()) return;
    const raw: unknown = JSON.parse(line);
    if (!isRecord(raw)) {
      this.logger.warn({ line }, "Parsed JSON is not an object");
      return;
    }

    if (isJsonRpcResponse(raw)) {
      const id = raw.id;
      if (raw.result !== undefined || raw.error) {
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (raw.error) {
          pending.reject(new Error(raw.error.message ?? "Unknown error"));
        } else {
          pending.resolve(raw.result);
        }
        return;
      }

      // Server-initiated request
      if (isJsonRpcRequest(raw)) {
        const request = raw;
        const handler = this.requestHandlers.get(request.method);
        try {
          const result = handler ? await handler(request.params) : {};
          this.writeJsonRpcResponse({ id: request.id, result });
        } catch (error) {
          this.writeJsonRpcResponse({
            id: request.id,
            error: { message: error instanceof Error ? error.message : String(error) },
          });
        }
        return;
      }
    }

    if (isJsonRpcNotification(raw)) {
      this.notificationHandler?.(raw.method, raw.params);
    }
  }
}

function toAgentUsage(tokenUsage: unknown): AgentUsage | undefined {
  const usage = toObjectRecord(tokenUsage);
  if (!usage) return undefined;
  const last = toObjectRecord(usage.last);
  const contextWindowMaxTokens = firstPositiveFiniteNumber(
    usage.model_context_window,
    usage.modelContextWindow,
  );
  const contextWindowUsedTokens = firstPositiveFiniteNumber(last?.total_tokens, last?.totalTokens);
  return {
    inputTokens: typeof last?.inputTokens === "number" ? last.inputTokens : undefined,
    cachedInputTokens:
      typeof last?.cachedInputTokens === "number" ? last.cachedInputTokens : undefined,
    outputTokens: typeof last?.outputTokens === "number" ? last.outputTokens : undefined,
    ...(contextWindowMaxTokens !== undefined ? { contextWindowMaxTokens } : {}),
    ...(contextWindowUsedTokens !== undefined ? { contextWindowUsedTokens } : {}),
  };
}

function extractUserText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const record = toObjectRecord(item);
    if (!record) {
      continue;
    }
    if (record.type === "text" && typeof record.text === "string") {
      parts.push(record.text);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function normalizePlanMarkdown(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/, ""))
    .join("\n")
    .trim();
}

function planStepsToMarkdown(steps: Array<{ step: string; status: string }>): string {
  const lines = steps
    .map((entry) => entry.step.trim())
    .filter((step) => step.length > 0)
    .map((step) => {
      if (/^(#{1,6}\s|[-*+]\s|\d+\.\s)/.test(step)) {
        return step;
      }
      return `- ${step}`;
    });
  return normalizePlanMarkdown(lines.join("\n"));
}

function mapCodexPlanToToolCall(params: {
  callId: string;
  text: string;
}): ToolCallTimelineItem | null {
  const text = normalizePlanMarkdown(params.text);
  if (!text) {
    return null;
  }
  return {
    type: "tool_call",
    callId: params.callId,
    name: "plan",
    status: "completed",
    error: null,
    detail: {
      type: "plan",
      text,
    },
  };
}

function buildPlanPermissionActions(options?: {
  includeResumeAction?: boolean;
  resumeLabel?: string;
}): AgentPermissionAction[] {
  const actions: AgentPermissionAction[] = [
    {
      id: "reject",
      label: "Reject",
      behavior: "deny",
      variant: "danger",
      intent: "dismiss",
    },
    {
      id: "implement",
      label: "Implement",
      behavior: "allow",
      variant: "primary",
      intent: "implement",
    },
  ];

  if (options?.includeResumeAction && options.resumeLabel) {
    actions.push({
      id: "implement_resume",
      label: options.resumeLabel,
      behavior: "allow",
      variant: "secondary",
      intent: "implement_resume",
    });
  }

  return actions;
}

function buildCodexPlanImplementationPrompt(planText: string): string {
  const normalizedPlan = normalizePlanMarkdown(planText);
  if (!normalizedPlan) {
    return `${CODEX_PLAN_IMPLEMENTATION_PROMPT_PREFIX} Make the required code changes and verify them.`;
  }

  return [
    CODEX_PLAN_IMPLEMENTATION_PROMPT_PREFIX,
    "Approved plan:",
    normalizedPlan,
    "Carry out the work, make the necessary code changes, and verify the result.",
  ].join("\n\n");
}

interface CodexQuestionOption {
  label: string;
  description?: string;
}

interface CodexQuestionPrompt {
  id: string;
  header: string;
  question: string;
  options: CodexQuestionOption[];
  multiSelect?: boolean;
  isOther?: boolean;
  isSecret?: boolean;
}

function normalizeCodexQuestionPrompts(raw: unknown): CodexQuestionPrompt[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const questions: CodexQuestionPrompt[] = [];
  for (const item of raw) {
    const record = toObjectRecord(item);
    if (!record) {
      continue;
    }
    const id = nonEmptyString(record.id);
    const header = nonEmptyString(record.header);
    const question = nonEmptyString(record.question);
    if (!id || !header || !question) {
      continue;
    }
    const options = Array.isArray(record.options)
      ? record.options.flatMap((option): CodexQuestionOption[] => {
          const optionRecord = toObjectRecord(option);
          if (!optionRecord) {
            return [];
          }
          const label = nonEmptyString(optionRecord.label);
          if (!label) {
            return [];
          }
          return [
            {
              label,
              ...(typeof optionRecord.description === "string" &&
              optionRecord.description.trim().length > 0
                ? { description: optionRecord.description }
                : {}),
            },
          ];
        })
      : [];
    questions.push({
      id,
      header,
      question,
      options,
      ...(record.multiSelect === true ? { multiSelect: true } : {}),
      ...(record.isOther === true ? { isOther: true } : {}),
      ...(record.isSecret === true ? { isSecret: true } : {}),
    });
  }
  return questions;
}

function formatCodexQuestionPrompts(questions: CodexQuestionPrompt[]): string {
  return questions
    .map((question) => {
      const lines = [`${question.header}: ${question.question}`];
      if (question.options.length > 0) {
        lines.push(`Options: ${question.options.map((option) => option.label).join(", ")}`);
      }
      return lines.join("\n");
    })
    .join("\n\n")
    .trim();
}

function mapCodexQuestionRequestToToolCall(params: {
  callId: string;
  questions: CodexQuestionPrompt[];
  status: ToolCallTimelineItem["status"];
  answers?: Record<string, string[]>;
  error?: unknown;
}): ToolCallTimelineItem {
  const formattedQuestions = formatCodexQuestionPrompts(params.questions);
  const formattedAnswers =
    params.answers && Object.keys(params.answers).length > 0
      ? Object.entries(params.answers)
          .map(([id, values]) => `${id}: ${values.join(", ")}`)
          .join("\n")
      : null;
  const detailText =
    params.status === "completed" && formattedAnswers
      ? [formattedQuestions, "Answers:", formattedAnswers].filter(Boolean).join("\n\n")
      : formattedQuestions;

  const base = {
    type: "tool_call" as const,
    callId: params.callId,
    name: "request_user_input",
    detail: {
      type: "plain_text" as const,
      text: detailText,
      icon: "brain" as const,
    },
    metadata: {
      questions: params.questions,
      ...(params.answers ? { answers: params.answers } : {}),
    },
  };

  if (params.status === "failed") {
    return {
      ...base,
      status: "failed",
      error: params.error ?? { message: "Question dismissed" },
    };
  }
  if (params.status === "canceled") {
    return {
      ...base,
      status: "canceled",
      error: null,
    };
  }
  if (params.status === "running") {
    return {
      ...base,
      status: "running",
      error: null,
    };
  }
  return {
    ...base,
    status: "completed",
    error: null,
  };
}

function mapCodexQuestionResponseByHeader(params: {
  questions: CodexQuestionPrompt[];
  response: AgentPermissionResponse;
}): Record<string, { answers: string[] }> | null {
  if (params.response.behavior !== "allow") {
    return null;
  }
  const updatedInputRecord = toObjectRecord(params.response.updatedInput);
  const answersRecord = toObjectRecord(updatedInputRecord?.answers);
  if (!answersRecord) {
    return null;
  }

  const answers: Record<string, { answers: string[] }> = {};
  for (const question of params.questions) {
    const rawAnswer = answersRecord[question.header];
    if (typeof rawAnswer !== "string") {
      continue;
    }
    const normalizedAnswer = rawAnswer.trim();
    if (!normalizedAnswer) {
      continue;
    }
    const values = question.multiSelect
      ? normalizedAnswer
          .split(",")
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0)
      : [normalizedAnswer];
    if (values.length > 0) {
      answers[question.id] = { answers: values };
    }
  }

  return Object.keys(answers).length > 0 ? answers : null;
}

interface CodexPatchFileChange {
  path: string;
  kind?: string;
  content?: string;
}

function extractPatchLikeText(value: unknown): string | undefined {
  const record = toObjectRecord(value);
  if (!record) {
    return undefined;
  }
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
    case "CollabAgentToolCall":
      return "collabAgentToolCall";
    case "ImageView":
      return "imageView";
    case "ImageGeneration":
      return "imageGeneration";
    default:
      return rawType;
  }
}

function normalizeCodexCommandValue(value: unknown): string | string[] | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.length) {
      return null;
    }
    const wrapperMatch = trimmed.match(/^(?:\/bin\/)?(?:zsh|bash|sh)\s+-(?:lc|c)\s+([\s\S]+)$/);
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
  const resolvePathFromRecord = (record: Record<string, unknown>): string => {
    const directPath =
      (typeof record.path === "string" && record.path.trim().length > 0
        ? record.path.trim()
        : "") ||
      (typeof record.file_path === "string" && record.file_path.trim().length > 0
        ? record.file_path.trim()
        : "") ||
      (typeof record.filePath === "string" && record.filePath.trim().length > 0
        ? record.filePath.trim()
        : "");
    return directPath;
  };

  if (!changes || typeof changes !== "object") {
    return [];
  }

  if (Array.isArray(changes)) {
    return changes
      .map((entry): CodexPatchFileChange | null => {
        const record = toObjectRecord(entry);
        if (!record) {
          return null;
        }
        const pathValue = resolvePathFromRecord(record);
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

  const recordChanges = toObjectRecord(changes);
  if (!recordChanges) {
    return [];
  }
  const directPathValue = resolvePathFromRecord(recordChanges);
  if (directPathValue) {
    return [
      {
        path: directPathValue,
        kind:
          (typeof recordChanges.kind === "string" && recordChanges.kind) ||
          (typeof recordChanges.type === "string" && recordChanges.type) ||
          undefined,
        content: extractPatchLikeText(recordChanges),
      },
    ];
  }

  return Object.entries(recordChanges)
    .map(([entryPath, value]): CodexPatchFileChange | null => {
      const normalizedPath = entryPath.trim();
      if (!normalizedPath) {
        return null;
      }
      return {
        path: normalizedPath,
        kind:
          value &&
          typeof value === "object" &&
          typeof (value as { type?: unknown }).type === "string"
            ? ((value as { type?: string }).type ?? undefined)
            : undefined,
        content: extractPatchLikeText(value),
      };
    })
    .filter((entry): entry is CodexPatchFileChange => entry !== null);
}

function codexPatchTextFields(text: string | null | undefined): {
  patch?: string;
  content?: string;
} {
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
    typeof item.detail.unifiedDiff === "string" && item.detail.unifiedDiff.trim().length > 0;
  const hasNewString =
    typeof item.detail.newString === "string" && item.detail.newString.trim().length > 0;
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
    const normalizedRoundTrip = Buffer.from(decoded, "utf8").toString("base64").replace(/=+$/, "");
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
  const isFailure = params.running
    ? false
    : params.success === false || (typeof params.exitCode === "number" && params.exitCode !== 0);
  const output = params.running
    ? null
    : {
        command,
        ...(params.output !== null && params.output !== undefined ? { output: params.output } : {}),
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
    error: isFailure ? { message: params.stderr?.trim() || "Command failed" } : null,
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
                files: files.map((file) =>
                  Object.assign(
                    { path: file.path },
                    file.kind ? { kind: file.kind } : {},
                    codexPatchTextFields(file.content ?? patchText),
                  ),
                ),
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

function mapCodexTerminalInteractionToToolCall(params: {
  processId?: string | null;
  fallbackCallId?: string | null;
  command?: string | null;
}): ToolCallTimelineItem {
  const processId = nonEmptyString(params.processId ?? undefined);
  const callId = processId
    ? `terminal-session-${processId}`
    : (nonEmptyString(params.fallbackCallId ?? undefined) ?? "terminal-interaction");
  const label = nonEmptyString(params.command ?? undefined);
  return {
    type: "tool_call",
    callId,
    name: "terminal",
    status: "completed",
    error: null,
    detail: {
      type: "plain_text",
      ...(label ? { label } : {}),
      icon: "square_terminal",
    },
    ...(processId ? { metadata: { processId } } : {}),
  };
}

function mapCodexThreadPlanItem(normalizedItem: Record<string, unknown>): AgentTimelineItem | null {
  const callId =
    nonEmptyString(normalizedItem.id ?? normalizedItem.itemId ?? undefined) ??
    `plan:${normalizePlanMarkdown(typeof normalizedItem.text === "string" ? normalizedItem.text : "")}`;
  return mapCodexPlanToToolCall({
    callId,
    text: typeof normalizedItem.text === "string" ? normalizedItem.text : "",
  });
}

function mapCodexThreadReasoningItem(
  normalizedItem: Record<string, unknown>,
): AgentTimelineItem | null {
  const summary = Array.isArray(normalizedItem.summary) ? normalizedItem.summary.join("\n") : "";
  const content = Array.isArray(normalizedItem.content) ? normalizedItem.content.join("\n") : "";
  const text = summary || content;
  return text ? { type: "reasoning", text } : null;
}

function mapCodexThreadUserMessageItem(
  normalizedItem: Record<string, unknown>,
  includeUserMessage: boolean,
): AgentTimelineItem | null {
  if (!includeUserMessage) {
    return null;
  }
  const text = extractUserText(normalizedItem.content) ?? "";
  return { type: "user_message", text };
}

function firstStringField(
  record: Record<string, unknown>,
  fields: readonly string[],
): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string") {
      return value;
    }
  }
  return null;
}

function codexImageOutputFromResult(result: unknown): ProviderImageOutput | null {
  if (typeof result === "string") {
    const trimmed = result.trim();
    if (
      trimmed.toLowerCase().startsWith("data:image/") ||
      (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length > 64)
    ) {
      return { data: trimmed };
    }
    return { url: trimmed };
  }
  const resultRecord = toObjectRecord(result);
  if (!resultRecord) {
    return null;
  }
  return {
    path: firstStringField(resultRecord, ["path", "savedPath", "saved_path"]),
    url: firstStringField(resultRecord, ["url"]),
    data: firstStringField(resultRecord, ["data"]),
    mimeType: firstStringField(resultRecord, ["mimeType", "mime_type"]),
  };
}

function writeImageAttachmentSync(mimeType: string, data: string): string {
  const attachmentsDir = path.join(os.tmpdir(), CODEX_IMAGE_ATTACHMENT_DIR);
  fsSync.mkdirSync(attachmentsDir, { recursive: true });
  const normalized = normalizeImageData(mimeType, data);
  const extension = getImageExtension(normalized.mimeType);
  const filename = `${randomUUID()}.${extension}`;
  const filePath = path.join(attachmentsDir, filename);
  fsSync.writeFileSync(filePath, Buffer.from(normalized.data, "base64"));
  return filePath;
}

function materializeCodexImageOutput(image: { data: string; mimeType: string | null }): {
  path: string;
} {
  return {
    path: writeImageAttachmentSync(image.mimeType ?? "image/png", image.data),
  };
}

function mapCodexThreadImageItem(
  normalizedType: string,
  normalizedItem: Record<string, unknown>,
): AgentTimelineItem | null {
  if (normalizedType === "imageView") {
    return renderProviderImageOutputAsAssistantMarkdown({
      path: firstStringField(normalizedItem, ["path"]),
    });
  }

  const savedPath = firstStringField(normalizedItem, ["savedPath", "saved_path"]);
  const result = codexImageOutputFromResult(normalizedItem.result);
  return renderProviderImageOutputAsAssistantMarkdown(
    {
      path: savedPath ?? result?.path ?? null,
      url: result?.url ?? null,
      data: result?.data ?? null,
      mimeType: result?.mimeType ?? null,
    },
    { materialize: materializeCodexImageOutput },
  );
}

function threadItemToTimeline(
  item: unknown,
  options?: { includeUserMessage?: boolean; cwd?: string | null },
): AgentTimelineItem | null {
  const itemRecord = toObjectRecord(item);
  if (!itemRecord) return null;
  const includeUserMessage = options?.includeUserMessage ?? true;
  const cwd = options?.cwd ?? null;
  const normalizedType = normalizeCodexThreadItemType(
    typeof itemRecord.type === "string" ? itemRecord.type : undefined,
  );
  const normalizedItem: Record<string, unknown> =
    normalizedType && normalizedType !== itemRecord.type
      ? { ...itemRecord, type: normalizedType }
      : itemRecord;

  if (normalizedType === "imageView" || normalizedType === "imageGeneration") {
    return mapCodexThreadImageItem(normalizedType, normalizedItem);
  }
  if (normalizedType && CODEX_TOOL_THREAD_ITEM_TYPES.has(normalizedType)) {
    return mapCodexToolCallFromThreadItem(normalizedItem, { cwd });
  }

  switch (normalizedType) {
    case "userMessage":
      return mapCodexThreadUserMessageItem(normalizedItem, includeUserMessage);
    case "agentMessage":
      return {
        type: "assistant_message",
        text: typeof normalizedItem.text === "string" ? normalizedItem.text : "",
      };
    case "plan":
      return mapCodexThreadPlanItem(normalizedItem);
    case "reasoning":
      return mapCodexThreadReasoningItem(normalizedItem);
    default:
      return null;
  }
}

const CodexThreadReadResponseSchema = z
  .object({
    thread: z
      .object({
        turns: z
          .array(
            z
              .object({
                items: z.array(z.unknown()).default([]),
              })
              .passthrough(),
          )
          .default([]),
      })
      .passthrough()
      .default({ turns: [] }),
  })
  .passthrough();

type CodexThreadReadResponse = z.infer<typeof CodexThreadReadResponseSchema>;
type CodexThreadReadRequest = (threadId: string) => Promise<unknown>;

async function requestCodexThreadHistory(
  requestThread: CodexThreadReadRequest,
  threadId: string,
): Promise<CodexThreadReadResponse> {
  const response = await requestThread(threadId);
  return CodexThreadReadResponseSchema.parse(response);
}

async function loadCodexThreadHistoryTimeline(params: {
  threadId: string;
  cwd: string | null;
  requestThread: CodexThreadReadRequest;
}): Promise<AgentTimelineItem[]> {
  const response = await requestCodexThreadHistory(params.requestThread, params.threadId);
  const timeline: AgentTimelineItem[] = [];
  for (const turn of response.thread.turns) {
    for (const item of turn.items) {
      const timelineItem = threadItemToTimeline(item, { cwd: params.cwd });
      if (timelineItem) {
        timeline.push(timelineItem);
      }
    }
  }
  return timeline;
}

function readCodexThread(client: CodexAppServerClientLike, threadId: string): Promise<unknown> {
  return client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
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

interface ImageDataPayload {
  mimeType: string;
  data: string;
}

function normalizeImageData(mimeType: string, data: string): ImageDataPayload {
  if (data.startsWith("data:")) {
    const match = data.match(/^data:([^;]+);base64,(.*)$/);
    if (match) {
      return { mimeType: match[1], data: match[2] };
    }
  }
  return { mimeType, data };
}

const ThreadStartedNotificationSchema = z
  .object({
    thread: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough();

const TurnStartedNotificationSchema = z
  .object({
    threadId: z.string().optional(),
    turn: z.object({ id: z.string() }).passthrough(),
  })
  .passthrough();

const TurnCompletedNotificationSchema = z
  .object({
    threadId: z.string().optional(),
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
  })
  .passthrough();

const TurnPlanUpdatedNotificationSchema = z
  .object({
    plan: z.array(
      z
        .object({
          step: z.string().optional(),
          status: z.string().optional(),
        })
        .passthrough(),
    ),
  })
  .passthrough();

const TurnDiffUpdatedNotificationSchema = z
  .object({
    diff: z.string(),
  })
  .passthrough();

const ThreadTokenUsageUpdatedNotificationSchema = z
  .object({
    tokenUsage: z.unknown(),
  })
  .passthrough();

const ItemTextDeltaNotificationSchema = z
  .object({
    threadId: z.string().optional(),
    itemId: z.string(),
    delta: z.string(),
  })
  .passthrough();

const ItemLifecycleNotificationSchema = z
  .object({
    threadId: z.string().optional(),
    item: z
      .object({
        id: z.string().optional(),
        type: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventTurnAbortedNotificationSchema = z
  .object({
    msg: z
      .object({
        type: z.literal("turn_aborted"),
        reason: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventTaskCompleteNotificationSchema = z
  .object({
    msg: z
      .object({
        type: z.literal("task_complete"),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventItemLifecycleNotificationSchema = z
  .object({
    threadId: z.string().optional(),
    msg: z
      .object({
        type: z.enum(["item_started", "item_completed"]),
        threadId: z.string().optional(),
        thread_id: z.string().optional(),
        item: z
          .object({
            id: z.string().optional(),
            type: z.string().optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventExecCommandBeginNotificationSchema = z
  .object({
    msg: z
      .object({
        type: z.literal("exec_command_begin"),
        call_id: z.string().optional(),
        command: z.unknown().optional(),
        cwd: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventExecCommandEndNotificationSchema = z
  .object({
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
  })
  .passthrough();

const CodexEventExecCommandOutputDeltaNotificationSchema = z
  .object({
    msg: z
      .object({
        type: z.literal("exec_command_output_delta"),
        call_id: z.string().optional(),
        stream: z.string().optional(),
        chunk: z.string().optional(),
        delta: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventTerminalInteractionNotificationSchema = z
  .object({
    msg: z
      .object({
        type: z.literal("terminal_interaction"),
        call_id: z.string().optional(),
        process_id: z.union([z.string(), z.number()]).optional(),
        stdin: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const ItemCommandExecutionTerminalInteractionNotificationSchema = z
  .object({
    itemId: z.string().optional(),
    processId: z.union([z.string(), z.number()]).optional(),
    stdin: z.string().optional(),
  })
  .passthrough();

const CodexEventPatchApplyBeginNotificationSchema = z
  .object({
    msg: z
      .object({
        type: z.literal("patch_apply_begin"),
        call_id: z.string().optional(),
        changes: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventPatchApplyEndNotificationSchema = z
  .object({
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
  })
  .passthrough();

const ItemFileChangeOutputDeltaNotificationSchema = z
  .object({
    itemId: z.string(),
    delta: z.string().optional(),
    chunk: z.string().optional(),
  })
  .passthrough();

const CodexEventTurnDiffNotificationSchema = z
  .object({
    msg: z
      .object({
        type: z.literal("turn_diff"),
        unified_diff: z.string().optional(),
        diff: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

type ParsedCodexNotification =
  | { kind: "thread_started"; threadId: string }
  | { kind: "turn_started"; turnId: string; threadId: string | null }
  | {
      kind: "turn_completed";
      status: string;
      errorMessage: string | null;
      threadId: string | null;
    }
  | { kind: "plan_updated"; plan: Array<{ step: string | null; status: string | null }> }
  | { kind: "diff_updated"; diff: string }
  | { kind: "token_usage_updated"; tokenUsage: unknown }
  | { kind: "agent_message_delta"; itemId: string; delta: string; threadId: string | null }
  | { kind: "reasoning_delta"; itemId: string; delta: string; threadId: string | null }
  | {
      kind: "item_completed";
      source: "item" | "codex_event";
      threadId: string | null;
      item: { id?: string; type?: string; [key: string]: unknown };
    }
  | {
      kind: "item_started";
      source: "item" | "codex_event";
      threadId: string | null;
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
      kind: "terminal_interaction";
      source: "item" | "codex_event";
      callId: string | null;
      processId: string | null;
      stdin: string | null;
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
  z
    .object({ method: z.literal("thread/started"), params: ThreadStartedNotificationSchema })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "thread_started",
        threadId: params.thread.id,
      }),
    ),
  z.object({ method: z.literal("thread/started"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z.object({ method: z.literal("turn/started"), params: TurnStartedNotificationSchema }).transform(
    ({ params }): ParsedCodexNotification => ({
      kind: "turn_started",
      turnId: params.turn.id,
      threadId: params.threadId ?? null,
    }),
  ),
  z.object({ method: z.literal("turn/started"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({ method: z.literal("turn/completed"), params: TurnCompletedNotificationSchema })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "turn_completed",
        status: params.turn.status,
        errorMessage: params.turn.error?.message ?? null,
        threadId: params.threadId ?? null,
      }),
    ),
  z.object({ method: z.literal("turn/completed"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({ method: z.literal("turn/plan/updated"), params: TurnPlanUpdatedNotificationSchema })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "plan_updated",
        plan: params.plan.map((entry) => ({
          step: entry.step ?? null,
          status: entry.status ?? null,
        })),
      }),
    ),
  z.object({ method: z.literal("turn/plan/updated"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({ method: z.literal("turn/diff/updated"), params: TurnDiffUpdatedNotificationSchema })
    .transform(
      ({ params }): ParsedCodexNotification => ({ kind: "diff_updated", diff: params.diff }),
    ),
  z.object({ method: z.literal("turn/diff/updated"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("thread/tokenUsage/updated"),
      params: ThreadTokenUsageUpdatedNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "token_usage_updated",
        tokenUsage: params.tokenUsage,
      }),
    ),
  z.object({ method: z.literal("thread/tokenUsage/updated"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("item/agentMessage/delta"),
      params: ItemTextDeltaNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "agent_message_delta",
        itemId: params.itemId,
        delta: params.delta,
        threadId: params.threadId ?? null,
      }),
    ),
  z.object({ method: z.literal("item/agentMessage/delta"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("item/reasoning/summaryTextDelta"),
      params: ItemTextDeltaNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "reasoning_delta",
        itemId: params.itemId,
        delta: params.delta,
        threadId: params.threadId ?? null,
      }),
    ),
  z.object({ method: z.literal("item/reasoning/summaryTextDelta"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({ method: z.literal("item/completed"), params: ItemLifecycleNotificationSchema })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "item_completed",
        source: "item",
        threadId: params.threadId ?? null,
        item: params.item,
      }),
    ),
  z.object({ method: z.literal("item/completed"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({ method: z.literal("item/started"), params: ItemLifecycleNotificationSchema })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "item_started",
        source: "item",
        threadId: params.threadId ?? null,
        item: params.item,
      }),
    ),
  z.object({ method: z.literal("item/started"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/item_started"),
      params: CodexEventItemLifecycleNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "item_started",
        source: "codex_event",
        threadId: params.threadId ?? params.msg.threadId ?? params.msg.thread_id ?? null,
        item: params.msg.item,
      }),
    ),
  z.object({ method: z.literal("codex/event/item_started"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/item_completed"),
      params: CodexEventItemLifecycleNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "item_completed",
        source: "codex_event",
        threadId: params.threadId ?? params.msg.threadId ?? params.msg.thread_id ?? null,
        item: params.msg.item,
      }),
    ),
  z.object({ method: z.literal("codex/event/item_completed"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/exec_command_begin"),
      params: CodexEventExecCommandBeginNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "exec_command_started",
        callId: params.msg.call_id ?? null,
        command: params.msg.command ?? null,
        cwd: params.msg.cwd ?? null,
      }),
    ),
  z.object({ method: z.literal("codex/event/exec_command_begin"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/exec_command_end"),
      params: CodexEventExecCommandEndNotificationSchema,
    })
    .transform(
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
      }),
    ),
  z.object({ method: z.literal("codex/event/exec_command_end"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/exec_command_output_delta"),
      params: CodexEventExecCommandOutputDeltaNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "exec_command_output_delta",
        callId: params.msg.call_id ?? null,
        stream: params.msg.stream ?? null,
        chunk: params.msg.chunk ?? params.msg.delta ?? null,
      }),
    ),
  z
    .object({
      method: z.literal("codex/event/exec_command_output_delta"),
      params: z.unknown(),
    })
    .transform(
      ({ method, params }): ParsedCodexNotification => ({
        kind: "invalid_payload",
        method,
        params,
      }),
    ),
  z
    .object({
      method: z.literal("codex/event/terminal_interaction"),
      params: CodexEventTerminalInteractionNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "terminal_interaction",
        source: "codex_event",
        callId: params.msg.call_id ?? null,
        processId:
          typeof params.msg.process_id === "number"
            ? String(params.msg.process_id)
            : (params.msg.process_id ?? null),
        stdin: params.msg.stdin ?? null,
      }),
    ),
  z
    .object({ method: z.literal("codex/event/terminal_interaction"), params: z.unknown() })
    .transform(
      ({ method, params }): ParsedCodexNotification => ({
        kind: "invalid_payload",
        method,
        params,
      }),
    ),
  z
    .object({
      method: z.literal("item/commandExecution/terminalInteraction"),
      params: ItemCommandExecutionTerminalInteractionNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "terminal_interaction",
        source: "item",
        callId: params.itemId ?? null,
        processId:
          typeof params.processId === "number"
            ? String(params.processId)
            : (params.processId ?? null),
        stdin: params.stdin ?? null,
      }),
    ),
  z
    .object({
      method: z.literal("item/commandExecution/terminalInteraction"),
      params: z.unknown(),
    })
    .transform(
      ({ method, params }): ParsedCodexNotification => ({
        kind: "invalid_payload",
        method,
        params,
      }),
    ),
  z
    .object({
      method: z.literal("codex/event/patch_apply_begin"),
      params: CodexEventPatchApplyBeginNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "patch_apply_started",
        callId: params.msg.call_id ?? null,
        changes: params.msg.changes ?? null,
      }),
    ),
  z.object({ method: z.literal("codex/event/patch_apply_begin"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/patch_apply_end"),
      params: CodexEventPatchApplyEndNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "patch_apply_completed",
        callId: params.msg.call_id ?? null,
        changes: params.msg.changes ?? null,
        stdout: params.msg.stdout ?? null,
        stderr: params.msg.stderr ?? null,
        success: params.msg.success ?? null,
      }),
    ),
  z.object({ method: z.literal("codex/event/patch_apply_end"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("item/fileChange/outputDelta"),
      params: ItemFileChangeOutputDeltaNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "file_change_output_delta",
        itemId: params.itemId,
        delta: params.delta ?? params.chunk ?? null,
      }),
    ),
  z.object({ method: z.literal("item/fileChange/outputDelta"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/turn_diff"),
      params: CodexEventTurnDiffNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "diff_updated",
        diff: params.msg.unified_diff ?? params.msg.diff ?? "",
      }),
    ),
  z.object({ method: z.literal("codex/event/turn_diff"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/turn_aborted"),
      params: CodexEventTurnAbortedNotificationSchema,
    })
    .transform(
      (): ParsedCodexNotification => ({
        kind: "turn_completed",
        status: "interrupted",
        errorMessage: null,
        threadId: null,
      }),
    ),
  z.object({ method: z.literal("codex/event/turn_aborted"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({
      method: z.literal("codex/event/task_complete"),
      params: CodexEventTaskCompleteNotificationSchema,
    })
    .transform(
      (): ParsedCodexNotification => ({
        kind: "turn_completed",
        status: "completed",
        errorMessage: null,
        threadId: null,
      }),
    ),
  z.object({ method: z.literal("codex/event/task_complete"), params: z.unknown() }).transform(
    ({ method, params }): ParsedCodexNotification => ({
      kind: "invalid_payload",
      method,
      params,
    }),
  ),
  z
    .object({ method: z.string(), params: z.unknown() })
    .transform(
      ({ method, params }): ParsedCodexNotification => ({ kind: "unknown_method", method, params }),
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
  logger: Logger,
): Promise<CodexConfiguredDefaults> {
  let savedConfigDefaults: CodexConfiguredDefaults = {};
  try {
    const response = toObjectRecord(await client.request("getUserSavedConfig", {}));
    const config = toObjectRecord(response?.config);
    const modelValue = typeof config?.model === "string" ? config.model : undefined;
    const thinkingOptionValue =
      typeof config?.modelReasoningEffort === "string" ? config.modelReasoningEffort : null;
    savedConfigDefaults = {
      model: normalizeCodexModelId(modelValue),
      thinkingOptionId: normalizeCodexThinkingOptionId(thinkingOptionValue),
    };
  } catch (error) {
    logger.debug({ error }, "Failed to read Codex saved config defaults");
  }

  if (savedConfigDefaults.model && savedConfigDefaults.thinkingOptionId) {
    return savedConfigDefaults;
  }

  let configReadDefaults: CodexConfiguredDefaults = {};
  try {
    const response = toObjectRecord(await client.request("config/read", {}));
    const config = toObjectRecord(response?.config);
    const modelValue = typeof config?.model === "string" ? config.model : undefined;
    const thinkingOptionValue =
      typeof config?.model_reasoning_effort === "string" ? config.model_reasoning_effort : null;
    configReadDefaults = {
      model: normalizeCodexModelId(modelValue),
      thinkingOptionId: normalizeCodexThinkingOptionId(thinkingOptionValue),
    };
  } catch (error) {
    logger.debug({ error }, "Failed to read Codex config defaults");
  }

  return mergeCodexConfiguredDefaults(savedConfigDefaults, configReadDefaults);
}

interface CodexSkillPromptBlock {
  type: "skill";
  name: string;
  path: string;
}

type CodexPromptContentBlock = AgentPromptContentBlock | CodexSkillPromptBlock;
type CodexPromptInput = string | CodexPromptContentBlock[];
interface CodexTextElement {
  byteRange: {
    start: number;
    end: number;
  };
  placeholder: string | null;
}

type CodexAppServerUserInput =
  | {
      type: "text";
      text: string;
      text_elements: CodexTextElement[];
    }
  | {
      type: "localImage";
      path: string;
    }
  | CodexSkillPromptBlock;

export async function codexAppServerTurnInputFromPrompt(
  prompt: CodexPromptInput,
  logger: Logger,
): Promise<CodexAppServerUserInput[]> {
  if (typeof prompt === "string") {
    return [toCodexTextInput(prompt)];
  }

  const output: CodexAppServerUserInput[] = [];
  let previousTextBlock = false;
  for (const block of prompt) {
    if (block.type === "text") {
      output.push(toCodexTextInput(block.text));
      previousTextBlock = block.text.length > 0;
      continue;
    }
    if (block.type === "skill") {
      output.push(block);
      previousTextBlock = false;
      continue;
    }
    if (block.type === "image") {
      try {
        const filePath = await writeImageAttachment(block.mimeType, block.data);
        output.push({ type: "localImage", path: filePath });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn({ message }, "Failed to write Codex image attachment");
        output.push({
          ...toCodexTextInput(`User attached image (failed to write temp file): ${message}`),
        });
      }
      previousTextBlock = false;
      continue;
    }
    const attachmentText = renderPromptAttachmentAsText(block);
    output.push(toCodexTextInput(previousTextBlock ? `\n\n${attachmentText}` : attachmentText));
    previousTextBlock = true;
  }
  return output;
}

function toCodexTextInput(text: string): Extract<CodexAppServerUserInput, { type: "text" }> {
  return {
    type: "text",
    text,
    text_elements: [],
  };
}

function buildCodexAppServerEnv(
  runtimeSettings?: ProviderRuntimeSettings,
  launchEnv?: Record<string, string>,
): NodeJS.ProcessEnv {
  return createProviderEnv({
    runtimeSettings,
    overlays: [launchEnv],
  });
}

function buildCodexAppServerInitializeParams(): {
  clientInfo: { name: string; title: string; version: string };
  capabilities: { experimentalApi: true };
} {
  return {
    clientInfo: {
      name: "paseo",
      title: "Paseo",
      version: "0.0.0",
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}

interface CodexSubAgentCallState {
  callId: string;
  toolCall: ToolCallTimelineItem;
  childItemOrder: string[];
  childItems: Map<string, AgentTimelineItem>;
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
  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private nextTurnOrdinal = 0;
  private activeForegroundTurnId: string | null = null;
  private cachedRuntimeInfo: AgentRuntimeInfo | null = null;
  private serviceTier: "fast" | null = null;
  private planModeEnabled = false;
  private historyPending = false;
  private persistedHistory: AgentTimelineItem[] = [];
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private pendingPermissionHandlers = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      kind: "command" | "file" | "question" | "plan";
      questions?: CodexQuestionPrompt[];
      planText?: string;
    }
  >();
  private resolvedPermissionRequests = new Set<string>();
  private pendingAgentMessages = new Map<string, string>();
  private pendingReasoning = new Map<string, string[]>();
  private pendingCommandOutputDeltas = new Map<string, string[]>();
  private pendingFileChangeOutputDeltas = new Map<string, string[]>();
  private pendingAssistantMessageBoundary = false;
  private terminalCommandByProcessId = new Map<string, string>();
  private pendingUnlabeledTerminalInteractions = new Set<string>();
  private emittedTerminalInteractionKeys = new Set<string>();
  private emittedExecCommandStartedCallIds = new Set<string>();
  private emittedExecCommandCompletedCallIds = new Set<string>();
  private emittedItemStartedIds = new Set<string>();
  private emittedItemCompletedIds = new Set<string>();
  private subAgentCallsByCallId = new Map<string, CodexSubAgentCallState>();
  private subAgentCallIdByChildThreadId = new Map<string, string>();
  private warnedUnknownNotificationMethods = new Set<string>();
  private warnedInvalidNotificationPayloads = new Set<string>();
  private warnedIncompleteEditToolCallIds = new Set<string>();
  private latestUsage: AgentUsage | undefined;
  private latestPlanResult: { callId: string; text: string; turnId: string | null } | null = null;
  private connected = false;
  private collaborationModes: Array<{
    name: string;
    mode?: string | null;
    model?: string | null;
    reasoning_effort?: string | null;
    developer_instructions?: string | null;
  }> = [];
  private resolvedCollaborationMode: {
    mode: string;
    settings: Record<string, unknown>;
    name: string;
  } | null = null;
  private cachedSkills: Array<{ name: string; description: string; path: string }> = [];

  constructor(
    config: AgentSessionConfig,
    private readonly resumeHandle: { sessionId: string; metadata?: Record<string, unknown> } | null,
    logger: Logger,
    private readonly spawnAppServer: () => Promise<ChildProcessWithoutNullStreams>,
    private readonly deps: CodexAppServerAgentDeps = {},
    private readonly ephemeral: boolean = false,
    private readonly goalsEnabled: boolean = false,
  ) {
    this.logger = logger.child({ module: "agent", provider: CODEX_PROVIDER });
    if (config.modeId === undefined) {
      throw new Error("Codex agent requires modeId to be specified");
    }
    validateCodexMode(config.modeId);
    this.currentMode = config.modeId;
    this.config = config;
    this.config.thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
    if (this.config.featureValues?.fast_mode) {
      this.serviceTier = "fast";
    }
    if (this.config.featureValues?.plan_mode) {
      this.planModeEnabled = true;
    }

    if (this.resumeHandle?.sessionId) {
      this.currentThreadId = this.resumeHandle.sessionId;
      this.historyPending = true;
    }
  }

  get id(): string | null {
    return this.currentThreadId;
  }

  get features(): AgentFeature[] {
    return buildCodexFeatures({
      modelId: this.config.model,
      fastModeEnabled: this.serviceTier === "fast",
      planModeEnabled: this.planModeEnabled,
      planModeAvailable: this.hasPlanCollaborationMode(),
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    const child = await this.spawnAppServer();
    this.client = new CodexAppServerClient(child, this.logger);
    this.client.setNotificationHandler((method, params) => this.handleNotification(method, params));
    this.registerRequestHandlers();

    await this.client.request("initialize", buildCodexAppServerInitializeParams());
    this.client.notify("initialized", {});

    await this.loadCollaborationModes();
    await this.loadSkills();

    if (this.currentThreadId) {
      await this.ensureThreadLoaded();
      await this.loadPersistedHistory();
    }

    this.connected = true;
  }

  private async loadCollaborationModes(): Promise<void> {
    if (!this.client) return;
    try {
      const response = toObjectRecord(await this.client.request("collaborationMode/list", {}));
      const data = Array.isArray(response?.data) ? response.data : [];
      this.collaborationModes = data.map((entry) => {
        const record = toObjectRecord(entry);
        return {
          name: typeof record?.name === "string" ? record.name : "",
          mode: typeof record?.mode === "string" ? record.mode : null,
          model: typeof record?.model === "string" ? record.model : null,
          reasoning_effort:
            typeof record?.reasoning_effort === "string" ? record.reasoning_effort : null,
          developer_instructions:
            typeof record?.developer_instructions === "string"
              ? record.developer_instructions
              : null,
        };
      });
    } catch (error) {
      this.logger.trace({ error }, "Failed to load collaboration modes");
      this.collaborationModes = [];
    }
    this.refreshResolvedCollaborationMode();
  }

  private async loadSkills(): Promise<void> {
    if (!this.client) return;
    try {
      const response = toObjectRecord(
        await this.client.request("skills/list", {
          cwd: [this.config.cwd],
        }),
      );
      const entries = Array.isArray(response?.data) ? response.data : [];
      const skills: Array<{ name: string; description: string; path: string }> = [];
      for (const entry of entries) {
        const entryRecord = toObjectRecord(entry);
        const list = Array.isArray(entryRecord?.skills) ? entryRecord.skills : [];
        for (const skill of list) {
          const skillRecord = toObjectRecord(skill);
          if (typeof skillRecord?.name !== "string" || typeof skillRecord?.path !== "string")
            continue;
          skills.push({
            name: skillRecord.name,
            description: resolveSkillDescription(skillRecord),
            path: skillRecord.path,
          });
        }
      }
      this.cachedSkills = skills;
    } catch (error) {
      this.logger.trace({ error }, "Failed to load skills list");
      this.cachedSkills = [];
    }
  }

  private findCollaborationMode(target: "code" | "plan"): {
    name: string;
    mode?: string | null;
    model?: string | null;
    reasoning_effort?: string | null;
    developer_instructions?: string | null;
  } | null {
    if (this.collaborationModes.length === 0) return null;
    const findByName = (predicate: (name: string) => boolean) =>
      this.collaborationModes.find((entry) => predicate(entry.name.toLowerCase()));

    if (target === "plan") {
      return findByName((name) => name.includes("plan") || name.includes("read")) ?? null;
    }

    return (
      findByName((name) => name.includes("auto") || name.includes("code")) ??
      this.collaborationModes.find((entry) => {
        const name = entry.name.toLowerCase();
        return !name.includes("plan") && !name.includes("read");
      }) ??
      this.collaborationModes[0] ??
      null
    );
  }

  private hasPlanCollaborationMode(): boolean {
    return this.findCollaborationMode("plan") !== null;
  }

  private resolveCollaborationMode(): {
    mode: string;
    settings: Record<string, unknown>;
    name: string;
  } | null {
    const match = this.findCollaborationMode(this.planModeEnabled ? "plan" : "code");
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

  private refreshResolvedCollaborationMode(): void {
    this.resolvedCollaborationMode = this.resolveCollaborationMode();
  }

  private applyFeatureValue(featureId: "fast_mode" | "plan_mode", value: boolean): void {
    this.config.featureValues = {
      ...this.config.featureValues,
      [featureId]: value,
    };

    if (featureId === "fast_mode") {
      this.serviceTier = value ? "fast" : null;
      this.cachedRuntimeInfo = null;
      return;
    }

    this.planModeEnabled = value;
    this.refreshResolvedCollaborationMode();
    this.cachedRuntimeInfo = null;
  }

  private rememberPlanResult(item: ToolCallTimelineItem): void {
    if (item.detail.type !== "plan") {
      return;
    }

    this.latestPlanResult = {
      callId: item.callId,
      text: item.detail.text,
      turnId: this.currentTurnId,
    };
  }

  private emitSyntheticPlanApprovalRequest(planText: string): void {
    const requestId = `permission-${randomUUID()}`;
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: CODEX_PROVIDER,
      name: "CodexPlanApproval",
      kind: "plan",
      title: "Plan",
      description: "Review the proposed plan before implementation starts.",
      input: { plan: planText },
      actions: buildPlanPermissionActions(),
      metadata: {
        planText,
        source: "codex_plan_approval",
      },
    };

    this.pendingPermissions.set(requestId, request);
    this.pendingPermissionHandlers.set(requestId, {
      resolve: () => undefined,
      kind: "plan",
      planText,
    });
    this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
  }

  /**
   * Prepare the session for plan implementation by disabling plan mode
   * and returning the implementation prompt. The caller is responsible for
   * starting the turn through the normal streamAgent path.
   */
  private preparePlanImplementation(params: { planText?: unknown }): string {
    const planText =
      typeof params.planText === "string" ? normalizePlanMarkdown(params.planText) : "";

    this.applyFeatureValue("plan_mode", false);

    return buildCodexPlanImplementationPrompt(planText);
  }

  private registerRequestHandlers(): void {
    if (!this.client) return;

    this.client.setRequestHandler("item/commandExecution/requestApproval", (params) =>
      this.handleCommandApprovalRequest(params),
    );
    this.client.setRequestHandler("item/fileChange/requestApproval", (params) =>
      this.handleFileChangeApprovalRequest(params),
    );
    this.client.setRequestHandler("item/tool/requestUserInput", (params) =>
      this.handleToolApprovalRequest(params),
    );
    // Keep the legacy method name for older Codex builds.
    this.client.setRequestHandler("tool/requestUserInput", (params) =>
      this.handleToolApprovalRequest(params),
    );
  }

  private async loadPersistedHistory(): Promise<void> {
    if (!this.client || !this.currentThreadId) return;
    const client = this.client;
    const threadId = this.currentThreadId;

    try {
      const timeline = await loadCodexThreadHistoryTimeline({
        threadId,
        cwd: this.config.cwd ?? null,
        requestThread: (threadIdToRead) => {
          return readCodexThread(client, threadIdToRead);
        },
      });
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
      const loaded = toObjectRecord(await this.client.request("thread/loaded/list", {}));
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

  private parseSlashCommandInput(text: string): { commandName: string; args?: string } | null {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/") || trimmed.length <= 1) {
      return null;
    }
    const withoutPrefix = trimmed.slice(1);
    const firstWhitespaceIdx = withoutPrefix.search(/\s/);
    const commandName =
      firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
    if (!commandName || commandName.includes("/")) {
      return null;
    }
    const rawArgs =
      firstWhitespaceIdx === -1 ? "" : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
    return rawArgs.length > 0 ? { commandName, args: rawArgs } : { commandName };
  }

  private async resolveSlashCommandInvocation(
    prompt: AgentPromptInput,
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
      return commands.some((command) => command.name === parsed.commandName) ? parsed : null;
    } catch (error) {
      this.logger.warn(
        { err: error, commandName: parsed.commandName },
        "Failed to resolve slash command; falling back to plain prompt input",
      );
      return null;
    }
  }

  private async buildCommandPromptInput(
    commandName: string,
    args?: string,
  ): Promise<CodexPromptInput> {
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
      const input: CodexPromptContentBlock[] = [
        { type: "skill", name: skill.name, path: skill.path },
      ];
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
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: async () => (await this.getRuntimeInfo()).sessionId ?? "",
      reduceFinalText: ({ current, item }) => {
        if (item.type === "assistant_message") {
          return item.text;
        }
        if (item.type === "tool_call" && item.detail.type === "plan") {
          return item.detail.text;
        }
        return current;
      },
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeForegroundTurnId) {
      throw new Error("A foreground turn is already active");
    }

    await this.connect();
    if (!this.client) {
      throw new Error("Codex client not initialized");
    }

    const slashCommand = await this.resolveSlashCommandInvocation(prompt);
    const effectivePrompt = slashCommand
      ? await this.buildCommandPromptInput(slashCommand.commandName, slashCommand.args)
      : prompt;

    if (this.currentThreadId) {
      await this.ensureThreadLoaded();
    } else {
      await this.ensureThread();
    }

    const input = await this.buildUserInput(effectivePrompt);
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
          : preset.networkAccess,
      ),
    };

    if (this.config.model) {
      params.model = this.config.model;
    }
    const thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
    if (thinkingOptionId) {
      params.effort = thinkingOptionId;
    }
    if (this.serviceTier) {
      params.serviceTier = this.serviceTier;
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
      params.outputSchema = normalizeCodexOutputSchema(options.outputSchema);
    }
    if (this.config.systemPrompt?.trim()) {
      params.developerInstructions = this.config.systemPrompt.trim();
    }
    const codexConfig = this.buildCodexInnerConfig();
    if (codexConfig) {
      params.config = codexConfig;
    }

    const turnId = this.createTurnId();
    this.activeForegroundTurnId = turnId;

    try {
      await this.client.request("turn/start", params, TURN_START_TIMEOUT_MS);
    } catch (error) {
      this.activeForegroundTurnId = null;
      throw error;
    }

    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
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
    this.cachedRuntimeInfo = null;
  }

  async setModel(modelId: string | null): Promise<void> {
    this.config.model = modelId ?? undefined;
    if (!codexModelSupportsFastMode(this.config.model)) {
      this.serviceTier = null;
    }
    this.refreshResolvedCollaborationMode();
    this.cachedRuntimeInfo = null;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    this.config.thinkingOptionId = normalizeCodexThinkingOptionId(thinkingOptionId);
    this.refreshResolvedCollaborationMode();
    this.cachedRuntimeInfo = null;
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId === "fast_mode") {
      this.applyFeatureValue("fast_mode", Boolean(value));
      return;
    }
    if (featureId === "plan_mode") {
      this.applyFeatureValue("plan_mode", Boolean(value));
      return;
    }
    throw new Error(`Unknown Codex feature: ${featureId}`);
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return Array.from(this.pendingPermissions.values());
  }

  async respondToPermission(
    requestId: string,
    response: AgentPermissionResponse,
  ): Promise<AgentPermissionResult | void> {
    const pending = this.pendingPermissionHandlers.get(requestId);
    if (!pending) {
      throw new Error(`No pending Codex app-server permission request with id '${requestId}'`);
    }
    const pendingRequest = this.pendingPermissions.get(requestId) ?? null;

    if (pending.kind === "plan") {
      return this.handlePlanPermissionResponse({ requestId, response, pending, pendingRequest });
    }

    this.pendingPermissionHandlers.delete(requestId);
    this.pendingPermissions.delete(requestId);
    this.resolvedPermissionRequests.add(requestId);

    if (response.behavior === "deny" && pendingRequest?.kind === "tool") {
      this.emitDeniedToolCallTimelineEvent({ requestId, response, pendingRequest });
    }

    this.emitEvent({
      type: "permission_resolved",
      provider: CODEX_PROVIDER,
      requestId,
      resolution: response,
    });

    if (pending.kind === "command") {
      pending.resolve({ decision: resolvePermissionDecision(response) });
      return;
    }

    if (pending.kind === "file") {
      pending.resolve({ decision: resolvePermissionDecision(response) });
      return;
    }

    const questions = pending.questions ?? [];
    const itemId =
      typeof pendingRequest?.metadata?.itemId === "string"
        ? pendingRequest.metadata.itemId
        : requestId;
    if (response.behavior === "allow") {
      const mappedAnswers = mapCodexQuestionResponseByHeader({
        questions,
        response,
      });
      const answers =
        mappedAnswers ??
        Object.fromEntries(
          questions
            .map((question) => {
              const fallback = question.options[0]?.label?.trim();
              return fallback ? [question.id, { answers: [fallback] }] : null;
            })
            .filter((entry): entry is [string, { answers: string[] }] => entry !== null),
        );
      this.emitEvent({
        type: "timeline",
        provider: CODEX_PROVIDER,
        item: mapCodexQuestionRequestToToolCall({
          callId: itemId,
          questions,
          status: "completed",
          answers: Object.fromEntries(
            Object.entries(answers).map(([id, value]) => [id, value.answers]),
          ),
        }),
      });
      pending.resolve({ answers });
      return;
    }

    this.emitEvent({
      type: "timeline",
      provider: CODEX_PROVIDER,
      item: mapCodexQuestionRequestToToolCall({
        callId: itemId,
        questions,
        status: response.interrupt ? "canceled" : "failed",
        error: { message: response.message ?? "Question dismissed" },
      }),
    });
    pending.resolve({ answers: {} });
  }

  private handlePlanPermissionResponse(params: {
    requestId: string;
    response: AgentPermissionResponse;
    pending: {
      resolve: (value: unknown) => void;
      kind: "command" | "file" | "question" | "plan";
      questions?: CodexQuestionPrompt[];
      planText?: string;
    };
    pendingRequest: AgentPermissionRequest | null;
  }): AgentPermissionResult | void {
    const { requestId, response, pending, pendingRequest } = params;
    let followUpPrompt: string | undefined;
    if (response.behavior === "allow") {
      followUpPrompt = this.preparePlanImplementation({
        planText: pending.planText ?? pendingRequest?.metadata?.planText,
      });
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
    if (followUpPrompt) {
      return { followUpPrompt };
    }
  }

  private emitDeniedToolCallTimelineEvent(params: {
    requestId: string;
    response: Extract<AgentPermissionResponse, { behavior: "deny" }>;
    pendingRequest: AgentPermissionRequest;
  }): void {
    const { requestId, response, pendingRequest } = params;
    let fallbackName: string;
    if (pendingRequest.name === "CodexBash") {
      fallbackName = "shell";
    } else if (pendingRequest.name === "CodexFileChange") {
      fallbackName = "apply_patch";
    } else {
      fallbackName = pendingRequest.name;
    }
    this.emitEvent({
      type: "timeline",
      provider: CODEX_PROVIDER,
      item: {
        type: "tool_call",
        callId: requestId,
        name: fallbackName,
        status: "failed",
        error: { message: response.message ?? "Permission denied" },
        detail: pendingRequest.detail ?? {
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

  describePersistence(): {
    provider: typeof CODEX_PROVIDER;
    sessionId: string;
    nativeHandle: string;
    metadata: Record<string, unknown>;
  } | null {
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
      await this.client.request(
        "turn/interrupt",
        {
          threadId: this.currentThreadId,
          turnId: this.currentTurnId,
        },
        INTERRUPT_TIMEOUT_MS,
      );
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
    this.subscribers.clear();
    this.activeForegroundTurnId = null;
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
    const fallbackSkills =
      appServerSkills.length === 0
        ? await listCodexSkills(this.config.cwd, this.deps.workspaceGitService)
        : [];
    const builtin: AgentSlashCommand[] = [];
    if (this.goalsEnabled) {
      builtin.push({
        name: "goal",
        description: "Set, pause, resume, or clear the agent's goal",
        argumentHint: "[<objective>|pause|resume|clear]",
      });
    }
    return [...builtin, ...appServerSkills, ...fallbackSkills, ...prompts].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  tryHandleOutOfBand(
    prompt: AgentPromptInput,
  ): { run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void> } | null {
    if (!this.goalsEnabled) return null;
    if (typeof prompt !== "string") return null;
    const parsed = this.parseSlashCommandInput(prompt);
    if (!parsed || parsed.commandName !== "goal") return null;

    const subcommand = parseGoalSubcommand(parsed.args);
    return {
      run: async ({ emit }) => {
        const text = formatOutOfBandStatusMessage(await this.executeGoalSubcommand(subcommand));
        emit({
          type: "timeline",
          provider: CODEX_PROVIDER,
          item: { type: "assistant_message", text },
        });
      },
    };
  }

  private async executeGoalSubcommand(subcommand: GoalSubcommand): Promise<string> {
    if (subcommand.kind === "usage") {
      return "Usage: /goal <objective>|pause|resume|clear";
    }
    try {
      await this.connect();
      if (this.currentThreadId) {
        await this.ensureThreadLoaded();
      } else {
        await this.ensureThread();
      }
      if (!this.client || !this.currentThreadId) {
        throw new Error("Codex thread is not available");
      }
      switch (subcommand.kind) {
        case "set": {
          await this.client.request("thread/goal/set", {
            threadId: this.currentThreadId,
            objective: subcommand.objective,
            status: "active",
          });
          return `Goal set: ${subcommand.objective}`;
        }
        case "pause": {
          await this.client.request("thread/goal/set", {
            threadId: this.currentThreadId,
            status: "paused",
          });
          return "Goal paused.";
        }
        case "resume": {
          await this.client.request("thread/goal/set", {
            threadId: this.currentThreadId,
            status: "active",
          });
          return "Goal resumed.";
        }
        case "clear": {
          await this.client.request("thread/goal/clear", {
            threadId: this.currentThreadId,
          });
          return "Goal cleared.";
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return `Failed to update goal: ${message}`;
    }
  }

  private async resolveModelAndThinking(): Promise<{
    model: string;
    thinkingOptionId: string | undefined;
  }> {
    if (!this.client) {
      throw new Error("Codex client is not initialized");
    }
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
      const modelResponse = toObjectRecord(await this.client.request("model/list", {}));
      const modelData = Array.isArray(modelResponse?.data) ? modelResponse.data : [];
      const models = modelData
        .map((m) => {
          const record = toObjectRecord(m);
          return {
            id: typeof record?.id === "string" ? record.id : "",
            isDefault: !!record?.isDefault,
            defaultReasoningEffort:
              typeof record?.defaultReasoningEffort === "string"
                ? record.defaultReasoningEffort
                : undefined,
          };
        })
        .filter((m) => m.id);
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

    if (!model) {
      throw new Error("Unable to resolve Codex model");
    }
    return { model, thinkingOptionId };
  }

  private async ensureThread(): Promise<void> {
    if (!this.client) return;
    if (this.currentThreadId) return;

    const { model, thinkingOptionId } = await this.resolveModelAndThinking();
    this.config.model = model;
    this.config.thinkingOptionId = thinkingOptionId;

    const preset = MODE_PRESETS[this.currentMode] ?? MODE_PRESETS[DEFAULT_CODEX_MODE_ID];
    const approvalPolicy = this.config.approvalPolicy ?? preset.approvalPolicy;
    const sandbox = this.config.sandboxMode ?? preset.sandbox;
    const innerConfig = this.buildCodexInnerConfig();
    const rawResponse = await this.client.request("thread/start", {
      model,
      cwd: this.config.cwd ?? null,
      approvalPolicy,
      sandbox,
      ...(this.config.systemPrompt?.trim()
        ? { developerInstructions: this.config.systemPrompt.trim() }
        : {}),
      ...(innerConfig ? { config: innerConfig } : {}),
      ...(this.ephemeral ? { ephemeral: true } : {}),
    });
    const response = toObjectRecord(rawResponse);
    const threadRecord = toObjectRecord(response?.thread);
    const threadId = typeof threadRecord?.id === "string" ? threadRecord.id : undefined;
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

  private async buildUserInput(prompt: CodexPromptInput): Promise<CodexAppServerUserInput[]> {
    if (typeof prompt === "string") {
      return [toCodexTextInput(prompt)];
    }
    return await codexAppServerTurnInputFromPrompt(prompt, this.logger);
  }

  private emitEvent(event: AgentStreamEvent): void {
    this.notifySubscribers(event);
  }

  private notifySubscribers(event: AgentStreamEvent): void {
    const turnId = this.activeForegroundTurnId;
    const tagged = turnId ? { ...event, turnId } : event;
    for (const callback of this.subscribers) {
      try {
        callback(tagged);
      } catch (error) {
        this.logger.warn({ err: error }, "Subscriber callback threw");
      }
    }
  }

  private createTurnId(): string {
    return `codex-turn-${this.nextTurnOrdinal++}`;
  }

  private handleNotification(method: string, params: unknown): void {
    const parsed = CodexNotificationSchema.parse({ method, params });
    switch (parsed.kind) {
      case "thread_started":
        this.handleThreadStartedNotification(parsed);
        return;
      case "turn_started":
        this.handleTurnStartedNotification(parsed);
        return;
      case "turn_completed":
        this.handleTurnCompletedNotification(parsed);
        return;
      case "plan_updated":
        this.handlePlanUpdatedNotification(parsed);
        return;
      case "diff_updated":
        // NOTE: Codex app-server emits frequent `turn/diff/updated` notifications
        // containing a full accumulated unified diff for the *entire turn*.
        // This is not a concrete file-change tool call; it is progress telemetry.
        return;
      case "token_usage_updated":
        this.handleTokenUsageUpdatedNotification(parsed);
        return;
      case "agent_message_delta":
      case "reasoning_delta":
      case "exec_command_output_delta":
      case "file_change_output_delta":
        this.handleCodexDeltaNotification(parsed);
        return;
      case "exec_command_started":
        this.handleExecCommandStartedNotification(parsed);
        return;
      case "exec_command_completed":
        this.handleExecCommandCompletedNotification(parsed);
        return;
      case "terminal_interaction":
        this.handleTerminalInteractionNotification(parsed);
        return;
      case "patch_apply_started":
        this.handlePatchApplyStartedNotification(parsed);
        return;
      case "patch_apply_completed":
        this.handlePatchApplyCompletedNotification(parsed);
        return;
      case "item_completed":
        this.handleItemCompletedNotification(parsed);
        return;
      case "item_started":
        this.handleItemStartedNotification(parsed);
        return;
      case "invalid_payload":
        this.warnInvalidNotificationPayload(parsed.method, parsed.params);
        return;
      default:
        this.warnUnknownNotificationMethod(parsed.method, parsed.params);
    }
  }

  private getSubAgentCallIdForThread(threadId: string | null | undefined): string | null {
    if (!threadId || threadId === this.currentThreadId) {
      return null;
    }
    return this.subAgentCallIdByChildThreadId.get(threadId) ?? null;
  }

  private registerSubAgentToolCall(
    timelineItem: ToolCallTimelineItem,
    rawItem: { [key: string]: unknown },
  ): void {
    if (timelineItem.detail.type !== "sub_agent") {
      return;
    }

    const existing = this.subAgentCallsByCallId.get(timelineItem.callId);
    const state: CodexSubAgentCallState =
      existing ??
      ({
        callId: timelineItem.callId,
        toolCall: timelineItem,
        childItemOrder: [],
        childItems: new Map<string, AgentTimelineItem>(),
      } satisfies CodexSubAgentCallState);

    state.toolCall = {
      ...timelineItem,
      detail: {
        ...timelineItem.detail,
        log:
          timelineItem.detail.log ||
          (state.toolCall.detail.type === "sub_agent" ? state.toolCall.detail.log : ""),
      },
    };
    this.subAgentCallsByCallId.set(timelineItem.callId, state);

    const receiverThreadIds = Array.isArray(rawItem.receiverThreadIds)
      ? rawItem.receiverThreadIds.filter((value): value is string => typeof value === "string")
      : [];
    for (const receiverThreadId of receiverThreadIds) {
      this.subAgentCallIdByChildThreadId.set(receiverThreadId, timelineItem.callId);
    }
  }

  private upsertSubAgentChildItem(callId: string, itemId: string, item: AgentTimelineItem): void {
    const state = this.subAgentCallsByCallId.get(callId);
    if (!state) {
      return;
    }
    if (!state.childItems.has(itemId)) {
      state.childItemOrder.push(itemId);
    }
    state.childItems.set(itemId, item);
  }

  private getSubAgentChildTimeline(state: CodexSubAgentCallState): AgentTimelineItem[] {
    return state.childItemOrder
      .map((itemId) => state.childItems.get(itemId))
      .filter((item): item is AgentTimelineItem => Boolean(item));
  }

  private emitSubAgentActivityUpdate(
    callId: string,
    status?: ToolCallTimelineItem["status"],
  ): void {
    const state = this.subAgentCallsByCallId.get(callId);
    if (!state || state.toolCall.detail.type !== "sub_agent") {
      return;
    }
    const childTimeline = this.getSubAgentChildTimeline(state);
    const log =
      childTimeline.length > 0
        ? curateAgentActivity(childTimeline, { labelAssistantMessages: true })
        : "";
    const resolvedStatus = status ?? state.toolCall.status;
    const baseToolCall = {
      ...state.toolCall,
      detail: {
        ...state.toolCall.detail,
        log,
      },
    };
    const nextToolCall: ToolCallTimelineItem =
      resolvedStatus === "failed"
        ? {
            ...baseToolCall,
            status: "failed",
            error: state.toolCall.error ?? { message: "Sub-agent failed" },
          }
        : {
            ...baseToolCall,
            status: resolvedStatus,
            error: null,
          };
    state.toolCall = nextToolCall;
    this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: nextToolCall });
  }

  private handleSubAgentChildItemCompleted(
    callId: string,
    itemId: string | undefined,
    timelineItem: AgentTimelineItem,
  ): void {
    this.applyBufferedDeltaTextToTimelineItem(timelineItem, itemId);
    if (itemId) {
      this.upsertSubAgentChildItem(callId, itemId, timelineItem);
      this.pendingAgentMessages.delete(itemId);
      this.pendingReasoning.delete(itemId);
      this.pendingCommandOutputDeltas.delete(itemId);
      this.pendingFileChangeOutputDeltas.delete(itemId);
    }
    this.emitSubAgentActivityUpdate(
      callId,
      timelineItem.type === "tool_call" && timelineItem.status === "failed" ? "failed" : "running",
    );
  }

  private shouldSkipCompletedThreadItem(
    timelineItem: AgentTimelineItem,
    normalizedItemType: string | undefined,
    itemId: string | undefined,
  ): boolean {
    // For commandExecution items, codex/event/exec_command_* is authoritative.
    if (timelineItem.type === "tool_call" && normalizedItemType === "commandExecution") {
      const callId = timelineItem.callId || itemId;
      return Boolean(callId && this.emittedExecCommandCompletedCallIds.has(callId));
    }
    return Boolean(itemId && this.emittedItemCompletedIds.has(itemId));
  }

  private handleCodexDeltaNotification(
    parsed: Extract<
      ParsedCodexNotification,
      {
        kind:
          | "agent_message_delta"
          | "reasoning_delta"
          | "exec_command_output_delta"
          | "file_change_output_delta";
      }
    >,
  ): void {
    if (parsed.kind === "agent_message_delta") {
      const prev = this.pendingAgentMessages.get(parsed.itemId) ?? "";
      const text = prev + parsed.delta;
      this.pendingAgentMessages.set(parsed.itemId, text);
      const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
      if (subAgentCallId) {
        this.upsertSubAgentChildItem(subAgentCallId, parsed.itemId, {
          type: "assistant_message",
          text,
        });
        this.emitSubAgentActivityUpdate(subAgentCallId, "running");
        return;
      }
      const isFirstDeltaForItem = prev.length === 0;
      this.emitEvent({
        type: "timeline",
        provider: CODEX_PROVIDER,
        item: {
          type: "assistant_message",
          text:
            isFirstDeltaForItem && this.pendingAssistantMessageBoundary
              ? `${ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN}${parsed.delta}`
              : parsed.delta,
        },
      });
      if (isFirstDeltaForItem) {
        this.pendingAssistantMessageBoundary = false;
      }
      return;
    }
    if (parsed.kind === "reasoning_delta") {
      const prev = this.pendingReasoning.get(parsed.itemId) ?? [];
      prev.push(parsed.delta);
      this.pendingReasoning.set(parsed.itemId, prev);
      const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
      if (subAgentCallId) {
        this.upsertSubAgentChildItem(subAgentCallId, parsed.itemId, {
          type: "reasoning",
          text: prev.join(""),
        });
        this.emitSubAgentActivityUpdate(subAgentCallId, "running");
        return;
      }
      this.emitEvent({
        type: "timeline",
        provider: CODEX_PROVIDER,
        item: { type: "reasoning", text: parsed.delta },
      });
      return;
    }
    if (parsed.kind === "exec_command_output_delta") {
      this.appendOutputDeltaChunk(this.pendingCommandOutputDeltas, parsed.callId, parsed.chunk, {
        decodeBase64: true,
      });
      return;
    }
    this.appendOutputDeltaChunk(this.pendingFileChangeOutputDeltas, parsed.itemId, parsed.delta);
  }

  private handleThreadStartedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "thread_started" }>,
  ): void {
    this.currentThreadId = parsed.threadId;
    this.emitEvent({
      type: "thread_started",
      provider: CODEX_PROVIDER,
      sessionId: parsed.threadId,
    });
  }

  private handleTurnStartedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "turn_started" }>,
  ): void {
    const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
    if (subAgentCallId) {
      this.emitSubAgentActivityUpdate(subAgentCallId, "running");
      return;
    }
    this.currentTurnId = parsed.turnId;
    this.resetTurnTrackingState();
    this.emitEvent({ type: "turn_started", provider: CODEX_PROVIDER });
  }

  private handleTurnCompletedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "turn_completed" }>,
  ): void {
    const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
    if (subAgentCallId) {
      let status: ToolCallTimelineItem["status"] = "completed";
      if (parsed.status === "failed") {
        status = "failed";
      } else if (parsed.status === "interrupted") {
        status = "canceled";
      }
      this.emitSubAgentActivityUpdate(subAgentCallId, status);
      return;
    }
    if (parsed.status === "failed") {
      this.emitEvent({
        type: "turn_failed",
        provider: CODEX_PROVIDER,
        error: parsed.errorMessage ?? "Codex turn failed",
      });
    } else if (parsed.status === "interrupted") {
      this.emitEvent({ type: "turn_canceled", provider: CODEX_PROVIDER, reason: "interrupted" });
    } else {
      if (this.planModeEnabled && this.latestPlanResult?.text) {
        this.emitSyntheticPlanApprovalRequest(this.latestPlanResult.text);
      }
      this.emitEvent({
        type: "turn_completed",
        provider: CODEX_PROVIDER,
        usage: this.latestUsage,
      });
    }
    this.activeForegroundTurnId = null;
    this.resetTurnTrackingState();
  }

  private resetTurnTrackingState(): void {
    this.latestPlanResult = null;
    this.emittedItemStartedIds.clear();
    this.emittedItemCompletedIds.clear();
    this.emittedExecCommandStartedCallIds.clear();
    this.emittedExecCommandCompletedCallIds.clear();
    this.pendingAgentMessages.clear();
    this.pendingReasoning.clear();
    this.pendingCommandOutputDeltas.clear();
    this.pendingFileChangeOutputDeltas.clear();
    this.pendingAssistantMessageBoundary = false;
    this.warnedIncompleteEditToolCallIds.clear();
  }

  private handlePlanUpdatedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "plan_updated" }>,
  ): void {
    const timelineItem = mapCodexPlanToToolCall({
      callId: `plan:${this.currentTurnId ?? this.currentThreadId ?? "current"}`,
      text: planStepsToMarkdown(
        parsed.plan.map((entry) => ({
          step: entry.step ?? "",
          status: entry.status ?? "pending",
        })),
      ),
    });
    if (timelineItem) {
      this.rememberPlanResult(timelineItem);
      // In plan mode, the same plan is rendered through the synthetic approval
      // permission. Keep the remembered text for that card, but do not also
      // emit a static timeline plan panel.
      if (this.planModeEnabled) {
        return;
      }
      this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
    }
  }

  private handleTokenUsageUpdatedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "token_usage_updated" }>,
  ): void {
    this.latestUsage = toAgentUsage(parsed.tokenUsage);
    if (this.latestUsage) {
      this.notifySubscribers({
        type: "usage_updated",
        provider: CODEX_PROVIDER,
        usage: this.latestUsage,
      });
    }
  }

  private handleExecCommandStartedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "exec_command_started" }>,
  ): void {
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
  }

  private handleExecCommandCompletedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "exec_command_completed" }>,
  ): void {
    const bufferedOutput = this.consumeOutputDelta(this.pendingCommandOutputDeltas, parsed.callId);
    const resolvedOutput = parsed.output ?? bufferedOutput;
    this.rememberTerminalProcessForCommand(parsed.command, resolvedOutput);
    const timelineItem = mapCodexExecNotificationToToolCall({
      callId: parsed.callId,
      command: parsed.command,
      cwd: parsed.cwd ?? this.config.cwd ?? null,
      output: resolvedOutput,
      exitCode: parsed.exitCode,
      success: parsed.success,
      stderr: parsed.stderr,
      running: false,
    });
    if (timelineItem) {
      this.emittedExecCommandCompletedCallIds.add(timelineItem.callId);
      this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
    }
  }

  private handleTerminalInteractionNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "terminal_interaction" }>,
  ): void {
    const interactionKey = [parsed.processId ?? "", parsed.stdin ?? ""].join("\u0000");
    if (!this.shouldEmitTerminalInteractionKey(interactionKey)) {
      return;
    }
    const command =
      (parsed.processId ? this.terminalCommandByProcessId.get(parsed.processId) : undefined) ??
      null;
    if (!command && parsed.processId) {
      this.pendingUnlabeledTerminalInteractions.add(parsed.processId);
    }
    const timelineItem = mapCodexTerminalInteractionToToolCall({
      processId: parsed.processId,
      fallbackCallId: parsed.callId,
      command,
    });
    this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
  }

  private handlePatchApplyStartedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "patch_apply_started" }>,
  ): void {
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
  }

  private handlePatchApplyCompletedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "patch_apply_completed" }>,
  ): void {
    const bufferedOutput = this.consumeOutputDelta(
      this.pendingFileChangeOutputDeltas,
      parsed.callId,
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
  }

  private handleItemCompletedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "item_completed" }>,
  ): void {
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
    if (!timelineItem) {
      return;
    }
    const childSubAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
    if (childSubAgentCallId) {
      this.handleSubAgentChildItemCompleted(childSubAgentCallId, parsed.item.id, timelineItem);
      return;
    }
    const normalizedItemType = normalizeCodexThreadItemType(
      typeof parsed.item.type === "string" ? parsed.item.type : undefined,
    );
    const itemId = parsed.item.id;
    if (this.shouldSkipCompletedThreadItem(timelineItem, normalizedItemType, itemId)) {
      return;
    }
    if (this.consumeStreamedTextCompletion(timelineItem, itemId)) {
      if (timelineItem.type === "assistant_message") {
        this.pendingAssistantMessageBoundary = true;
      }
      if (itemId) {
        this.emittedItemCompletedIds.add(itemId);
        this.emittedItemStartedIds.delete(itemId);
      }
      return;
    }
    this.applyBufferedDeltaTextToTimelineItem(timelineItem, itemId);
    if (timelineItem.type === "tool_call") {
      this.registerSubAgentToolCall(timelineItem, parsed.item);
      if (timelineItem.detail.type === "plan") {
        this.rememberPlanResult(timelineItem);
        // Codex can surface plans both as turn/plan updates and as completed
        // thread items. In plan mode, approval owns the visible plan card.
        if (this.planModeEnabled) {
          return;
        }
      }
      this.warnOnIncompleteEditToolCall(timelineItem, "item_completed", parsed.item);
    }
    this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
    if (timelineItem.type === "assistant_message") {
      this.pendingAssistantMessageBoundary = true;
    }
    if (itemId) {
      this.emittedItemCompletedIds.add(itemId);
      this.emittedItemStartedIds.delete(itemId);
      this.pendingCommandOutputDeltas.delete(itemId);
      this.pendingFileChangeOutputDeltas.delete(itemId);
    }
  }

  private consumeStreamedTextCompletion(
    timelineItem: AgentTimelineItem,
    itemId: string | null | undefined,
  ): boolean {
    if (!itemId) {
      return false;
    }
    if (timelineItem.type === "assistant_message" && this.pendingAgentMessages.has(itemId)) {
      const streamedText = this.pendingAgentMessages.get(itemId) ?? "";
      this.pendingAgentMessages.delete(itemId);
      this.emitMissingFinalTextSuffix(timelineItem, streamedText);
      return true;
    }
    if (timelineItem.type === "reasoning" && this.pendingReasoning.has(itemId)) {
      const streamedText = this.pendingReasoning.get(itemId)?.join("") ?? "";
      this.pendingReasoning.delete(itemId);
      this.emitMissingFinalTextSuffix(timelineItem, streamedText);
      return true;
    }
    return false;
  }

  private emitMissingFinalTextSuffix(
    timelineItem: Extract<AgentTimelineItem, { type: "assistant_message" | "reasoning" }>,
    streamedText: string,
  ): void {
    if (!timelineItem.text.startsWith(streamedText)) {
      this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
      return;
    }
    const suffix = timelineItem.text.slice(streamedText.length);
    if (!suffix) {
      return;
    }
    this.emitEvent({
      type: "timeline",
      provider: CODEX_PROVIDER,
      item: { type: timelineItem.type, text: suffix },
    });
  }

  private applyBufferedDeltaTextToTimelineItem(
    timelineItem: AgentTimelineItem,
    itemId: string | null | undefined,
  ): void {
    if (!itemId) {
      return;
    }
    if (timelineItem.type === "assistant_message") {
      const buffered = this.pendingAgentMessages.get(itemId);
      if (buffered && buffered.length > 0) {
        timelineItem.text = buffered;
      }
      return;
    }
    if (timelineItem.type === "reasoning") {
      const buffered = this.pendingReasoning.get(itemId);
      if (buffered && buffered.length > 0) {
        timelineItem.text = buffered.join("");
      }
    }
  }

  private handleItemStartedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "item_started" }>,
  ): void {
    if (parsed.source === "codex_event") {
      return;
    }
    const timelineItem = threadItemToTimeline(parsed.item, {
      includeUserMessage: false,
      cwd: this.config.cwd ?? null,
    });
    if (!timelineItem || timelineItem.type !== "tool_call") {
      return;
    }
    const childSubAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
    if (childSubAgentCallId) {
      if (parsed.item.id) {
        this.upsertSubAgentChildItem(childSubAgentCallId, parsed.item.id, timelineItem);
      }
      this.emitSubAgentActivityUpdate(childSubAgentCallId, "running");
      return;
    }
    const normalizedItemType = normalizeCodexThreadItemType(
      typeof parsed.item.type === "string" ? parsed.item.type : undefined,
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
    this.registerSubAgentToolCall(timelineItem, parsed.item);
    this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
    if (itemId) {
      this.emittedItemStartedIds.add(itemId);
      this.pendingCommandOutputDeltas.delete(itemId);
      this.pendingFileChangeOutputDeltas.delete(itemId);
    }
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
    this.logger.warn({ method, params }, "Invalid Codex app-server notification payload");
  }

  private appendOutputDeltaChunk(
    store: Map<string, string[]>,
    id: string | null | undefined,
    chunk: string | null | undefined,
    options?: { decodeBase64?: boolean },
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

  private consumeOutputDelta(
    store: Map<string, string[]>,
    id: string | null | undefined,
  ): string | null {
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

  private rememberTerminalProcessForCommand(command: unknown, output: string | null): void {
    const normalizedCommand = normalizeCodexCommandValue(command);
    if (!normalizedCommand) {
      return;
    }
    const displayCommand =
      typeof normalizedCommand === "string"
        ? normalizedCommand
        : normalizedCommand.join(" ").trim();
    if (!displayCommand) {
      return;
    }
    const processId = extractCodexTerminalSessionId(output ?? undefined);
    if (!processId) {
      return;
    }
    this.terminalCommandByProcessId.set(processId, displayCommand);
    if (!this.pendingUnlabeledTerminalInteractions.has(processId)) {
      return;
    }
    this.pendingUnlabeledTerminalInteractions.delete(processId);
    this.emitEvent({
      type: "timeline",
      provider: CODEX_PROVIDER,
      item: mapCodexTerminalInteractionToToolCall({
        processId,
        command: displayCommand,
      }),
    });
  }

  private shouldEmitTerminalInteractionKey(key: string): boolean {
    if (this.emittedTerminalInteractionKeys.has(key)) {
      return false;
    }
    this.emittedTerminalInteractionKeys.add(key);
    return true;
  }

  private warnOnIncompleteEditToolCall(
    item: ToolCallTimelineItem,
    source: string,
    payload: unknown,
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
      "Codex edit tool call is missing diff/content fields",
    );
  }

  private handleCommandApprovalRequest(params: unknown): Promise<unknown> {
    const parsed = z
      .object({
        itemId: z.string(),
        threadId: z.string(),
        turnId: z.string(),
        command: z.string().nullable().optional(),
        cwd: z.string().nullable().optional(),
        reason: z.string().nullable().optional(),
      })
      .parse(params);
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
      detail: commandPreview?.detail ?? {
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
    const parsed = z
      .object({
        itemId: z.string(),
        threadId: z.string(),
        turnId: z.string(),
        reason: z.string().nullable().optional(),
      })
      .parse(params);
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
    const parsed = z
      .object({
        itemId: z.string(),
        threadId: z.string(),
        turnId: z.string(),
        questions: z.array(z.unknown()),
      })
      .parse(params);
    const requestId = `permission-${parsed.itemId}`;
    const questions = normalizeCodexQuestionPrompts(parsed.questions);
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: CODEX_PROVIDER,
      name: "request_user_input",
      kind: "question",
      title: "Question",
      description: undefined,
      detail: {
        type: "plain_text",
        text: formatCodexQuestionPrompts(questions),
        icon: "brain",
      },
      input: { questions },
      metadata: {
        itemId: parsed.itemId,
        threadId: parsed.threadId,
        turnId: parsed.turnId,
        questions,
      },
    };
    this.pendingPermissions.set(requestId, request);
    this.emitEvent({
      type: "timeline",
      provider: CODEX_PROVIDER,
      item: mapCodexQuestionRequestToToolCall({
        callId: parsed.itemId,
        questions,
        status: "running",
      }),
    });
    this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
    return new Promise((resolve) => {
      this.pendingPermissionHandlers.set(requestId, {
        resolve,
        kind: "question",
        questions,
      });
    });
  }
}

export class CodexAppServerAgentClient implements AgentClient {
  readonly provider = CODEX_PROVIDER;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;
  private goalsEnabledPromise: Promise<boolean> | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly runtimeSettings?: ProviderRuntimeSettings,
    private readonly deps: CodexAppServerAgentDeps = {},
  ) {}

  private resolveGoalsEnabled(): Promise<boolean> {
    if (!this.goalsEnabledPromise) {
      this.goalsEnabledPromise = (async () => {
        try {
          const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
          const versionOutput = await resolveBinaryVersion(launchPrefix.command);
          const enabled = codexVersionAtLeast(versionOutput, CODEX_GOALS_MIN_VERSION);
          this.logger.trace({ versionOutput, enabled }, "Resolved codex goals feature gate");
          return enabled;
        } catch (error) {
          this.logger.warn({ err: error }, "Failed to probe codex version for goals gate");
          return false;
        }
      })();
    }
    return this.goalsEnabledPromise;
  }

  private async spawnAppServer(
    launchEnv?: Record<string, string>,
    options?: { goalsEnabled?: boolean },
  ): Promise<ChildProcessWithoutNullStreams> {
    const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
    const args = [...launchPrefix.args, "app-server"];
    if (options?.goalsEnabled) {
      args.push("--enable", "goals");
    }
    this.logger.trace(
      {
        launchPrefix,
        goalsEnabled: options?.goalsEnabled === true,
      },
      "Spawning Codex app server",
    );
    const child = spawnProcess(launchPrefix.command, args, {
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
      ...createProviderEnvSpec({
        runtimeSettings: this.runtimeSettings,
        overlays: [launchEnv],
      }),
    });
    assertChildWithPipes(child);
    return child;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    if (options?.persistSession === false) {
      this.logger.debug(
        "Codex app-server does not expose an ephemeral-session option; persistSession=false is currently a no-op",
      );
      // TODO: Honor persistSession=false if app-server adds support, or route
      // utility generations through `codex exec --ephemeral` in a larger change.
    }
    const sessionConfig: AgentSessionConfig = { ...config, provider: CODEX_PROVIDER };
    const goalsEnabled = await this.resolveGoalsEnabled();
    const session = new CodexAppServerAgentSession(
      sessionConfig,
      null,
      this.logger,
      () => this.spawnAppServer(launchContext?.env, { goalsEnabled }),
      this.deps,
      options?.persistSession === false,
      goalsEnabled,
    );
    await session.connect();
    return session;
  }

  async resumeSession(
    handle: { sessionId: string; metadata?: Record<string, unknown> },
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const storedConfig = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const merged: AgentSessionConfig = {
      ...storedConfig,
      ...overrides,
      provider: CODEX_PROVIDER,
      cwd: overrides?.cwd ?? storedConfig.cwd ?? process.cwd(),
    };
    const goalsEnabled = await this.resolveGoalsEnabled();
    const session = new CodexAppServerAgentSession(
      merged,
      handle,
      this.logger,
      () => this.spawnAppServer(launchContext?.env, { goalsEnabled }),
      this.deps,
      false,
      goalsEnabled,
    );
    await session.connect();
    return session;
  }

  async listPersistedAgents(
    options?: ListPersistedAgentsOptions,
  ): Promise<PersistedAgentDescriptor[]> {
    const child = await this.spawnAppServer();
    const client =
      this.deps._createCodexClient?.(child, this.logger) ??
      new CodexAppServerClient(child, this.logger);

    try {
      await client.request("initialize", buildCodexAppServerInitializeParams());
      client.notify("initialized", {});

      const limit = options?.limit ?? 20;
      // thread/list returns the cheap `cwd` field. When the caller supplied
      // a cwd hint we filter here so the per-thread `thread/read includeTurns`
      // hydration below only runs for matching threads. Fetch a wider window
      // when filtering since most threads will be from other cwds.
      const listLimit = options?.cwd ? Math.max(limit, 50) : limit;
      const response = toObjectRecord(await client.request("thread/list", { limit: listLimit }));
      const allThreads = Array.isArray(response?.data) ? response.data.filter(isRecord) : [];
      const threads = filterCodexThreadsByCwd(allThreads, options?.cwd);
      const descriptors: PersistedAgentDescriptor[] = await Promise.all(
        threads.slice(0, limit).map(async (thread) => {
          const threadId = typeof thread.id === "string" ? thread.id : "";
          const cwd = typeof thread.cwd === "string" ? thread.cwd : process.cwd();
          const title = typeof thread.preview === "string" ? thread.preview : null;
          let timeline: AgentTimelineItem[] = [];

          try {
            timeline = await loadCodexThreadHistoryTimeline({
              threadId,
              cwd,
              requestThread: (threadIdToRead) => {
                return readCodexThread(client, threadIdToRead);
              },
            });
          } catch {
            timeline = [];
          }

          return {
            provider: CODEX_PROVIDER,
            sessionId: threadId,
            cwd,
            title,
            lastActivityAt: new Date(
              ((typeof thread.updatedAt === "number" ? thread.updatedAt : undefined) ??
                (typeof thread.createdAt === "number" ? thread.createdAt : undefined) ??
                0) * 1000,
            ),
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
          };
        }),
      );

      return descriptors;
    } finally {
      await client.dispose();
    }
  }

  async listModels(_options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    // Codex model/list is global to the app server in this flow; cwd/force are intentionally ignored.
    const child = await this.spawnAppServer();
    const client = new CodexAppServerClient(child, this.logger);

    try {
      await client.request("initialize", buildCodexAppServerInitializeParams());
      client.notify("initialized", {});

      const rawResponse = await client.request("model/list", {});
      const parsedResponse = CodexModelListResponseSchema.safeParse(rawResponse);
      const models = parsedResponse.success ? (parsedResponse.data.data ?? []) : [];
      const configuredDefaults = await readCodexConfiguredDefaults(client, this.logger);
      const configuredDefaultModelId = configuredDefaults.model;
      const configuredDefaultThinkingOptionId = configuredDefaults.thinkingOptionId;
      const hasConfiguredDefaultModel =
        typeof configuredDefaultModelId === "string"
          ? models.some((model) => model?.id === configuredDefaultModelId)
          : false;
      return models.map((model) =>
        buildCodexModelDefinition(model, {
          configuredDefaultModelId,
          configuredDefaultThinkingOptionId,
          hasConfiguredDefaultModel,
        }),
      );
    } finally {
      await client.dispose();
    }
  }

  async archiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    const threadId = handle.nativeHandle ?? handle.sessionId;
    if (!threadId) return;

    const child = await this.spawnAppServer();
    const client = new CodexAppServerClient(child, this.logger);

    try {
      await client.request("initialize", buildCodexAppServerInitializeParams());
      client.notify("initialized", {});
      await client.request("thread/archive", { threadId });
    } finally {
      await client.dispose();
    }
  }

  async isAvailable(): Promise<boolean> {
    const command = this.runtimeSettings?.command;
    if (command?.mode === "replace") {
      return await isCommandAvailable(command.argv[0]);
    }
    return await isCommandAvailable("codex");
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const resolvedBinary = await findExecutable("codex");
      const entries: Array<{ label: string; value: string }> = [
        {
          label: "Binary",
          value: resolvedBinary ?? "not found",
        },
        {
          label: "Version",
          value: resolvedBinary ? await resolveBinaryVersion(resolvedBinary) : "unknown",
        },
      ];
      let status = formatDiagnosticStatus(available);

      if (!available) {
        entries.push({ label: "Models", value: "Not checked" });
      } else {
        try {
          const models = await this.listModels({ cwd: homedir(), force: false });
          entries.push({ label: "Models", value: String(models.length) });
        } catch (error) {
          entries.push({
            label: "Models",
            value: `Error - ${toDiagnosticErrorMessage(error)}`,
          });
          status = formatDiagnosticStatus(available, {
            source: "model fetch",
            cause: error,
          });
        }
      }

      entries.push({ label: "Status", value: status });

      return {
        diagnostic: formatProviderDiagnostic("Codex", entries),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Codex", error),
      };
    }
  }
}

interface CodexModelBuildContext {
  configuredDefaultModelId: string | undefined;
  configuredDefaultThinkingOptionId: string | undefined;
  hasConfiguredDefaultModel: boolean;
}

function buildCodexModelDefinition(
  model: CodexModel,
  ctx: CodexModelBuildContext,
): AgentModelDefinition {
  const defaultReasoningEffort = normalizeCodexThinkingOptionId(
    typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : null,
  );
  const resolvedDefaultReasoningEffort =
    ctx.configuredDefaultThinkingOptionId ?? defaultReasoningEffort;

  const thinkingById = buildCodexThinkingOptionMap(
    model.supportedReasoningEfforts,
    resolvedDefaultReasoningEffort,
    ctx.configuredDefaultThinkingOptionId,
  );

  const thinkingOptions = Array.from(thinkingById.values()).map((option) =>
    Object.assign({}, option, {
      isDefault: option.id === resolvedDefaultReasoningEffort,
    }),
  );
  const defaultThinkingOptionId =
    resolvedDefaultReasoningEffort ??
    thinkingOptions.find((option) => option.isDefault)?.id ??
    thinkingOptions[0]?.id;
  const isDefaultModel = ctx.hasConfiguredDefaultModel
    ? model.id === ctx.configuredDefaultModelId
    : model.isDefault;

  return {
    provider: CODEX_PROVIDER,
    id: model.id,
    label: normalizeCodexModelLabel(model.displayName ?? ""),
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
}

function buildCodexThinkingOptionMap(
  supportedReasoningEfforts: CodexReasoningEffortEntry[] | undefined,
  resolvedDefaultReasoningEffort: string | undefined,
  configuredDefaultThinkingOptionId: string | undefined,
): Map<string, { id: string; label: string; description?: string }> {
  const thinkingById = new Map<string, { id: string; label: string; description?: string }>();
  if (Array.isArray(supportedReasoningEfforts)) {
    for (const entry of supportedReasoningEfforts) {
      const id = normalizeCodexThinkingOptionId(
        typeof entry?.reasoningEffort === "string" ? entry.reasoningEffort : null,
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
  return thinkingById;
}

function resolveSkillDescription(skill: Record<string, unknown>): string {
  if (typeof skill.description === "string") {
    return skill.description;
  }
  if (typeof skill.shortDescription === "string") {
    return skill.shortDescription;
  }
  return "Skill";
}

export const __codexAppServerInternals = {
  buildCodexAppServerEnv,
  CodexAppServerClient,
  codexModelSupportsFastMode,
  CodexAppServerAgentSession,
  formatCodexQuestionPrompts,
  mapCodexQuestionRequestToToolCall,
  mapCodexPatchNotificationToToolCall,
  planStepsToMarkdown,
  mapCodexPlanToToolCall,
  listCodexSkills,
  normalizeCodexOutputSchema,
  normalizeCodexQuestionPrompts,
  toAgentUsage,
  threadItemToTimeline,
};
