import {
  getAgentStreamEventTurnId,
  type AgentPermissionAction,
  type AgentCapabilityFlags,
  type AgentClient,
  type AgentCreateSessionOptions,
  type AgentFeature,
  type AgentLaunchContext,
  type AgentMode,
  type AgentModelDefinition,
  type McpServerConfig,
  type AgentPersistenceHandle,
  type AgentPermissionRequest,
  type AgentPermissionResponse,
  type AgentPermissionResult,
  type AgentProviderNotice,
  type AgentPromptContentBlock,
  type AgentPromptInput,
  type AgentRunOptions,
  type AgentRunResult,
  type AgentRuntimeInfo,
  type AgentSession,
  type AgentSessionConfig,
  type AgentSlashCommand,
  type AgentStreamEvent,
  type AgentTimelineItem,
  type ToolCallTimelineItem,
  type AgentUsage,
  type FetchCatalogOptions,
  type ImportableProviderSession,
  type ImportProviderSessionContext,
  type ImportProviderSessionInput,
  type ListImportableSessionsOptions,
  type ProviderCatalog,
} from "../agent-sdk-types.js";
import { importSessionFromPersistence } from "../provider-session-import.js";
import type { Logger } from "pino";

import type { ChildProcess, ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { Dirent } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { renderPromptAttachmentAsText } from "../prompt-attachments.js";
import { composeSystemPromptParts } from "../system-prompt.js";
import { curateAgentActivity } from "../activity-curator.js";
import {
  mapCodexToolCallEnvelope,
  mapCodexToolCallFromThreadItem,
  splitCodexMcpToolResultImages,
} from "./codex/tool-call-mapper.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnv,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../provider-launch-config.js";
import {
  findExecutable,
  probeExecutable,
} from "../../../executable-resolution/executable-resolution.js";
import { createPathEquivalenceMatcher } from "../../../utils/path.js";
import { spawnProcess } from "../../../utils/spawn.js";
import { extractCodexTerminalSessionId, nonEmptyString } from "./tool-call-mapper-utils.js";
import { buildCodexFeatures, codexModelSupportsFastMode } from "./codex-feature-definitions.js";
import {
  CodexAppServerClient,
  parseCodexThreadForkResponse,
  parseCodexThreadRollbackResponse,
  type CodexThreadForkParams,
  type CodexThreadForkResponse,
  type CodexThreadRollbackParams,
  type CodexThreadRollbackResponse,
  type CodexAppServerTraceContext,
} from "./codex/app-server-transport.js";
import { type CodexUserMessageTurnIndex, revertCodexConversation } from "./codex/rewind.js";
import {
  materializeProviderImage,
  renderProviderImageOutputAsAssistantMarkdown,
  type ProviderImageOutput,
} from "./provider-image-output.js";
import { normalizeProviderReplayTimestamp } from "../provider-history-timestamps.js";
import {
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  resolveBinaryVersion,
} from "./diagnostic-utils.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "./provider-runner.js";
import { SETTING_APPLIES_NEXT_TURN_NOTICE } from "../provider-notices.js";
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

function isCodexAlreadyUnarchivedError(error: unknown, threadId: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes(`no archived rollout found for thread id ${threadId}`);
}

const TURN_START_TIMEOUT_MS = 90 * 1000;
const INTERRUPT_TIMEOUT_MS = 2_000;
const CODEX_PROVIDER = "codex" as const;
// Codex treats most app-server client names as the model-request originator.
// This reserved Codex name is non-originating, so requests keep Codex's default
// CLI identity instead of showing up as Paseo in provider usage logs.
const CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_INFO = {
  name: "codex_app_server_daemon",
  title: "Codex App Server Daemon",
  version: "0.0.0",
} as const;
const ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN = "\n\n---\n\n";
const MAX_PENDING_SUB_AGENT_THREADS = 32;
const MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD = 128;
// COMPAT(codexLegacyCollabAgentToolCall): Codex <0.143 emits this shape. Added in
// Paseo v0.1.105; remove after 2027-01-09 once the supported Codex floor is >=0.143.
const CODEX_TOOL_THREAD_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "collabAgentToolCall",
  "subAgentActivity",
]);
const CODEX_CONTEXT_COMPACTION_TYPE = "contextCompaction";
const CODEX_PLAN_IMPLEMENTATION_PROMPT_PREFIX =
  "The user approved the plan. Implement it now. Do not restate or revise the plan unless blocked.";

// Codex's experimental `goals` feature ships in 0.128.0+. Older binaries reject
// `--enable goals` at launch, so we gate by version and silently skip the flag
// (and the /goal slash command) when the binary is too old.
const CODEX_GOALS_MIN_VERSION: readonly [number, number, number] = [0, 128, 0];
const CODEX_AUTO_REVIEW_MIN_VERSION: readonly [number, number, number] = [0, 115, 0];

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
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: true,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

const CODEX_MODES: AgentMode[] = [
  {
    id: "auto",
    label: "Default Permissions",
    description: "Edit files and run commands with Codex's default approval flow.",
  },
  {
    id: "auto-review",
    label: "Auto-review",
    description:
      "Same workspace-write permissions as Default, but eligible `on-request` approvals are routed through the auto-reviewer subagent.",
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
  forkThread?(params: CodexThreadForkParams): Promise<CodexThreadForkResponse>;
  rollbackThread?(params: CodexThreadRollbackParams): Promise<CodexThreadRollbackResponse>;
  notify(method: string, params?: unknown): void;
  dispose(): Promise<void>;
}

interface CodexAppServerAgentDeps {
  workspaceGitService?: Pick<WorkspaceGitService, "resolveRepoRoot">;
  customProvider?: {
    id: string;
    label: string;
    extends: string;
  };
  customCodexConfig?: Record<string, unknown> | null;
  _createCodexClient?: (
    child: ChildProcessWithoutNullStreams,
    logger: Logger,
    getTraceContext: () => CodexAppServerTraceContext,
  ) => CodexAppServerClientLike;
}

interface CodexModePreset {
  approvalPolicy: string;
  sandbox: string;
  networkAccess?: boolean;
  approvalsReviewer?: "auto_review";
}

const MODE_PRESETS: Record<string, CodexModePreset> = {
  "read-only": {
    approvalPolicy: "on-request",
    sandbox: "read-only",
  },
  auto: {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
  },
  "auto-review": {
    approvalPolicy: "on-request",
    sandbox: "workspace-write",
    approvalsReviewer: "auto_review",
  },
  "full-access": {
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    networkAccess: true,
  },
};

function isAutoReviewReviewer(value: string | undefined): boolean {
  return value === "auto_review" || value === "guardian_subagent";
}

function applyApprovalsReviewerParam(
  params: Record<string, unknown>,
  preset: CodexModePreset,
): void {
  if (preset.approvalsReviewer) {
    params.approvalsReviewer = preset.approvalsReviewer;
  }
}

function shouldPromoteThreadResponseToAutoReview(params: {
  approvalsReviewer: string | undefined;
  approvalPolicy: string;
  sandbox: string;
}): boolean {
  return (
    isAutoReviewReviewer(params.approvalsReviewer) &&
    params.approvalPolicy === "on-request" &&
    params.sandbox === "workspace-write"
  );
}

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

export function normalizeCodexOutputSchema(schema: unknown): Record<string, unknown> {
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

interface PersistedTimelineEntry {
  item: AgentTimelineItem;
  timestamp?: string;
}

interface PersistedSubAgentRoute {
  childThreadId: string;
  toolCall: ToolCallTimelineItem;
}

interface CodexThreadHistoryProjection {
  timeline: PersistedTimelineEntry[];
  subAgentRoutes: PersistedSubAgentRoute[];
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

function codexMicrosoftStorePackageRoot(): string | null {
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) {
    return null;
  }
  return path.join(localAppData, "Packages");
}

export async function findCodexMicrosoftStoreBinary(): Promise<string | null> {
  if (process.platform !== "win32") {
    return null;
  }

  const packageRoot = codexMicrosoftStorePackageRoot();
  if (!packageRoot) {
    return null;
  }

  let entries: Dirent[];
  try {
    entries = await fs.readdir(packageRoot, { withFileTypes: true });
  } catch {
    return null;
  }

  const codexPackages = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"))
    .map((entry) => entry.name)
    .sort();

  for (const packageName of codexPackages) {
    const candidate = path.join(
      packageRoot,
      packageName,
      "LocalCache",
      "Local",
      "OpenAI",
      "Codex",
      "bin",
      "codex.exe",
    );
    if (await probeExecutable(candidate)) {
      return candidate;
    }
  }

  return null;
}

export async function findDefaultCodexBinary(): Promise<string | null> {
  return (await findExecutable("codex")) ?? (await findCodexMicrosoftStoreBinary());
}

async function resolveCodexLaunchPrefix(runtimeSettings?: ProviderRuntimeSettings): Promise<{
  command: string;
  args: string[];
}> {
  const launch = await resolveCodexLaunch(runtimeSettings);
  const availability = await checkCodexLaunchAvailable(launch);
  if (!availability.available) {
    throw new Error(
      "Codex binary not found. Install the Codex CLI (https://github.com/openai/codex) and ensure it is available in your shell PATH.",
    );
  }
  return {
    command:
      launch.source === "override" ? launch.command : (availability.resolvedPath ?? launch.command),
    args: launch.args,
  };
}

async function resolveCodexLaunch(
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<ResolvedProviderLaunch> {
  return resolveProviderLaunch({
    commandConfig: runtimeSettings?.command,
    defaultBinary: {
      command: "codex",
      resolvePath: findDefaultCodexBinary,
    },
  });
}

async function checkCodexLaunchAvailable(launch: ResolvedProviderLaunch) {
  return checkProviderLaunchAvailable(launch, {
    command: "codex",
    resolvePath: findDefaultCodexBinary,
  });
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
        kind: "command",
      };
    }),
  );
  const commands: AgentSlashCommand[] = parsedCommands.filter(
    (cmd): cmd is AgentSlashCommand => cmd !== null,
  );
  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

export async function listCodexSkills(
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
          kind: "skill",
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

function toObjectRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

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
  const matchesCwd = createPathEquivalenceMatcher(cwd);
  return threads.filter((thread) => typeof thread.cwd === "string" && matchesCwd(thread.cwd));
}

export function toAgentUsage(tokenUsage: unknown): AgentUsage | undefined {
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

export function planStepsToMarkdown(steps: Array<{ step: string; status: string }>): string {
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

export function mapCodexPlanToToolCall(params: {
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

export function normalizeCodexQuestionPrompts(raw: unknown): CodexQuestionPrompt[] {
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

export function formatCodexQuestionPrompts(questions: CodexQuestionPrompt[]): string {
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

export function mapCodexQuestionRequestToToolCall(params: {
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
    case "SubAgentActivity":
      return "subAgentActivity";
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
  const mapped = mapCodexToolCallEnvelope({
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

export function mapCodexPatchNotificationToToolCall(params: {
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
  const mapped = mapCodexToolCallEnvelope({
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
  callId: string;
  processId?: string | null;
  command?: string | null;
  stdin?: string | null;
}): ToolCallTimelineItem {
  const processId = nonEmptyString(params.processId ?? undefined);
  const label = nonEmptyString(params.command ?? undefined);
  return {
    type: "tool_call",
    callId: params.callId,
    name: "terminal",
    status: "completed",
    error: null,
    detail: {
      type: "plain_text",
      ...(label ? { label } : {}),
      ...(params.stdin !== null && params.stdin !== undefined ? { text: params.stdin } : {}),
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
  const messageId = nonEmptyString(normalizedItem.id);
  return {
    type: "user_message",
    text,
    ...(messageId ? { messageId } : {}),
  };
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

function readCodexHistoryTimestamp(item: unknown): string | null {
  const record = toObjectRecord(item);
  if (!record) {
    return null;
  }
  return (
    normalizeProviderReplayTimestamp(record.timestamp) ??
    normalizeProviderReplayTimestamp(record.createdAt) ??
    normalizeProviderReplayTimestamp(record.created_at)
  );
}

function readCodexTurnHistoryTimestamp(
  turn: unknown,
  timelineItem: AgentTimelineItem,
): string | null {
  const record = toObjectRecord(turn);
  if (!record) {
    return null;
  }

  const startedAt =
    normalizeProviderReplayTimestamp(record.startedAt) ??
    normalizeProviderReplayTimestamp(record.started_at);
  const completedAt =
    normalizeProviderReplayTimestamp(record.completedAt) ??
    normalizeProviderReplayTimestamp(record.completed_at);

  if (timelineItem.type === "user_message") {
    return startedAt ?? completedAt;
  }
  return completedAt ?? startedAt;
}

interface CodexSubAgentActivity {
  id: string | null;
  agentThreadId: string;
  kind: "started" | "interacted" | "interrupted";
}

function readCodexSubAgentActivity(item: unknown): CodexSubAgentActivity | null {
  const record = toObjectRecord(item);
  if (!record) {
    return null;
  }
  const normalizedType = normalizeCodexThreadItemType(
    typeof record.type === "string" ? record.type : undefined,
  );
  if (
    normalizedType !== "subAgentActivity" ||
    typeof record.agentThreadId !== "string" ||
    (record.kind !== "started" && record.kind !== "interacted" && record.kind !== "interrupted")
  ) {
    return null;
  }
  return {
    id: nonEmptyString(record.id) ?? null,
    agentThreadId: record.agentThreadId,
    kind: record.kind,
  };
}

function settleHistoricalSubAgentActivity(
  item: ToolCallTimelineItem,
  kind: CodexSubAgentActivity["kind"],
): ToolCallTimelineItem {
  // thread/read returns completed parent items, not a live child snapshot.
  // Only an explicit interruption remains non-completed when replayed.
  return {
    ...item,
    status: kind === "interrupted" ? "canceled" : "completed",
    error: null,
  };
}

function updateHistoricalSubAgentActivity(
  timeline: PersistedTimelineEntry[],
  index: number,
  kind: CodexSubAgentActivity["kind"],
): void {
  const existing = timeline[index];
  if (existing?.item.type !== "tool_call") {
    return;
  }
  timeline[index] = {
    ...existing,
    item: settleHistoricalSubAgentActivity(existing.item, kind),
  };
}

function readCodexHistoricalSubAgentThreadIds(item: unknown): string[] {
  const activity = readCodexSubAgentActivity(item);
  if (activity) {
    return [activity.agentThreadId];
  }
  const record = toObjectRecord(item);
  const normalizedType = normalizeCodexThreadItemType(
    typeof record?.type === "string" ? record.type : undefined,
  );
  if (normalizedType !== "collabAgentToolCall" || !Array.isArray(record?.receiverThreadIds)) {
    return [];
  }
  return record.receiverThreadIds.filter(
    (threadId): threadId is string => typeof threadId === "string" && threadId.length > 0,
  );
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
    { materialize: materializeProviderImage },
  );
}

export function threadItemToTimeline(
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
    case "agentMessage": {
      const messageId = nonEmptyString(normalizedItem.id);
      return {
        type: "assistant_message",
        text: typeof normalizedItem.text === "string" ? normalizedItem.text : "",
        ...(messageId ? { messageId } : {}),
      };
    }
    case "plan":
      return mapCodexThreadPlanItem(normalizedItem);
    case "reasoning":
      return mapCodexThreadReasoningItem(normalizedItem);
    case CODEX_CONTEXT_COMPACTION_TYPE:
      return {
        type: "compaction",
        status: "completed",
      };
    default:
      return null;
  }
}

function mcpToolResultImagesToTimeline(item: unknown): AgentTimelineItem[] {
  const itemRecord = toObjectRecord(item);
  if (!itemRecord) {
    return [];
  }
  const normalizedType = normalizeCodexThreadItemType(
    typeof itemRecord.type === "string" ? itemRecord.type : undefined,
  );
  if (normalizedType !== "mcpToolCall") {
    return [];
  }

  const { images } = splitCodexMcpToolResultImages(itemRecord.result);
  return images
    .map((image) =>
      renderProviderImageOutputAsAssistantMarkdown(image, {
        materialize: materializeProviderImage,
      }),
    )
    .filter((timelineItem): timelineItem is AgentTimelineItem => timelineItem !== null);
}

function threadItemToTimelineEntries(
  item: unknown,
  options?: { includeUserMessage?: boolean; cwd?: string | null },
): AgentTimelineItem[] {
  const timelineItem = threadItemToTimeline(item, options);
  if (!timelineItem) {
    return [];
  }
  return [timelineItem, ...mcpToolResultImagesToTimeline(item)];
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
}): Promise<CodexThreadHistoryProjection> {
  const response = await requestCodexThreadHistory(params.requestThread, params.threadId);
  const timeline: PersistedTimelineEntry[] = [];
  const subAgentTimelineIndexByThreadId = new Map<string, number>();
  for (const turn of response.thread.turns) {
    for (const item of turn.items) {
      const historicalSubAgentActivity = readCodexSubAgentActivity(item);
      if (historicalSubAgentActivity) {
        const existingIndex = subAgentTimelineIndexByThreadId.get(
          historicalSubAgentActivity.agentThreadId,
        );
        if (existingIndex !== undefined) {
          updateHistoricalSubAgentActivity(
            timeline,
            existingIndex,
            historicalSubAgentActivity.kind,
          );
          continue;
        }
      }
      for (const timelineItem of threadItemToTimelineEntries(item, { cwd: params.cwd })) {
        const timestamp =
          readCodexHistoryTimestamp(item) ?? readCodexTurnHistoryTimestamp(turn, timelineItem);
        const settledTimelineItem =
          historicalSubAgentActivity && timelineItem.type === "tool_call"
            ? settleHistoricalSubAgentActivity(timelineItem, historicalSubAgentActivity.kind)
            : timelineItem;
        timeline.push({
          item: settledTimelineItem,
          timestamp: timestamp ?? undefined,
        });
        for (const childThreadId of readCodexHistoricalSubAgentThreadIds(item)) {
          subAgentTimelineIndexByThreadId.set(childThreadId, timeline.length - 1);
        }
      }
    }
  }
  const subAgentRoutes = Array.from(subAgentTimelineIndexByThreadId.entries()).flatMap(
    ([childThreadId, timelineIndex]): PersistedSubAgentRoute[] => {
      const item = timeline[timelineIndex]?.item;
      return item?.type === "tool_call" && item.detail.type === "sub_agent"
        ? [{ childThreadId, toolCall: item }]
        : [];
    },
  );
  return { timeline, subAgentRoutes };
}

function readCodexThread(client: CodexAppServerClientLike, threadId: string): Promise<unknown> {
  return client.request("thread/read", {
    threadId,
    includeTurns: true,
  });
}

export async function forkCodexThread(
  client: CodexAppServerClientLike,
  params: CodexThreadForkParams,
): Promise<CodexThreadForkResponse> {
  if (client.forkThread) {
    return client.forkThread(params);
  }
  return parseCodexThreadForkResponse(await client.request("thread/fork", params));
}

export async function rollbackCodexThread(
  client: CodexAppServerClientLike,
  params: CodexThreadRollbackParams,
): Promise<CodexThreadRollbackResponse> {
  if (client.rollbackThread) {
    return client.rollbackThread(params);
  }
  return parseCodexThreadRollbackResponse(await client.request("thread/rollback", params));
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
    threadId: z.string().optional(),
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
    threadId: z.string().optional(),
    diff: z.string(),
  })
  .passthrough();

const ThreadTokenUsageUpdatedNotificationSchema = z
  .object({
    threadId: z.string().optional(),
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

const ContextCompactedNotificationSchema = z
  .object({
    threadId: z.string(),
    turnId: z.string().optional(),
  })
  .passthrough();

const CodexEventThreadIdFields = {
  threadId: z.string().optional(),
  thread_id: z.string().optional(),
};

function getCodexEventThreadId(params: {
  threadId?: string;
  thread_id?: string;
  msg: { threadId?: string; thread_id?: string };
}): string | null {
  return params.threadId ?? params.thread_id ?? params.msg.threadId ?? params.msg.thread_id ?? null;
}

const CodexEventTurnAbortedNotificationSchema = z
  .object({
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
        type: z.literal("turn_aborted"),
        reason: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventTaskCompleteNotificationSchema = z
  .object({
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
        type: z.literal("task_complete"),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventItemLifecycleNotificationSchema = z
  .object({
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
        type: z.enum(["item_started", "item_completed"]),
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
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
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
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
        type: z.literal("exec_command_end"),
        call_id: z.string().optional(),
        command: z.unknown().optional(),
        cwd: z.string().optional(),
        stdout: z.string().optional(),
        stderr: z.string().optional(),
        aggregated_output: z.string().nullable().optional(),
        aggregatedOutput: z.string().nullable().optional(),
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
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
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
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
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
    threadId: z.string().optional(),
    itemId: z.string().optional(),
    processId: z.union([z.string(), z.number()]).optional(),
    stdin: z.string().optional(),
  })
  .passthrough();

const CodexEventPatchApplyBeginNotificationSchema = z
  .object({
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
        type: z.literal("patch_apply_begin"),
        call_id: z.string().optional(),
        changes: z.unknown().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventPatchApplyEndNotificationSchema = z
  .object({
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
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
    threadId: z.string().optional(),
    itemId: z.string(),
    delta: z.string().optional(),
    chunk: z.string().optional(),
  })
  .passthrough();

const CodexEventTurnDiffNotificationSchema = z
  .object({
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
        type: z.literal("turn_diff"),
        unified_diff: z.string().optional(),
        diff: z.string().optional(),
      })
      .passthrough(),
  })
  .passthrough();

const CodexEventThreadRolledBackNotificationSchema = z
  .object({
    ...CodexEventThreadIdFields,
    msg: z
      .object({
        ...CodexEventThreadIdFields,
        type: z.literal("thread_rolled_back"),
        num_turns: z.number().int().nonnegative().optional(),
        numTurns: z.number().int().nonnegative().optional(),
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
  | {
      kind: "plan_updated";
      plan: Array<{ step: string | null; status: string | null }>;
      threadId: string | null;
    }
  | { kind: "diff_updated"; diff: string; threadId: string | null }
  | { kind: "token_usage_updated"; tokenUsage: unknown; threadId: string | null }
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
      threadId: string | null;
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
      threadId: string | null;
    }
  | {
      kind: "exec_command_output_delta";
      callId: string | null;
      stream: string | null;
      chunk: string | null;
      threadId: string | null;
    }
  | {
      kind: "terminal_interaction";
      source: "item" | "codex_event";
      callId: string | null;
      processId: string | null;
      stdin: string | null;
      threadId: string | null;
    }
  | {
      kind: "patch_apply_started";
      callId: string | null;
      changes: unknown;
      threadId: string | null;
    }
  | {
      kind: "patch_apply_completed";
      callId: string | null;
      changes: unknown;
      stdout: string | null;
      stderr: string | null;
      success: boolean | null;
      threadId: string | null;
    }
  | {
      kind: "file_change_output_delta";
      itemId: string;
      delta: string | null;
      threadId: string | null;
    }
  | { kind: "thread_rolled_back"; numTurns: number; threadId: string | null }
  | { kind: "context_compacted"; threadId: string; turnId: string | null }
  | { kind: "invalid_payload"; method: string; params: unknown }
  | { kind: "unknown_method"; method: string; params: unknown };

type CodexDeltaNotification = Extract<
  ParsedCodexNotification,
  {
    kind:
      | "agent_message_delta"
      | "reasoning_delta"
      | "exec_command_output_delta"
      | "file_change_output_delta";
  }
>;

type CodexThreadRoute =
  | { kind: "root" }
  | { kind: "sub_agent"; callId: string }
  | { kind: "pending_sub_agent"; threadId: string };

function getCodexNotificationThreadId(parsed: ParsedCodexNotification): string | null {
  return "threadId" in parsed ? parsed.threadId : null;
}

function isCodexDeltaNotification(
  parsed: ParsedCodexNotification,
): parsed is CodexDeltaNotification {
  return (
    parsed.kind === "agent_message_delta" ||
    parsed.kind === "reasoning_delta" ||
    parsed.kind === "exec_command_output_delta" ||
    parsed.kind === "file_change_output_delta"
  );
}

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
        threadId: params.threadId ?? null,
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
      ({ params }): ParsedCodexNotification => ({
        kind: "diff_updated",
        diff: params.diff,
        threadId: params.threadId ?? null,
      }),
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
        threadId: params.threadId ?? null,
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
    .object({ method: z.literal("thread/compacted"), params: ContextCompactedNotificationSchema })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "context_compacted",
        threadId: params.threadId,
        turnId: params.turnId ?? null,
      }),
    ),
  z.object({ method: z.literal("thread/compacted"), params: z.unknown() }).transform(
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
        threadId: getCodexEventThreadId(params),
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
        threadId: getCodexEventThreadId(params),
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
        threadId: getCodexEventThreadId(params),
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
        threadId: getCodexEventThreadId(params),
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
        threadId: getCodexEventThreadId(params),
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
        threadId: getCodexEventThreadId(params),
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
        threadId: params.threadId ?? null,
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
        threadId: getCodexEventThreadId(params),
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
        threadId: getCodexEventThreadId(params),
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
        threadId: params.threadId ?? null,
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
        threadId: getCodexEventThreadId(params),
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
      ({ params }): ParsedCodexNotification => ({
        kind: "turn_completed",
        status: "interrupted",
        errorMessage: null,
        threadId: getCodexEventThreadId(params),
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
      ({ params }): ParsedCodexNotification => ({
        kind: "turn_completed",
        status: "completed",
        errorMessage: null,
        threadId: getCodexEventThreadId(params),
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
    .object({
      method: z.literal("codex/event/thread_rolled_back"),
      params: CodexEventThreadRolledBackNotificationSchema,
    })
    .transform(
      ({ params }): ParsedCodexNotification => ({
        kind: "thread_rolled_back",
        numTurns: params.msg.num_turns ?? params.msg.numTurns ?? 0,
        threadId: getCodexEventThreadId(params),
      }),
    ),
  z.object({ method: z.literal("codex/event/thread_rolled_back"), params: z.unknown() }).transform(
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
        const filePath = materializeProviderImage({
          data: block.data,
          mimeType: block.mimeType,
        }).path;
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

export function buildCodexAppServerEnv(
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
  capabilities: { experimentalApi: true; mcpServerOpenaiFormElicitation: true };
} {
  return {
    clientInfo: CODEX_NON_ORIGINATING_APP_SERVER_CLIENT_INFO,
    capabilities: {
      experimentalApi: true,
      mcpServerOpenaiFormElicitation: true,
    },
  };
}

function normalizeOpenAICompatibleBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const withoutTrailingSlashes = trimmed.replace(/\/+$/u, "");
  if (withoutTrailingSlashes.endsWith("/v1")) {
    return withoutTrailingSlashes;
  }
  return `${withoutTrailingSlashes}/v1`;
}

function buildCodexCustomProviderConfig(
  runtimeSettings: ProviderRuntimeSettings | undefined,
  customProvider: CodexAppServerAgentDeps["customProvider"],
): Record<string, unknown> | null {
  if (customProvider?.extends !== CODEX_PROVIDER) {
    return null;
  }
  const baseUrl = runtimeSettings?.env?.OPENAI_BASE_URL;
  if (typeof baseUrl !== "string") {
    return null;
  }
  const normalizedBaseUrl = normalizeOpenAICompatibleBaseUrl(baseUrl);
  if (!normalizedBaseUrl) {
    return null;
  }
  const providerConfig: Record<string, unknown> = {
    name: customProvider.label,
    base_url: normalizedBaseUrl,
    wire_api: "responses",
  };
  if (runtimeSettings?.env?.OPENAI_API_KEY?.trim()) {
    providerConfig.env_key = "OPENAI_API_KEY";
    providerConfig.requires_openai_auth = false;
  }
  return {
    model_provider: customProvider.id,
    model_providers: {
      [customProvider.id]: providerConfig,
    },
  };
}

interface CodexSubAgentCallState {
  callId: string;
  toolCall: ToolCallTimelineItem;
  parentCallId: string | null;
  activityItemIds: Set<string>;
  pendingCommandOutputDeltas: Map<string, string[]>;
  pendingFileChangeOutputDeltas: Map<string, string[]>;
  childItemOrder: string[];
  childItems: Map<string, AgentTimelineItem>;
  childThreadIds: Set<string>;
}

export class CodexAppServerAgentSession implements AgentSession {
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
  private persistedHistory: PersistedTimelineEntry[] = [];
  private loadingPersistedHistory = false;
  private persistedProviderSubagentEvents: AgentStreamEvent[] = [];
  private pendingPermissions = new Map<string, AgentPermissionRequest>();
  private mcpElicitationPermissionIds = new Map<number, string>();
  private pendingPermissionHandlers = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      kind: "command" | "file" | "question" | "mcp_elicitation" | "plan";
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
  private pendingUnlabeledTerminalInteractions = new Map<
    string,
    Array<{ callId: string; stdin: string | null }>
  >();
  private nextTerminalInteractionOrdinal = 0;
  private emittedTerminalInteractionKeys = new Set<string>();
  private emittedExecCommandStartedCallIds = new Set<string>();
  private emittedExecCommandCompletedCallIds = new Set<string>();
  private emittedItemStartedIds = new Set<string>();
  private emittedItemCompletedIds = new Set<string>();
  private emittedProviderSubagentUserMessageKeys = new Set<string>();
  private subAgentCallsByCallId = new Map<string, CodexSubAgentCallState>();
  private subAgentCallIdByChildThreadId = new Map<string, string>();
  private pendingSubAgentNotificationsByThreadId = new Map<string, ParsedCodexNotification[]>();
  private warnedUnknownNotificationMethods = new Set<string>();
  private warnedInvalidNotificationPayloads = new Set<string>();
  private warnedIncompleteEditToolCallIds = new Set<string>();
  private latestUsage: AgentUsage | undefined;
  private latestPlanResult: { callId: string; text: string; turnId: string | null } | null = null;
  private readonly userMessageTurnIndexes = new Map<string, number>();
  private readonly userMessageTurnIds: string[] = [];
  private pendingManualCompactionStarts = 0;
  private compactionTriggerByItemId = new Map<string, "auto" | "manual">();
  // Codex can report one completed compaction through both channels:
  // `thread/compacted` and a completed `contextCompaction` item.
  private unpairedCompactionNotificationCompletions = 0;
  private unpairedCompactionItemCompletions = 0;
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
    private readonly autoReviewEnabled: boolean = false,
    private readonly agentId?: string,
  ) {
    this.logger = logger.child({
      module: "agent",
      provider: CODEX_PROVIDER,
      agentId: this.agentId,
    });
    if (config.modeId === undefined) {
      throw new Error("Codex agent requires modeId to be specified");
    }
    validateCodexMode(config.modeId);
    this.currentMode = config.modeId;
    this.config = config;
    this.config.thinkingOptionId = normalizeCodexThinkingOptionId(this.config.thinkingOptionId);
    if (this.config.featureValues?.fast_mode && codexModelSupportsFastMode(this.config.model)) {
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
    this.client = new CodexAppServerClient(child, this.logger, () => this.traceContext());
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

  private traceContext(): CodexAppServerTraceContext {
    return {
      agentId: this.agentId,
      sessionId: this.currentThreadId ?? undefined,
      turnId: this.activeForegroundTurnId ?? undefined,
    };
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
      this.logger.trace(
        {
          agentId: this.agentId,
          provider: CODEX_PROVIDER,
          sessionId: this.currentThreadId,
          turnId: this.activeForegroundTurnId ?? undefined,
          error,
        },
        "provider.codex.metadata.collaboration_modes_failed",
      );
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
      const skillsByName = new Map<string, { name: string; description: string; path: string }>();
      for (const entry of entries) {
        const entryRecord = toObjectRecord(entry);
        const list = Array.isArray(entryRecord?.skills) ? entryRecord.skills : [];
        for (const skill of list) {
          const skillRecord = toObjectRecord(skill);
          if (typeof skillRecord?.name !== "string" || typeof skillRecord?.path !== "string")
            continue;
          if (!skillsByName.has(skillRecord.name)) {
            skillsByName.set(skillRecord.name, {
              name: skillRecord.name,
              description: resolveSkillDescription(skillRecord),
              path: skillRecord.path,
            });
          }
        }
      }
      this.cachedSkills = Array.from(skillsByName.values());
    } catch (error) {
      this.logger.trace(
        {
          agentId: this.agentId,
          provider: CODEX_PROVIDER,
          sessionId: this.currentThreadId,
          turnId: this.activeForegroundTurnId ?? undefined,
          error,
        },
        "provider.codex.metadata.skills_failed",
      );
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
    const developerInstructions = composeSystemPromptParts(
      match.developer_instructions,
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
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
    this.client.setRequestHandler("mcpServer/elicitation/request", (params, requestId) =>
      this.handleMcpElicitationRequest(params, requestId),
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

    const history = await loadCodexThreadHistoryTimeline({
      threadId,
      cwd: this.config.cwd ?? null,
      requestThread: (threadIdToRead) => {
        return readCodexThread(client, threadIdToRead);
      },
    });
    const { timeline, subAgentRoutes } = history;
    this.subAgentCallsByCallId.clear();
    this.subAgentCallIdByChildThreadId.clear();
    this.pendingSubAgentNotificationsByThreadId.clear();
    this.persistedProviderSubagentEvents = [];
    this.loadingPersistedHistory = true;
    try {
      await this.loadPersistedSubAgentHistories(client, subAgentRoutes);
    } finally {
      this.loadingPersistedHistory = false;
    }
    this.resetCodexUserMessageTurns();
    for (const entry of timeline) {
      if (entry.item.type === "user_message") {
        this.rememberCodexUserMessageTurn(entry.item.messageId);
      }
    }
    this.persistedHistory = timeline;
    this.historyPending = timeline.length > 0;
  }

  private async loadPersistedSubAgentHistories(
    client: CodexAppServerClientLike,
    rootRoutes: readonly PersistedSubAgentRoute[],
  ): Promise<void> {
    const queue = rootRoutes.map((route) => ({ route, parentCallId: null as string | null }));
    const visitedThreadIds = new Set<string>();
    while (queue.length > 0 && visitedThreadIds.size < 100) {
      const next = queue.shift();
      if (!next || visitedThreadIds.has(next.route.childThreadId)) {
        continue;
      }
      visitedThreadIds.add(next.route.childThreadId);
      this.registerSubAgentToolCall({
        timelineItem: next.route.toolCall,
        rawItem: { agentThreadId: next.route.childThreadId },
        parentCallId: next.parentCallId,
      });
      try {
        const childHistory = await loadCodexThreadHistoryTimeline({
          threadId: next.route.childThreadId,
          cwd: this.config.cwd ?? null,
          requestThread: (childThreadId) => readCodexThread(client, childThreadId),
        });
        for (const entry of childHistory.timeline) {
          this.emitProviderSubagentTimeline(next.route.childThreadId, entry.item, entry.timestamp);
        }
        for (const route of childHistory.subAgentRoutes) {
          queue.push({ route, parentCallId: next.route.toolCall.callId });
        }
      } catch (error) {
        this.logger.trace(
          { err: error, childThreadId: next.route.childThreadId },
          "Failed to load persisted Codex child history",
        );
      }
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
      const developerInstructions = composeSystemPromptParts(
        this.config.systemPrompt,
        this.config.daemonAppendSystemPrompt,
      );
      if (developerInstructions) {
        params.developerInstructions = developerInstructions;
      }
      const codexConfig = this.buildCodexInnerConfig();
      if (codexConfig) {
        params.config = codexConfig;
      }
      await this.client.request("thread/resume", params);
    } catch (error) {
      const threadId = this.currentThreadId;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn({ error, threadId }, "Failed to resume persisted Codex thread");
      throw new Error(`Failed to resume Codex thread ${threadId}: ${message}`, { cause: error });
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
      const trimmedArgs = args?.trim() ?? "";
      const text = trimmedArgs ? `$${skill.name} ${trimmedArgs}` : `$${skill.name}`;
      const input: CodexPromptContentBlock[] = [
        { type: "skill", name: skill.name, path: skill.path },
        { type: "text", text },
      ];
      return input;
    }

    return args ? `$${commandName} ${args}` : `$${commandName}`;
  }

  private async buildTurnStartParams(
    prompt: CodexPromptInput,
    options?: AgentRunOptions,
  ): Promise<{
    params: Record<string, unknown>;
    thinkingOptionId?: string;
    approvalPolicy: string;
    sandboxPolicyType: string;
    hasOutputSchema: boolean;
    hasDeveloperInstructions: boolean;
    hasCodexConfig: boolean;
  }> {
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
          : preset.networkAccess,
      ),
    };
    applyApprovalsReviewerParam(params, preset);

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
    const developerInstructions = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
    if (developerInstructions) {
      params.developerInstructions = developerInstructions;
    }
    const codexConfig = this.buildCodexInnerConfig();
    if (codexConfig) {
      params.config = codexConfig;
    }

    return {
      params,
      thinkingOptionId,
      approvalPolicy,
      sandboxPolicyType,
      hasOutputSchema: Boolean(options?.outputSchema),
      hasDeveloperInstructions: Boolean(developerInstructions),
      hasCodexConfig: Boolean(codexConfig),
    };
  }

  private logTurnStartSummary({
    turnId,
    thinkingOptionId,
    approvalPolicy,
    sandboxPolicyType,
    hasOutputSchema,
    hasDeveloperInstructions,
    hasCodexConfig,
  }: {
    turnId: string;
    thinkingOptionId?: string;
    approvalPolicy: string;
    sandboxPolicyType: string;
    hasOutputSchema: boolean;
    hasDeveloperInstructions: boolean;
    hasCodexConfig: boolean;
  }): void {
    this.logger.info(
      {
        turnId,
        threadId: this.currentThreadId,
        model: this.config.model ?? null,
        modeId: this.currentMode ?? null,
        effort: thinkingOptionId ?? null,
        serviceTier: this.serviceTier,
        cwd: this.config.cwd ?? null,
        approvalPolicy,
        sandboxPolicyType,
        hasCollaborationMode: Boolean(this.resolvedCollaborationMode),
        hasOutputSchema,
        hasDeveloperInstructions,
        hasCodexConfig,
      },
      "Starting Codex app-server turn",
    );
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    let currentAssistantMessageId: string | null = null;
    let currentAssistantMessageHasBoundary = false;
    let hasAssistantMessage = false;
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: async () => (await this.getRuntimeInfo()).sessionId ?? "",
      reduceFinalText: ({ current, item }) => {
        if (item.type === "assistant_message") {
          const hasPreviousAssistantMessage = hasAssistantMessage;
          hasAssistantMessage = true;
          const isNewMessage =
            item.messageId === undefined || item.messageId !== currentAssistantMessageId;
          if (isNewMessage) {
            currentAssistantMessageId = item.messageId ?? null;
            currentAssistantMessageHasBoundary =
              hasPreviousAssistantMessage &&
              item.text.startsWith(ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN);
          }
          const finalTextItem = currentAssistantMessageHasBoundary
            ? {
                ...item,
                text: item.text.startsWith(ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN)
                  ? item.text.slice(ASSISTANT_MESSAGE_BOUNDARY_MARKDOWN.length)
                  : item.text,
              }
            : item;
          return isNewMessage
            ? finalTextItem.text
            : appendOrReplaceGrowingAssistantMessage({ current, item: finalTextItem });
        }
        if (item.type === "tool_call" && item.detail.type === "plan") {
          currentAssistantMessageId = null;
          currentAssistantMessageHasBoundary = false;
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

    const turnStart = await this.buildTurnStartParams(effectivePrompt, options);

    const turnId = this.createTurnId();
    this.activeForegroundTurnId = turnId;

    try {
      this.logTurnStartSummary({
        turnId,
        thinkingOptionId: turnStart.thinkingOptionId,
        approvalPolicy: turnStart.approvalPolicy,
        sandboxPolicyType: turnStart.sandboxPolicyType,
        hasOutputSchema: turnStart.hasOutputSchema,
        hasDeveloperInstructions: turnStart.hasDeveloperInstructions,
        hasCodexConfig: turnStart.hasCodexConfig,
      });
      await this.client.request("turn/start", turnStart.params, TURN_START_TIMEOUT_MS);
    } catch (error) {
      this.activeForegroundTurnId = null;
      throw error;
    }

    return { turnId };
  }

  private rememberCodexUserMessageTurn(messageId: string | null | undefined): boolean {
    if (typeof messageId !== "string" || messageId.length === 0) {
      return false;
    }
    if (this.userMessageTurnIndexes.has(messageId)) {
      return false;
    }
    this.userMessageTurnIndexes.set(messageId, this.userMessageTurnIds.length);
    this.userMessageTurnIds.push(messageId);
    return true;
  }

  private resetCodexUserMessageTurns(): void {
    this.userMessageTurnIndexes.clear();
    this.userMessageTurnIds.length = 0;
  }

  private truncateCodexUserMessageTurns(numTurns: number): void {
    if (numTurns <= 0) {
      return;
    }
    this.userMessageTurnIds.length = Math.max(0, this.userMessageTurnIds.length - numTurns);
    this.userMessageTurnIndexes.clear();
    this.userMessageTurnIds.forEach((messageId, index) => {
      this.userMessageTurnIndexes.set(messageId, index);
    });
  }

  private codexUserMessageTurns(): CodexUserMessageTurnIndex {
    return {
      resolve: (messageId) => this.userMessageTurnIndexes.get(messageId) ?? null,
      count: () => this.userMessageTurnIds.length,
    };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    if (
      (!this.historyPending || this.persistedHistory.length === 0) &&
      this.persistedProviderSubagentEvents.length === 0
    ) {
      return;
    }
    const history = this.persistedHistory;
    const providerSubagents = this.persistedProviderSubagentEvents;
    this.persistedHistory = [];
    this.persistedProviderSubagentEvents = [];
    this.historyPending = false;
    for (const event of providerSubagents) {
      yield event;
    }
    for (const entry of history) {
      yield {
        type: "timeline",
        provider: CODEX_PROVIDER,
        item: entry.item,
        timestamp: entry.timestamp,
      };
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
    if (this.autoReviewEnabled) {
      return CODEX_MODES;
    }
    return CODEX_MODES.filter((mode) => mode.id !== "auto-review");
  }

  async getCurrentMode(): Promise<string | null> {
    return this.currentMode ?? null;
  }

  async setMode(modeId: string): Promise<void | AgentProviderNotice> {
    validateCodexMode(modeId);
    this.currentMode = modeId;
    this.cachedRuntimeInfo = null;
    if (this.activeForegroundTurnId) {
      return SETTING_APPLIES_NEXT_TURN_NOTICE;
    }
  }

  async setModel(modelId: string | null): Promise<void> {
    this.config.model = modelId ?? undefined;
    if (!codexModelSupportsFastMode(this.config.model)) {
      this.serviceTier = null;
    }
    this.refreshResolvedCollaborationMode();
    this.cachedRuntimeInfo = null;
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void | AgentProviderNotice> {
    this.config.thinkingOptionId = normalizeCodexThinkingOptionId(thinkingOptionId);
    this.refreshResolvedCollaborationMode();
    this.cachedRuntimeInfo = null;
    if (this.activeForegroundTurnId) {
      return SETTING_APPLIES_NEXT_TURN_NOTICE;
    }
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (featureId === "fast_mode") {
      if (Boolean(value) && !codexModelSupportsFastMode(this.config.model)) {
        throw new Error(
          `Codex fast mode is not available for model '${this.config.model ?? "default"}'`,
        );
      }
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

    if (pending.kind === "mcp_elicitation") {
      pending.resolve({
        action: resolvePermissionDecision(response),
        content: response.behavior === "allow" ? {} : null,
        _meta: null,
      });
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
      kind: "command" | "file" | "question" | "mcp_elicitation" | "plan";
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

  async revertConversation(input: { messageId: string }): Promise<void> {
    await this.connect();
    if (!this.client) {
      throw new Error("Codex client is not initialized");
    }
    if (this.currentThreadId) {
      await this.ensureThreadLoaded();
    } else {
      await this.ensureThread();
    }

    await revertCodexConversation({
      client: this.client,
      threadId: this.currentThreadId,
      messageId: input.messageId,
      cwd: this.config.cwd ?? null,
      model: this.config.model ?? null,
      serviceTier: this.serviceTier,
      userMessageTurns: this.codexUserMessageTurns(),
      setThreadId: async (threadId) => {
        this.currentThreadId = threadId;
        this.cachedRuntimeInfo = null;
        this.persistedHistory = [];
        this.historyPending = false;
        await this.loadPersistedHistory();
      },
    });
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
    this.pendingSubAgentNotificationsByThreadId.clear();
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
      kind: "skill" as const,
    }));
    const fallbackSkills =
      appServerSkills.length === 0
        ? await listCodexSkills(this.config.cwd, this.deps.workspaceGitService)
        : [];
    const builtin: AgentSlashCommand[] = [
      {
        name: "compact",
        description: "Summarize conversation to prevent hitting the context limit",
        argumentHint: "",
        kind: "command",
      },
    ];
    if (this.goalsEnabled) {
      builtin.push({
        name: "goal",
        description: "Set, pause, resume, or clear the agent's goal",
        argumentHint: "[<objective>|pause|resume|clear]",
        kind: "command",
      });
    }
    return [...builtin, ...appServerSkills, ...fallbackSkills, ...prompts].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  tryHandleOutOfBand(
    prompt: AgentPromptInput,
  ): { run(ctx: { emit: (event: AgentStreamEvent) => void }): Promise<void> } | null {
    if (typeof prompt !== "string") return null;
    const parsed = this.parseSlashCommandInput(prompt);
    if (!parsed) return null;

    if (parsed.commandName === "compact") {
      return {
        run: async ({ emit }) => {
          const error = await this.executeCompactCommand();
          if (error) {
            emit({
              type: "timeline",
              provider: CODEX_PROVIDER,
              item: { type: "assistant_message", text: formatOutOfBandStatusMessage(error) },
            });
          }
        },
      };
    }

    if (!this.goalsEnabled || parsed.commandName !== "goal") return null;

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

  private async executeCompactCommand(): Promise<string | null> {
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
      this.pendingManualCompactionStarts += 1;
      try {
        await this.client.request("thread/compact/start", {
          threadId: this.currentThreadId,
        });
      } catch (error) {
        this.pendingManualCompactionStarts = Math.max(0, this.pendingManualCompactionStarts - 1);
        throw error;
      }
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return `Failed to compact context: ${message}`;
    }
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
    const developerInstructions = composeSystemPromptParts(
      this.config.systemPrompt,
      this.config.daemonAppendSystemPrompt,
    );
    const params: Record<string, unknown> = {
      model,
      cwd: this.config.cwd ?? null,
      approvalPolicy,
      sandbox,
      ...(developerInstructions ? { developerInstructions } : {}),
      ...(innerConfig ? { config: innerConfig } : {}),
      ...(this.ephemeral ? { ephemeral: true } : {}),
    };
    applyApprovalsReviewerParam(params, preset);
    const rawResponse = await this.client.request("thread/start", params);
    const response = toObjectRecord(rawResponse);
    const threadRecord = toObjectRecord(response?.thread);
    const threadId = typeof threadRecord?.id === "string" ? threadRecord.id : undefined;
    if (!threadId) {
      throw new Error("Codex app-server did not return thread id");
    }
    const responseApprovalsReviewer =
      typeof response?.approvalsReviewer === "string" ? response.approvalsReviewer : undefined;
    if (
      shouldPromoteThreadResponseToAutoReview({
        approvalsReviewer: responseApprovalsReviewer,
        approvalPolicy,
        sandbox,
      })
    ) {
      this.currentMode = "auto-review";
      this.cachedRuntimeInfo = null;
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
    if (this.deps.customCodexConfig) {
      Object.assign(innerConfig, this.deps.customCodexConfig);
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
    if (this.loadingPersistedHistory && event.type === "provider_subagent") {
      this.persistedProviderSubagentEvents.push(event);
      return;
    }
    this.notifySubscribers(event);
  }

  private notifySubscribers(event: AgentStreamEvent): void {
    const turnId = this.activeForegroundTurnId;
    const tagged = turnId ? { ...event, turnId } : event;
    this.logger.trace(
      {
        agentId: this.agentId,
        provider: CODEX_PROVIDER,
        sessionId: this.currentThreadId,
        turnId: getAgentStreamEventTurnId(tagged),
        event: tagged,
      },
      "provider.codex.event_emit",
    );
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
    const notificationParams = toObjectRecord(params);
    if (method === "serverRequest/resolved" && typeof notificationParams?.requestId === "number") {
      const requestId = this.mcpElicitationPermissionIds.get(notificationParams.requestId);
      if (requestId) {
        const pending = this.pendingPermissionHandlers.get(requestId);
        this.mcpElicitationPermissionIds.delete(notificationParams.requestId);
        if (!pending) {
          return;
        }
        this.pendingPermissions.delete(requestId);
        this.pendingPermissionHandlers.delete(requestId);
        pending.resolve({ action: "cancel", content: null, _meta: null });
        this.emitEvent({
          type: "permission_resolved",
          provider: CODEX_PROVIDER,
          requestId,
          resolution: { behavior: "deny", interrupt: true },
        });
      }
      return;
    }
    const parsed = CodexNotificationSchema.parse({ method, params });
    this.traceParsedNotification(method, params, parsed);
    const route = this.resolveCodexThreadRoute(getCodexNotificationThreadId(parsed));
    if (route.kind === "pending_sub_agent") {
      this.bufferPendingSubAgentNotification(route.threadId, parsed);
      return;
    }
    if (route.kind === "sub_agent") {
      this.dispatchSubAgentNotification(parsed, route.callId);
      return;
    }
    this.dispatchParsedNotification(parsed);
  }

  private dispatchSubAgentNotification(parsed: ParsedCodexNotification, callId: string): void {
    switch (parsed.kind) {
      case "thread_started":
        this.emitSubAgentActivityUpdate(callId, "running");
        return;
      case "turn_started":
      case "turn_completed":
      case "agent_message_delta":
      case "reasoning_delta":
      case "item_started":
      case "item_completed":
        this.dispatchParsedNotification(parsed);
        return;
      case "exec_command_output_delta":
      case "file_change_output_delta":
        this.handleCodexDeltaNotification(parsed, callId);
        return;
      case "exec_command_started":
        this.handleExecCommandStartedNotification(parsed, callId);
        return;
      case "exec_command_completed":
        this.handleExecCommandCompletedNotification(parsed, callId);
        return;
      case "patch_apply_started":
        this.handlePatchApplyStartedNotification(parsed, callId);
        return;
      case "patch_apply_completed":
        this.handlePatchApplyCompletedNotification(parsed, callId);
        return;
      default:
        // Aggregate child telemetry is redundant and must not leak into the
        // root timeline. Concrete legacy tools are projected above for Codex
        // versions that do not also emit canonical item lifecycle events.
        return;
    }
  }

  private dispatchParsedNotification(parsed: ParsedCodexNotification): void {
    if (isCodexDeltaNotification(parsed)) {
      this.handleCodexDeltaNotification(parsed);
      return;
    }
    if (this.handleThreadStateNotification(parsed)) {
      return;
    }
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
      case "unknown_method":
        this.warnUnknownNotificationMethod(parsed.method, parsed.params);
        return;
      default:
        return;
    }
  }

  private resolveCodexThreadRoute(threadId: string | null): CodexThreadRoute {
    if (!threadId || !this.currentThreadId || threadId === this.currentThreadId) {
      return { kind: "root" };
    }
    const callId = this.subAgentCallIdByChildThreadId.get(threadId);
    return callId ? { kind: "sub_agent", callId } : { kind: "pending_sub_agent", threadId };
  }

  private bufferPendingSubAgentNotification(
    threadId: string,
    parsed: ParsedCodexNotification,
  ): void {
    let pending = this.pendingSubAgentNotificationsByThreadId.get(threadId);
    if (!pending) {
      if (this.pendingSubAgentNotificationsByThreadId.size >= MAX_PENDING_SUB_AGENT_THREADS) {
        const oldestThreadId = this.pendingSubAgentNotificationsByThreadId.keys().next().value;
        if (typeof oldestThreadId === "string") {
          this.pendingSubAgentNotificationsByThreadId.delete(oldestThreadId);
        }
      }
      pending = [];
      this.pendingSubAgentNotificationsByThreadId.set(threadId, pending);
    }
    if (pending.length >= MAX_PENDING_SUB_AGENT_NOTIFICATIONS_PER_THREAD) {
      pending.shift();
    }
    pending.push(parsed);
  }

  private replayPendingSubAgentNotifications(threadIds: readonly string[]): void {
    for (const threadId of threadIds) {
      const pending = this.pendingSubAgentNotificationsByThreadId.get(threadId);
      if (!pending) {
        continue;
      }
      this.pendingSubAgentNotificationsByThreadId.delete(threadId);
      const callId = this.subAgentCallIdByChildThreadId.get(threadId);
      if (!callId) {
        continue;
      }
      for (const parsed of pending) {
        this.dispatchSubAgentNotification(parsed, callId);
      }
    }
  }

  private handleThreadStateNotification(parsed: ParsedCodexNotification): boolean {
    switch (parsed.kind) {
      case "context_compacted":
        this.handleContextCompactedNotification(parsed);
        return true;
      case "thread_rolled_back":
        this.handleThreadRolledBackNotification(parsed);
        return true;
      default:
        return false;
    }
  }

  private traceParsedNotification(
    method: string,
    params: unknown,
    parsed: z.infer<typeof CodexNotificationSchema>,
  ): void {
    this.logger.trace(
      {
        agentId: this.agentId,
        provider: CODEX_PROVIDER,
        sessionId: this.currentThreadId,
        turnId: this.activeForegroundTurnId ?? undefined,
        method,
        params,
        parsed,
      },
      "provider.codex.parsed_event",
    );
  }

  private getSubAgentCallIdForThread(threadId: string | null | undefined): string | null {
    if (!threadId || threadId === this.currentThreadId) {
      return null;
    }
    return this.subAgentCallIdByChildThreadId.get(threadId) ?? null;
  }

  private registerSubAgentToolCall(params: {
    timelineItem: ToolCallTimelineItem;
    rawItem: { [key: string]: unknown };
    parentCallId: string | null;
  }): string[] {
    const { timelineItem, rawItem, parentCallId } = params;
    if (timelineItem.detail.type !== "sub_agent") {
      return [];
    }

    const existing = this.subAgentCallsByCallId.get(timelineItem.callId);
    const state: CodexSubAgentCallState =
      existing ??
      ({
        callId: timelineItem.callId,
        toolCall: timelineItem,
        parentCallId,
        activityItemIds: new Set<string>(),
        pendingCommandOutputDeltas: new Map<string, string[]>(),
        pendingFileChangeOutputDeltas: new Map<string, string[]>(),
        childItemOrder: [],
        childItems: new Map<string, AgentTimelineItem>(),
        childThreadIds: new Set<string>(),
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
    state.parentCallId ??= parentCallId;
    const activity = readCodexSubAgentActivity(rawItem);
    if (activity?.id) {
      state.activityItemIds.add(activity.id);
    }
    this.subAgentCallsByCallId.set(timelineItem.callId, state);

    const receiverThreadIds = Array.isArray(rawItem.receiverThreadIds)
      ? rawItem.receiverThreadIds.filter((value): value is string => typeof value === "string")
      : [];
    const agentThreadId =
      typeof rawItem.agentThreadId === "string" && rawItem.agentThreadId.length > 0
        ? rawItem.agentThreadId
        : null;
    const childThreadIds = Array.from(
      new Set(agentThreadId ? [...receiverThreadIds, agentThreadId] : receiverThreadIds),
    );
    for (const receiverThreadId of childThreadIds) {
      this.subAgentCallIdByChildThreadId.set(receiverThreadId, timelineItem.callId);
      state.childThreadIds.add(receiverThreadId);
      this.emitProviderSubagentUpsert(receiverThreadId, state, timelineItem.status);
    }
    return childThreadIds;
  }

  private handleRegisteredSubAgentActivity(rawItem: { [key: string]: unknown }): boolean {
    const activity = readCodexSubAgentActivity(rawItem);
    if (!activity) {
      return false;
    }
    const callId = this.subAgentCallIdByChildThreadId.get(activity.agentThreadId);
    if (!callId) {
      return false;
    }
    const state = this.subAgentCallsByCallId.get(callId);
    if (!state) {
      return false;
    }
    if (activity.id && state.activityItemIds.has(activity.id)) {
      return true;
    }
    if (activity.id) {
      state.activityItemIds.add(activity.id);
    }
    this.emitSubAgentActivityUpdate(
      callId,
      activity.kind === "interrupted" ? "canceled" : "running",
    );
    return true;
  }

  private handleCompletedContextCompactionItem(item: {
    id?: string;
    type?: string;
    [key: string]: unknown;
  }): boolean {
    if (!this.isContextCompactionItem(item)) {
      return false;
    }
    if (this.unpairedCompactionNotificationCompletions > 0) {
      this.unpairedCompactionNotificationCompletions -= 1;
      return true;
    }
    this.emitEvent({
      type: "timeline",
      provider: CODEX_PROVIDER,
      item: this.createContextCompactionTimelineItem("completed", item.id),
    });
    this.unpairedCompactionItemCompletions += 1;
    return true;
  }

  private handleCompletedSpecialItem(
    parsed: Extract<ParsedCodexNotification, { kind: "item_completed" }>,
    childSubAgentCallId: string | null,
  ): boolean {
    if (
      childSubAgentCallId &&
      this.handleSubAgentContextCompactionItem(childSubAgentCallId, parsed.item, "completed")
    ) {
      return true;
    }
    return (
      this.handleCompletedContextCompactionItem(parsed.item) ||
      this.handleRegisteredSubAgentActivity(parsed.item)
    );
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

  private emitCodexToolTimelineItem(
    timelineItem: ToolCallTimelineItem,
    subAgentCallId: string | null,
    childThreadId?: string | null,
  ): void {
    if (!subAgentCallId) {
      this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
      return;
    }
    this.upsertSubAgentChildItem(subAgentCallId, timelineItem.callId, timelineItem);
    const state = this.subAgentCallsByCallId.get(subAgentCallId);
    if (state) {
      const targetThreadIds = childThreadId ? [childThreadId] : state.childThreadIds;
      for (const targetThreadId of targetThreadIds) {
        this.emitProviderSubagentTimeline(targetThreadId, timelineItem);
      }
    }
    this.emitSubAgentActivityUpdate(
      subAgentCallId,
      timelineItem.status === "running" ? "running" : undefined,
    );
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
    for (const childThreadId of state.childThreadIds) {
      this.emitProviderSubagentUpsert(childThreadId, state, resolvedStatus);
    }
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
    if (state.parentCallId && state.parentCallId !== callId) {
      this.upsertSubAgentChildItem(state.parentCallId, state.callId, nextToolCall);
      this.emitSubAgentActivityUpdate(state.parentCallId);
      return;
    }
    this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: nextToolCall });
  }

  private emitProviderSubagentUpsert(
    childThreadId: string,
    state: CodexSubAgentCallState,
    status: ToolCallTimelineItem["status"],
  ): void {
    const detail = state.toolCall.detail;
    if (detail.type !== "sub_agent") {
      return;
    }
    let providerStatus: "running" | "completed" | "failed" | "canceled" = "running";
    if (status === "completed") {
      providerStatus = "completed";
    } else if (status === "failed") {
      providerStatus = "failed";
    } else if (status === "canceled") {
      providerStatus = "canceled";
    }
    this.emitEvent({
      type: "provider_subagent",
      provider: CODEX_PROVIDER,
      event: {
        type: "upsert",
        id: childThreadId,
        title: detail.subAgentType ?? "Codex subagent",
        description: detail.description ?? null,
        status: providerStatus,
        toolCallId: state.callId,
      },
    });
  }

  private emitProviderSubagentTimeline(
    childThreadId: string,
    item: AgentTimelineItem,
    timestamp?: string,
  ): void {
    this.emitEvent({
      type: "provider_subagent",
      provider: CODEX_PROVIDER,
      event: {
        type: "timeline",
        id: childThreadId,
        item,
        ...(timestamp ? { timestamp } : {}),
      },
    });
  }

  private emitCompletedProviderSubagentItem(
    parsed: Extract<ParsedCodexNotification, { kind: "item_completed" }>,
    timelineItem: AgentTimelineItem,
  ): void {
    const itemId = parsed.item.id;
    if (!parsed.threadId) return;
    if (timelineItem.type === "assistant_message" && itemId) {
      const streamedText = this.pendingAgentMessages.get(itemId);
      if (streamedText !== undefined) {
        const suffix = this.buildMissingFinalTextSuffix(timelineItem, streamedText);
        if (suffix) this.emitProviderSubagentTimeline(parsed.threadId, suffix);
        return;
      }
    }
    if (timelineItem.type === "reasoning" && itemId) {
      const streamedText = this.pendingReasoning.get(itemId)?.join("");
      if (streamedText !== undefined) {
        const suffix = this.buildMissingFinalTextSuffix(timelineItem, streamedText);
        if (suffix) this.emitProviderSubagentTimeline(parsed.threadId, suffix);
        return;
      }
    }
    this.emitProviderSubagentTimeline(parsed.threadId, timelineItem);
  }

  private emitStartedProviderSubagentItem(
    threadId: string | null,
    timelineItem: AgentTimelineItem,
  ): void {
    if (threadId) {
      this.emitProviderSubagentTimeline(threadId, timelineItem);
    }
  }

  private emitProviderSubagentTimelineItems(
    threadId: string | null,
    timelineItems: readonly AgentTimelineItem[],
  ): void {
    if (!threadId) {
      return;
    }
    for (const timelineItem of timelineItems) {
      this.emitProviderSubagentTimeline(threadId, timelineItem);
    }
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
    this.emitSubAgentActivityUpdate(callId, "running");
  }

  private handleSubAgentContextCompactionItem(
    callId: string,
    item: { id?: string; type?: string; [key: string]: unknown },
    status: "loading" | "completed",
  ): boolean {
    if (!this.isContextCompactionItem(item)) {
      return false;
    }
    if (item.id) {
      this.upsertSubAgentChildItem(callId, item.id, { type: "compaction", status });
    }
    this.emitSubAgentActivityUpdate(callId);
    return true;
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
    parsed: CodexDeltaNotification,
    routedSubAgentCallId: string | null = null,
  ): void {
    if (parsed.kind === "agent_message_delta") {
      const prev = this.pendingAgentMessages.get(parsed.itemId) ?? "";
      const text = prev + parsed.delta;
      this.pendingAgentMessages.set(parsed.itemId, text);
      const subAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
      if (subAgentCallId) {
        if (parsed.threadId) {
          this.emitProviderSubagentTimeline(parsed.threadId, {
            type: "assistant_message",
            messageId: parsed.itemId,
            text: parsed.delta,
          });
        }
        this.upsertSubAgentChildItem(subAgentCallId, parsed.itemId, {
          type: "assistant_message",
          messageId: parsed.itemId,
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
          messageId: parsed.itemId,
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
        if (parsed.threadId) {
          this.emitProviderSubagentTimeline(parsed.threadId, {
            type: "reasoning",
            text: parsed.delta,
          });
        }
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
      const outputDeltas = routedSubAgentCallId
        ? this.subAgentCallsByCallId.get(routedSubAgentCallId)?.pendingCommandOutputDeltas
        : this.pendingCommandOutputDeltas;
      if (!outputDeltas) {
        return;
      }
      this.appendOutputDeltaChunk(outputDeltas, parsed.callId, parsed.chunk, {
        decodeBase64: true,
      });
      return;
    }
    const outputDeltas = routedSubAgentCallId
      ? this.subAgentCallsByCallId.get(routedSubAgentCallId)?.pendingFileChangeOutputDeltas
      : this.pendingFileChangeOutputDeltas;
    if (outputDeltas) {
      this.appendOutputDeltaChunk(outputDeltas, parsed.itemId, parsed.delta);
    }
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
    this.pendingSubAgentNotificationsByThreadId.clear();
    this.resetTurnTrackingState();
  }

  private resetTurnTrackingState(): void {
    this.latestPlanResult = null;
    this.emittedItemStartedIds.clear();
    this.emittedItemCompletedIds.clear();
    this.emittedProviderSubagentUserMessageKeys.clear();
    this.emittedExecCommandStartedCallIds.clear();
    this.emittedExecCommandCompletedCallIds.clear();
    this.pendingAgentMessages.clear();
    this.pendingReasoning.clear();
    this.pendingCommandOutputDeltas.clear();
    this.pendingFileChangeOutputDeltas.clear();
    this.pendingAssistantMessageBoundary = false;
    this.warnedIncompleteEditToolCallIds.clear();
    this.unpairedCompactionNotificationCompletions = 0;
    this.unpairedCompactionItemCompletions = 0;
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

  private resolveContextCompactionTrigger(itemId?: string): "auto" | "manual" | undefined {
    if (itemId) {
      const known = this.compactionTriggerByItemId.get(itemId);
      if (known) {
        return known;
      }
    }
    if (this.pendingManualCompactionStarts > 0) {
      this.pendingManualCompactionStarts -= 1;
      return "manual";
    }
    return undefined;
  }

  private createContextCompactionTimelineItem(
    status: "loading" | "completed",
    itemId?: string,
  ): Extract<AgentTimelineItem, { type: "compaction" }> {
    const trigger = this.resolveContextCompactionTrigger(itemId);
    if (itemId && trigger) {
      if (status === "loading") {
        this.compactionTriggerByItemId.set(itemId, trigger);
      } else {
        this.compactionTriggerByItemId.delete(itemId);
      }
    }
    return {
      type: "compaction",
      status,
      ...(trigger ? { trigger } : {}),
    };
  }

  private isContextCompactionItem(item: { type?: string; [key: string]: unknown }): boolean {
    return (
      normalizeCodexThreadItemType(typeof item.type === "string" ? item.type : undefined) ===
      CODEX_CONTEXT_COMPACTION_TYPE
    );
  }

  private isUserMessageItem(item: { type?: string; [key: string]: unknown }): boolean {
    return (
      normalizeCodexThreadItemType(typeof item.type === "string" ? item.type : undefined) ===
      "userMessage"
    );
  }

  private handleThreadRolledBackNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "thread_rolled_back" }>,
  ): void {
    this.truncateCodexUserMessageTurns(parsed.numTurns);
  }

  private handleContextCompactedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "context_compacted" }>,
  ): void {
    if (parsed.threadId !== this.currentThreadId) {
      return;
    }
    if (this.unpairedCompactionItemCompletions > 0) {
      this.unpairedCompactionItemCompletions -= 1;
      return;
    }
    this.unpairedCompactionNotificationCompletions += 1;
    this.emitEvent({
      type: "timeline",
      provider: CODEX_PROVIDER,
      item: this.createContextCompactionTimelineItem("completed"),
      ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
    });
  }

  private handleExecCommandStartedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "exec_command_started" }>,
    subAgentCallId: string | null = null,
  ): void {
    const outputDeltas = subAgentCallId
      ? this.subAgentCallsByCallId.get(subAgentCallId)?.pendingCommandOutputDeltas
      : this.pendingCommandOutputDeltas;
    if (!outputDeltas) {
      return;
    }
    if (parsed.callId && !subAgentCallId) {
      this.emittedExecCommandStartedCallIds.add(parsed.callId);
    }
    if (parsed.callId) {
      outputDeltas.delete(parsed.callId);
    }
    const timelineItem = mapCodexExecNotificationToToolCall({
      callId: parsed.callId,
      command: parsed.command,
      cwd: parsed.cwd ?? this.config.cwd ?? null,
      running: true,
    });
    if (timelineItem) {
      this.emitCodexToolTimelineItem(timelineItem, subAgentCallId, parsed.threadId);
    }
  }

  private handleExecCommandCompletedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "exec_command_completed" }>,
    subAgentCallId: string | null = null,
  ): void {
    const outputDeltas = subAgentCallId
      ? this.subAgentCallsByCallId.get(subAgentCallId)?.pendingCommandOutputDeltas
      : this.pendingCommandOutputDeltas;
    if (!outputDeltas) {
      return;
    }
    const bufferedOutput = this.consumeOutputDelta(outputDeltas, parsed.callId);
    const resolvedOutput = parsed.output ?? bufferedOutput;
    if (!subAgentCallId) {
      this.rememberTerminalProcessForCommand(parsed.command, resolvedOutput);
    }
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
      if (!subAgentCallId) {
        this.emittedExecCommandCompletedCallIds.add(timelineItem.callId);
      }
      this.emitCodexToolTimelineItem(timelineItem, subAgentCallId, parsed.threadId);
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
    const callId = this.createTerminalInteractionCallId(parsed.processId, parsed.callId);
    if (!command && parsed.processId) {
      const pendingInteractions =
        this.pendingUnlabeledTerminalInteractions.get(parsed.processId) ?? [];
      pendingInteractions.push({ callId, stdin: parsed.stdin });
      this.pendingUnlabeledTerminalInteractions.set(parsed.processId, pendingInteractions);
    }
    const timelineItem = mapCodexTerminalInteractionToToolCall({
      callId,
      processId: parsed.processId,
      command,
      stdin: parsed.stdin,
    });
    this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
  }

  private handlePatchApplyStartedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "patch_apply_started" }>,
    subAgentCallId: string | null = null,
  ): void {
    const outputDeltas = subAgentCallId
      ? this.subAgentCallsByCallId.get(subAgentCallId)?.pendingFileChangeOutputDeltas
      : this.pendingFileChangeOutputDeltas;
    if (!outputDeltas) {
      return;
    }
    if (parsed.callId) {
      outputDeltas.delete(parsed.callId);
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
      this.emitCodexToolTimelineItem(timelineItem, subAgentCallId, parsed.threadId);
    }
  }

  private handlePatchApplyCompletedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "patch_apply_completed" }>,
    subAgentCallId: string | null = null,
  ): void {
    const outputDeltas = subAgentCallId
      ? this.subAgentCallsByCallId.get(subAgentCallId)?.pendingFileChangeOutputDeltas
      : this.pendingFileChangeOutputDeltas;
    if (!outputDeltas) {
      return;
    }
    const bufferedOutput = this.consumeOutputDelta(outputDeltas, parsed.callId);
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
      this.emitCodexToolTimelineItem(timelineItem, subAgentCallId, parsed.threadId);
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
    if (this.isUserMessageItem(parsed.item)) {
      this.handleUserMessageItem(parsed);
      return;
    }
    const childSubAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
    if (this.handleCompletedSpecialItem(parsed, childSubAgentCallId)) {
      return;
    }
    const timelineItem = threadItemToTimeline(parsed.item, {
      includeUserMessage: false,
      cwd: this.config.cwd ?? null,
    });
    if (!timelineItem) {
      return;
    }
    const registeredChildThreadIds =
      timelineItem.type === "tool_call"
        ? this.registerSubAgentToolCall({
            timelineItem,
            rawItem: parsed.item,
            parentCallId: childSubAgentCallId,
          })
        : [];
    const imageItems = mcpToolResultImagesToTimeline(parsed.item);
    if (childSubAgentCallId) {
      this.emitCompletedProviderSubagentItem(parsed, timelineItem);
      this.handleSubAgentChildItemCompleted(childSubAgentCallId, parsed.item.id, timelineItem);
      this.emitProviderSubagentTimelineItems(parsed.threadId, imageItems);
      this.replayPendingSubAgentNotifications(registeredChildThreadIds);
      return;
    }
    const normalizedItemType = normalizeCodexThreadItemType(
      typeof parsed.item.type === "string" ? parsed.item.type : undefined,
    );
    const itemId = parsed.item.id;
    if (this.shouldSkipCompletedThreadItem(timelineItem, normalizedItemType, itemId)) {
      this.replayPendingSubAgentNotifications(registeredChildThreadIds);
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
      this.replayPendingSubAgentNotifications(registeredChildThreadIds);
      return;
    }
    this.applyBufferedDeltaTextToTimelineItem(timelineItem, itemId);
    if (timelineItem.type === "tool_call") {
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
    for (const imageItem of imageItems) {
      this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: imageItem });
      this.pendingAssistantMessageBoundary = true;
    }
    if (itemId) {
      this.emittedItemCompletedIds.add(itemId);
      this.emittedItemStartedIds.delete(itemId);
      this.pendingCommandOutputDeltas.delete(itemId);
      this.pendingFileChangeOutputDeltas.delete(itemId);
    }
    this.replayPendingSubAgentNotifications(registeredChildThreadIds);
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
    const item = this.buildMissingFinalTextSuffix(timelineItem, streamedText);
    if (item) this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item });
  }

  private buildMissingFinalTextSuffix(
    timelineItem: Extract<AgentTimelineItem, { type: "assistant_message" | "reasoning" }>,
    streamedText: string,
  ): AgentTimelineItem | null {
    if (!timelineItem.text.startsWith(streamedText)) return timelineItem;
    const suffix = timelineItem.text.slice(streamedText.length);
    if (!suffix) return null;
    return timelineItem.type === "assistant_message"
      ? {
          type: timelineItem.type,
          text: suffix,
          ...(timelineItem.messageId ? { messageId: timelineItem.messageId } : {}),
        }
      : { type: timelineItem.type, text: suffix };
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
        if (!timelineItem.text.startsWith(buffered)) timelineItem.text = buffered;
      }
      return;
    }
    if (timelineItem.type === "reasoning") {
      const buffered = this.pendingReasoning.get(itemId);
      if (buffered && buffered.length > 0) {
        const streamedText = buffered.join("");
        if (!timelineItem.text.startsWith(streamedText)) timelineItem.text = streamedText;
      }
    }
  }

  private handleItemStartedNotification(
    parsed: Extract<ParsedCodexNotification, { kind: "item_started" }>,
  ): void {
    if (parsed.source === "codex_event") {
      return;
    }
    if (this.isUserMessageItem(parsed.item)) {
      this.handleUserMessageItem(parsed);
      return;
    }
    const childSubAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
    if (
      childSubAgentCallId &&
      this.handleSubAgentContextCompactionItem(childSubAgentCallId, parsed.item, "loading")
    ) {
      return;
    }
    if (this.isContextCompactionItem(parsed.item)) {
      this.emitEvent({
        type: "timeline",
        provider: CODEX_PROVIDER,
        item: this.createContextCompactionTimelineItem("loading", parsed.item.id),
      });
      return;
    }
    if (this.handleRegisteredSubAgentActivity(parsed.item)) {
      return;
    }
    const timelineItem = threadItemToTimeline(parsed.item, {
      includeUserMessage: false,
      cwd: this.config.cwd ?? null,
    });
    if (!timelineItem || timelineItem.type !== "tool_call") {
      return;
    }
    const registeredChildThreadIds = this.registerSubAgentToolCall({
      timelineItem,
      rawItem: parsed.item,
      parentCallId: childSubAgentCallId,
    });
    if (childSubAgentCallId) {
      this.emitStartedProviderSubagentItem(parsed.threadId, timelineItem);
      if (parsed.item.id) {
        this.upsertSubAgentChildItem(childSubAgentCallId, parsed.item.id, timelineItem);
      }
      this.emitSubAgentActivityUpdate(childSubAgentCallId, "running");
      this.replayPendingSubAgentNotifications(registeredChildThreadIds);
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
    this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
    if (itemId) {
      this.emittedItemStartedIds.add(itemId);
      this.pendingCommandOutputDeltas.delete(itemId);
      this.pendingFileChangeOutputDeltas.delete(itemId);
    }
    this.replayPendingSubAgentNotifications(registeredChildThreadIds);
  }

  private handleUserMessageItem(
    parsed: Extract<ParsedCodexNotification, { kind: "item_started" | "item_completed" }>,
  ): void {
    const itemId = parsed.item.id;
    const timelineItem = threadItemToTimeline(parsed.item, {
      includeUserMessage: true,
      cwd: this.config.cwd ?? null,
    });
    if (!timelineItem || timelineItem.type !== "user_message") {
      return;
    }
    const childSubAgentCallId = this.getSubAgentCallIdForThread(parsed.threadId);
    if (childSubAgentCallId) {
      const childMessageId = itemId ?? timelineItem.messageId;
      if (!childMessageId) {
        return;
      }
      const childMessageKey = `${parsed.threadId ?? childSubAgentCallId}:${childMessageId}`;
      if (this.emittedProviderSubagentUserMessageKeys.has(childMessageKey)) {
        return;
      }
      this.emittedProviderSubagentUserMessageKeys.add(childMessageKey);
      if (parsed.threadId) {
        this.emitProviderSubagentTimeline(parsed.threadId, timelineItem);
      }
      if (itemId) {
        this.upsertSubAgentChildItem(childSubAgentCallId, itemId, timelineItem);
      }
      this.emitSubAgentActivityUpdate(childSubAgentCallId, "running");
      return;
    }
    if (!this.rememberCodexUserMessageTurn(timelineItem.messageId)) {
      return;
    }
    this.emitEvent({ type: "timeline", provider: CODEX_PROVIDER, item: timelineItem });
  }

  private warnUnknownNotificationMethod(method: string, params: unknown): void {
    if (this.warnedUnknownNotificationMethods.has(method)) {
      return;
    }
    this.warnedUnknownNotificationMethods.add(method);
    this.logger.trace(
      {
        agentId: this.agentId,
        provider: CODEX_PROVIDER,
        sessionId: this.currentThreadId,
        turnId: this.activeForegroundTurnId ?? undefined,
        method,
        params,
      },
      "provider.codex.event_unhandled",
    );
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
    const pendingInteractions = this.pendingUnlabeledTerminalInteractions.get(processId) ?? [];
    this.pendingUnlabeledTerminalInteractions.delete(processId);
    for (const pendingInteraction of pendingInteractions) {
      this.emitEvent({
        type: "timeline",
        provider: CODEX_PROVIDER,
        item: mapCodexTerminalInteractionToToolCall({
          callId: pendingInteraction.callId,
          processId,
          command: displayCommand,
          stdin: pendingInteraction.stdin,
        }),
      });
    }
  }

  private createTerminalInteractionCallId(
    processId: string | null,
    fallbackCallId: string | null,
  ): string {
    const baseCallId = processId
      ? `terminal-session-${processId}`
      : (nonEmptyString(fallbackCallId ?? undefined) ?? "terminal-interaction");
    this.nextTerminalInteractionOrdinal += 1;
    return `${baseCallId}-${this.nextTerminalInteractionOrdinal}`;
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

  private handleMcpElicitationRequest(params: unknown, serverRequestId: number): Promise<unknown> {
    const parsed = z
      .object({
        threadId: z.string(),
        turnId: z.string().nullable().optional(),
        serverName: z.string(),
        mode: z.enum(["form", "openai/form", "url"]),
        message: z.string(),
        requestedSchema: z.unknown().optional(),
        url: z.string().optional(),
        elicitationId: z.string().optional(),
      })
      .parse(params);
    if (parsed.mode === "url") {
      return Promise.resolve({ action: "decline", content: null, _meta: null });
    }
    const requiredFields = toObjectRecord(parsed.requestedSchema)?.required;
    if (Array.isArray(requiredFields) && requiredFields.length > 0) {
      return Promise.resolve({ action: "decline", content: null, _meta: null });
    }
    const requestId = `permission-${randomUUID()}`;
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: CODEX_PROVIDER,
      name: "CodexMcpElicitation",
      kind: "tool",
      title: `MCP approval: ${parsed.serverName}`,
      description: parsed.message,
      input: {
        mode: parsed.mode,
        requestedSchema: parsed.requestedSchema ?? null,
        url: parsed.url ?? null,
      },
      metadata: {
        threadId: parsed.threadId,
        turnId: parsed.turnId ?? null,
        serverName: parsed.serverName,
        elicitationId: parsed.elicitationId ?? null,
      },
    };
    this.pendingPermissions.set(requestId, request);
    this.mcpElicitationPermissionIds.set(serverRequestId, requestId);
    this.emitEvent({ type: "permission_requested", provider: CODEX_PROVIDER, request });
    return new Promise((resolve) => {
      this.pendingPermissionHandlers.set(requestId, { resolve, kind: "mcp_elicitation" });
    });
  }
}

export class CodexAppServerAgentClient implements AgentClient {
  readonly provider = CODEX_PROVIDER;
  readonly capabilities = CODEX_APP_SERVER_CAPABILITIES;
  private goalsEnabledPromise: Promise<boolean> | null = null;
  private autoReviewEnabledPromise: Promise<boolean> | null = null;

  constructor(
    private readonly logger: Logger,
    private readonly runtimeSettings?: ProviderRuntimeSettings,
    private readonly deps: CodexAppServerAgentDeps = {},
  ) {}

  private sessionDeps(): CodexAppServerAgentDeps {
    return {
      ...this.deps,
      customCodexConfig: buildCodexCustomProviderConfig(
        this.runtimeSettings,
        this.deps.customProvider,
      ),
    };
  }

  private resolveGoalsEnabled(): Promise<boolean> {
    if (!this.goalsEnabledPromise) {
      this.goalsEnabledPromise = (async () => {
        try {
          const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
          const versionOutput = await resolveBinaryVersion(launchPrefix.command);
          const enabled = codexVersionAtLeast(versionOutput, CODEX_GOALS_MIN_VERSION);
          this.logger.trace(
            {
              provider: CODEX_PROVIDER,
              versionOutput,
              enabled,
            },
            "provider.codex.config.goals_resolved",
          );
          return enabled;
        } catch (error) {
          this.logger.warn({ err: error }, "Failed to probe codex version for goals gate");
          return false;
        }
      })();
    }
    return this.goalsEnabledPromise;
  }

  private resolveAutoReviewEnabled(): Promise<boolean> {
    if (!this.autoReviewEnabledPromise) {
      this.autoReviewEnabledPromise = (async () => {
        try {
          const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
          const versionOutput = await resolveBinaryVersion(launchPrefix.command);
          const enabled = codexVersionAtLeast(versionOutput, CODEX_AUTO_REVIEW_MIN_VERSION);
          this.logger.trace(
            {
              provider: CODEX_PROVIDER,
              versionOutput,
              enabled,
            },
            "provider.codex.config.auto_review_resolved",
          );
          return enabled;
        } catch (error) {
          this.logger.warn({ err: error }, "Failed to probe codex version for auto-review gate");
          return false;
        }
      })();
    }
    return this.autoReviewEnabledPromise;
  }

  private async spawnAppServer(
    launchEnv?: Record<string, string>,
    options?: { goalsEnabled?: boolean; agentId?: string },
  ): Promise<ChildProcessWithoutNullStreams> {
    const launchPrefix = await resolveCodexLaunchPrefix(this.runtimeSettings);
    const args = [...launchPrefix.args, "app-server"];
    if (options?.goalsEnabled) {
      args.push("--enable", "goals");
    }
    this.logger.trace(
      {
        agentId: options?.agentId,
        provider: CODEX_PROVIDER,
        launchPrefix,
        goalsEnabled: options?.goalsEnabled === true,
      },
      "provider.codex.spawn",
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
    const autoReviewEnabled = await this.resolveAutoReviewEnabled();
    const session = new CodexAppServerAgentSession(
      sessionConfig,
      null,
      this.logger,
      () =>
        this.spawnAppServer(launchContext?.env, { goalsEnabled, agentId: launchContext?.agentId }),
      this.sessionDeps(),
      options?.persistSession === false,
      goalsEnabled,
      autoReviewEnabled,
      launchContext?.agentId,
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
    const autoReviewEnabled = await this.resolveAutoReviewEnabled();
    const session = new CodexAppServerAgentSession(
      merged,
      handle,
      this.logger,
      () =>
        this.spawnAppServer(launchContext?.env, { goalsEnabled, agentId: launchContext?.agentId }),
      this.sessionDeps(),
      false,
      goalsEnabled,
      autoReviewEnabled,
      launchContext?.agentId,
    );
    await session.connect();
    return session;
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    const child = await this.spawnAppServer();
    const client =
      this.deps._createCodexClient?.(child, this.logger, () => ({})) ??
      new CodexAppServerClient(child, this.logger);

    try {
      await client.request("initialize", buildCodexAppServerInitializeParams());
      client.notify("initialized", {});

      const limit = options?.limit ?? 20;
      // thread/list returns the cheap `cwd` field. Fetch a wider window when
      // filtering since most threads will be from other cwds, then keep the
      // local realpath-aware filter for symlink-equivalent workspace paths.
      const listLimit = options?.cwd ? Math.max(limit, 50) : limit;
      const response = toObjectRecord(
        await client.request("thread/list", {
          limit: listLimit,
          ...(options?.cwd ? { cwd: options.cwd } : {}),
        }),
      );
      const allThreads = Array.isArray(response?.data) ? response.data.filter(isRecord) : [];
      const threads = filterCodexThreadsByCwd(allThreads, options?.cwd);
      return threads.slice(0, limit).map((thread) => {
        const threadId = typeof thread.id === "string" ? thread.id : "";
        const cwd = typeof thread.cwd === "string" ? thread.cwd : process.cwd();
        const preview = typeof thread.preview === "string" ? thread.preview : null;
        const title = typeof thread.name === "string" && thread.name.trim() ? thread.name : preview;

        return {
          providerHandleId: threadId,
          cwd,
          title,
          firstPromptPreview: preview,
          lastPromptPreview: preview,
          lastActivityAt: new Date(
            ((typeof thread.updatedAt === "number" ? thread.updatedAt : undefined) ??
              (typeof thread.createdAt === "number" ? thread.createdAt : undefined) ??
              0) * 1000,
          ),
        };
      });
    } finally {
      await client.dispose();
    }
  }

  async importSession(input: ImportProviderSessionInput, context: ImportProviderSessionContext) {
    return importSessionFromPersistence({
      provider: CODEX_PROVIDER,
      request: input,
      context,
      resumeSession: this.resumeSession.bind(this),
    });
  }

  async fetchCatalog(_options: FetchCatalogOptions): Promise<ProviderCatalog> {
    const models = await this.fetchModelsFromAppServer();
    return { models, modes: CODEX_MODES };
  }

  private async fetchModelsFromAppServer(): Promise<AgentModelDefinition[]> {
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

  async unarchiveNativeSession(handle: AgentPersistenceHandle): Promise<void> {
    const threadId = handle.nativeHandle ?? handle.sessionId;
    if (!threadId) return;

    const child = await this.spawnAppServer();
    const client = new CodexAppServerClient(child, this.logger);

    try {
      await client.request("initialize", buildCodexAppServerInitializeParams());
      client.notify("initialized", {});
      try {
        await client.request("thread/unarchive", { threadId });
      } catch (error) {
        if (!isCodexAlreadyUnarchivedError(error, threadId)) {
          throw error;
        }
        try {
          await client.request("thread/read", { threadId });
        } catch {
          throw error;
        }
      }
    } finally {
      await client.dispose();
    }
  }

  async isAvailable(): Promise<boolean> {
    const launch = await resolveCodexLaunch(this.runtimeSettings);
    const availability = await checkCodexLaunchAvailable(launch);
    return availability.available;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveCodexLaunch(this.runtimeSettings);
      const availability = await checkCodexLaunchAvailable(launch);
      const entries: Array<{ label: string; value: string }> = [
        ...(await buildCommandResolutionDiagnosticRows(launch, {
          knownBinaryNames: ["codex"],
        })),
        ...(await buildBinaryDiagnosticRows(launch, availability)),
      ];

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
