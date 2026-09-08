import type { JsonValue } from "@getpaseo/protocol/agent-types";
import { z } from "zod";

export const PROVIDER_PROTOCOL_VERSION = 1 as const;

export const PROVIDER_CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "prompt.image",
  "prompt.output_schema",
  "prompt.steer",
  "session.archive",
  "session.configure",
  "session.list",
  "session.persistence",
  "session.revert.both",
  "session.revert.conversation",
  "session.revert.files",
  "session.subsession",
  "session.unarchive",
  "permission",
  "permission.tool_policy",
  "timeline.plugin",
] as const;

export type ProviderCapability = (typeof PROVIDER_CAPABILITIES)[number];

export interface ProviderRegistration {
  /** Equal keys share discovery within this provider. Include effective configuration and execution environment. */
  getCatalogCacheKey?(options: ProviderCatalogOptions): Promise<string | undefined>;
  id: string;
  label: string;
  description?: string;
  /** Plugin-directory-relative path to a self-contained SVG file. */
  icon?: string;
  connect(request: ProviderConnectRequest): Promise<ProviderConnection>;
}

export type ProviderCatalogOptions =
  | { scope: "global"; force?: boolean }
  | { scope: "workspace"; cwd: string; force?: boolean };

export interface ProviderConnectRequest {
  versions: readonly number[];
  capabilities: readonly string[];
}

export interface ProviderConnection {
  readonly version: number;
  readonly capabilities: readonly string[];
  send(input: ProviderInput): Promise<void>;
  onEvent(listener: (event: ProviderEvent) => void): () => void;
  close(): Promise<void>;
}

export interface ProviderPersistence {
  version: number;
  data: JsonValue;
}

export type ProviderMcpServerConfig =
  | {
      type: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      alwaysLoad?: boolean;
    }
  | {
      type: "http" | "sse";
      url: string;
      headers?: Record<string, string>;
      alwaysLoad?: boolean;
    };

export interface ProviderToolPolicy {
  preapproved: Array<{ kind: "mcp"; server: string; tool: string }>;
}

export interface ProviderSessionConfig {
  cwd: string;
  env: Readonly<Record<string, string>>;
  systemPrompt?: string;
  mcpServers: Readonly<Record<string, ProviderMcpServerConfig>>;
  toolPolicy?: ProviderToolPolicy;
  model?: string;
  mode?: string;
  thinkingOption?: string;
  settings: Readonly<Record<string, JsonValue>>;
  providerOptions?: Readonly<Record<string, JsonValue>>;
  title?: string;
  persist: boolean;
}

export interface ProviderConfigChanges {
  model?: string | null;
  mode?: string | null;
  thinkingOption?: string | null;
  settings?: Readonly<Record<string, JsonValue>>;
}

export interface ProviderPrompt {
  clientMessageId: string;
  delivery: "auto" | "steer";
  input:
    | { type: "message"; content: ProviderContent[] }
    | { type: "command"; name: string; arguments: string };
  outputSchema?: JsonValue;
  clearPendingPermissions?: boolean;
}

interface ProviderForgeChangeRequestAttachment {
  type: "forge_change_request";
  mimeType: "application/paseo-forge-change-request";
  forge?: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
  baseRefName?: string | null;
  headRefName?: string | null;
}

interface ProviderForgeIssueAttachment {
  type: "forge_issue";
  mimeType: "application/paseo-forge-issue";
  forge?: string;
  number: number;
  title: string;
  url: string;
  body?: string | null;
  projectPath?: string;
}

interface ProviderGitHubPrAttachment {
  type: "github_pr";
  mimeType: "application/github-pr";
  number: number;
  title: string;
  url: string;
  body?: string | null;
  baseRefName?: string | null;
  headRefName?: string | null;
}

interface ProviderGitHubIssueAttachment {
  type: "github_issue";
  mimeType: "application/github-issue";
  number: number;
  title: string;
  url: string;
  body?: string | null;
}

interface ProviderTextAttachment {
  type: "text";
  mimeType: "text/plain";
  contextKind?: string;
  title?: string | null;
  text: string;
  externalResource?: {
    provider: string;
    providerLabel: string;
    resourceType: string;
    id: string;
    identifier: string;
    title: string;
    url: string;
  };
}

interface ProviderReviewAttachment {
  type: "review";
  mimeType: "application/paseo-review";
  cwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string | null;
  comments: Array<{
    filePath: string;
    side: "old" | "new";
    lineNumber: number;
    body: string;
    context: {
      hunkHeader: string;
      targetLine: ProviderReviewContextLine;
      lines: ProviderReviewContextLine[];
    };
  }>;
}

interface ProviderReviewContextLine {
  oldLineNumber: number | null;
  newLineNumber: number | null;
  type: "add" | "remove" | "context";
  content: string;
}

export type ProviderContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | ProviderForgeChangeRequestAttachment
  | ProviderForgeIssueAttachment
  | ProviderGitHubPrAttachment
  | ProviderGitHubIssueAttachment
  | ProviderTextAttachment
  | ProviderReviewAttachment
  | {
      type: "uploaded_file";
      id: string;
      fileName: string;
      mimeType: string;
      size: number;
      path: string;
    };

export type ProviderInput =
  | { type: "catalog"; requestId: string; cwd?: string }
  | { type: "sessions"; requestId: string; query?: string; cwd?: string; limit?: number }
  | {
      type: "session.open";
      requestId: string;
      sessionId: string;
      config: ProviderSessionConfig;
      persistence?: ProviderPersistence;
      history: "replay" | "skip";
    }
  | { type: "session.prompt"; sessionId: string; prompt: ProviderPrompt }
  | { type: "session.interrupt"; requestId: string; sessionId: string }
  | {
      type: "session.permission";
      sessionId: string;
      permissionId: string;
      response: ProviderPermissionResponse;
    }
  | {
      type: "session.configure";
      requestId: string;
      sessionId: string;
      changes: ProviderConfigChanges;
    }
  | {
      type: "session.revert";
      requestId: string;
      sessionId: string;
      token: JsonValue;
      scope: "conversation" | "files" | "both";
    }
  | { type: "session.archive"; requestId: string; persistence: ProviderPersistence }
  | { type: "session.unarchive"; requestId: string; persistence: ProviderPersistence }
  | { type: "session.close"; requestId: string; sessionId: string };

export interface ProviderThinkingOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export interface ProviderModel {
  id: string;
  aliases?: string[];
  isSelectable?: boolean;
  label: string;
  description?: string;
  isDefault?: boolean;
  metadata?: Readonly<Record<string, JsonValue>>;
  contextWindowMaxTokens?: number;
  thinkingOptions?: ProviderThinkingOption[];
  defaultThinkingOptionId?: string;
}

export interface ProviderMode {
  id: string;
  label: string;
  description?: string;
  icon?: string;
  colorTier?: string;
  isUnattended?: boolean;
}

export type ProviderSetting =
  | {
      type: "toggle";
      id: string;
      label: string;
      description?: string;
      value: boolean;
    }
  | {
      type: "select";
      id: string;
      label: string;
      description?: string;
      value: string | null;
      options: ReadonlyArray<{ label: string; value: string }>;
    };

export interface ProviderConfigState {
  model?: string;
  mode?: string;
  thinkingOption?: string;
  models: readonly ProviderModel[];
  modes: readonly ProviderMode[];
  thinkingOptions: readonly ProviderThinkingOption[];
  settings: readonly ProviderSetting[];
}

export interface ProviderCatalog {
  models: readonly ProviderModel[];
  modes: readonly ProviderMode[];
  thinkingOptions?: readonly ProviderThinkingOption[];
  defaultModel?: string;
  defaultMode?: string;
  defaultThinkingOption?: string;
}

export interface ProviderSessionSummary {
  persistence: ProviderPersistence;
  cwd: string;
  title?: string;
  description?: string;
  updatedAt?: string;
}

export interface ProviderCommand {
  name: string;
  description: string;
  argumentHint?: string;
}

export interface ProviderError {
  message: string;
  code?: string;
  diagnostic?: string;
}

export interface ProviderNotice {
  id: string;
  severity: "info" | "warning" | "error";
  title: string;
  description?: string;
  dismissed?: boolean;
}

export interface ProviderPermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
  intent?: "implement" | "implement_resume" | "dismiss";
}

export interface ProviderPermissionRequest {
  id: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Readonly<Record<string, JsonValue>>;
  detail?: ProviderToolCallDetail;
  suggestions?: Array<Record<string, JsonValue>>;
  actions?: ProviderPermissionAction[];
  metadata?: Readonly<Record<string, JsonValue>>;
}

export type ProviderPermissionResponse =
  | {
      behavior: "allow";
      selectedActionId?: string;
      updatedInput?: Record<string, JsonValue>;
      updatedPermissions?: Array<Record<string, JsonValue>>;
    }
  | {
      behavior: "deny";
      selectedActionId?: string;
      message?: string;
      interrupt?: boolean;
    };

export interface ProviderUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

interface ProviderTimelineIdentity {
  id: string;
  revertToken?: JsonValue;
}

export type ProviderToolCallDetail =
  | { type: "shell"; command: string; cwd?: string; output?: string; exitCode?: number | null }
  | { type: "read"; filePath: string; content?: string; offset?: number; limit?: number }
  | {
      type: "edit";
      filePath: string;
      oldString?: string;
      newString?: string;
      unifiedDiff?: string;
    }
  | { type: "write"; filePath: string; content?: string }
  | {
      type: "search";
      query: string;
      toolName?: "search" | "grep" | "glob" | "web_search";
      content?: string;
      filePaths?: string[];
      webResults?: Array<{ title: string; url: string }>;
      annotations?: string[];
      numFiles?: number;
      numMatches?: number;
      durationMs?: number;
      durationSeconds?: number;
      truncated?: boolean;
      mode?: "content" | "files_with_matches" | "count";
    }
  | {
      type: "fetch";
      url: string;
      prompt?: string;
      result?: string;
      code?: number;
      codeText?: string;
      bytes?: number;
      durationMs?: number;
    }
  | {
      type: "worktree_setup";
      worktreePath: string;
      branchName: string;
      log: string;
      commands: Array<{
        index: number;
        command: string;
        cwd: string;
        log: string;
        status: "running" | "completed" | "failed";
        exitCode: number | null;
        durationMs?: number;
      }>;
      truncated?: boolean;
    }
  | {
      type: "sub_agent";
      subAgentType?: string;
      description?: string;
      childSessionId?: string;
      log: string;
      actions?: Array<{ index: number; toolName: string; summary?: string }>;
    }
  | {
      type: "plain_text";
      label?: string;
      text?: string;
      icon?:
        | "wrench"
        | "square_terminal"
        | "eye"
        | "pencil"
        | "search"
        | "bot"
        | "sparkles"
        | "brain"
        | "mic_vocal";
    }
  | { type: "plan"; text: string }
  | { type: "unknown"; input: JsonValue; output: JsonValue };

type ProviderToolCallItem = ProviderTimelineIdentity & {
  type: "tool_call";
  callId: string;
  name: string;
  detail: ProviderToolCallDetail;
  metadata?: Readonly<Record<string, JsonValue>>;
} & (
    | { status: "running" | "completed" | "canceled"; error: null }
    | { status: "failed"; error: JsonValue }
  );

export type ProviderTimelineItem =
  | (ProviderTimelineIdentity & {
      type: "user_message";
      text: string;
      messageId?: string;
      clientMessageId?: string;
    })
  | (ProviderTimelineIdentity & { type: "assistant_message"; text: string; messageId?: string })
  | (ProviderTimelineIdentity & { type: "reasoning"; text: string })
  | ProviderToolCallItem
  | (ProviderTimelineIdentity & {
      type: "todo";
      items: Array<{
        text: string;
        completed: boolean;
        id?: string;
        status?: "pending" | "in_progress" | "completed";
        activeForm?: string;
      }>;
    })
  | (ProviderTimelineIdentity & { type: "error"; message: string })
  | (ProviderTimelineIdentity & {
      type: "notification";
      level: "info" | "warning" | "error";
      message: string;
    })
  | (ProviderTimelineIdentity & {
      type: "compaction";
      status: "loading" | "completed";
      trigger?: "auto" | "manual";
      preTokens?: number;
    })
  | (ProviderTimelineIdentity & {
      type: "plugin";
      pluginId: string;
      kind: string;
      version: number;
      data: JsonValue;
    });

export type ProviderEvent =
  | { type: "catalog"; requestId: string; catalog: ProviderCatalog }
  | { type: "sessions"; requestId: string; sessions: ProviderSessionSummary[] }
  | { type: "request.completed"; requestId: string }
  | { type: "request.failed"; requestId: string; error: ProviderError }
  | {
      type: "session.opened";
      requestId?: string;
      sessionId: string;
      parentSessionId?: string;
      capabilities: readonly string[];
      restoration: "core" | "parent";
      persistence?: ProviderPersistence;
      title?: string;
      description?: string;
      cwd: string;
    }
  | { type: "session.ready"; requestId?: string; sessionId: string }
  | { type: "session.closed"; sessionId: string; error?: ProviderError }
  | { type: "session.runtime_failed"; sessionId: string; error: ProviderError }
  | { type: "session.persistence"; sessionId: string; persistence: ProviderPersistence }
  | {
      type: "session.prompt_result";
      sessionId: string;
      clientMessageId: string;
      result:
        | { type: "turn"; turnId: string }
        | { type: "steer"; turnId: string }
        | { type: "completed" }
        | { type: "failed"; error: ProviderError };
    }
  | {
      type: "session.turn";
      sessionId: string;
      turnId: string;
      state: "started" | "completed" | "failed" | "canceled";
      error?: ProviderError;
    }
  | { type: "session.usage"; sessionId: string; turnId?: string; usage: ProviderUsage }
  | { type: "session.config"; sessionId: string; config: ProviderConfigState }
  | { type: "session.commands"; sessionId: string; commands: ProviderCommand[] }
  | { type: "session.permission"; sessionId: string; request: ProviderPermissionRequest }
  | { type: "session.permission_resolved"; sessionId: string; permissionId: string }
  | { type: "session.notice"; sessionId: string; notice: ProviderNotice }
  | { type: "timeline.item"; sessionId: string; item: ProviderTimelineItem; timestamp?: string };

export function negotiateProviderCapabilities(
  offered: readonly string[],
  supported: readonly string[],
): readonly ProviderCapability[] {
  const known = new Set<string>(PROVIDER_CAPABILITIES);
  const supportedCapabilities = new Set(supported.filter((capability) => known.has(capability)));
  return offered.filter(
    (capability, index): capability is ProviderCapability =>
      isProviderCapability(capability) &&
      supportedCapabilities.has(capability) &&
      offered.indexOf(capability) === index,
  );
}

export function isProviderCapability(capability: string): capability is ProviderCapability {
  return new Set<string>(PROVIDER_CAPABILITIES).has(capability);
}

function requiredPromptCapabilities(prompt: ProviderPrompt): readonly ProviderCapability[] {
  const capabilities: ProviderCapability[] = [];
  if (prompt.delivery === "steer") capabilities.push("prompt.steer");
  if (prompt.input.type === "command") capabilities.push("prompt.command");
  else {
    capabilities.push("prompt.message");
    if (prompt.input.content.some((part) => part.type === "image")) {
      capabilities.push("prompt.image");
    }
  }
  if (prompt.outputSchema !== undefined) capabilities.push("prompt.output_schema");
  return capabilities;
}

export function requiredProviderCapabilities(input: ProviderInput): readonly ProviderCapability[] {
  switch (input.type) {
    case "catalog":
    case "session.interrupt":
    case "session.close":
      return [];
    case "sessions":
      return ["session.list"];
    case "session.open": {
      const capabilities: ProviderCapability[] = [];
      if (input.persistence) capabilities.push("session.persistence");
      if (input.config.toolPolicy) capabilities.push("permission.tool_policy");
      return capabilities;
    }
    case "session.prompt":
      return requiredPromptCapabilities(input.prompt);
    case "session.permission":
      return ["permission"];
    case "session.configure":
      return ["session.configure"];
    case "session.revert":
      return [`session.revert.${input.scope}`];
    case "session.archive":
      return ["session.archive"];
    case "session.unarchive":
      return ["session.unarchive"];
  }
}

export function requireProviderCapabilities(
  capabilities: readonly string[],
  input: ProviderInput,
): void {
  for (const capability of requiredProviderCapabilities(input)) {
    if (!capabilities.includes(capability)) {
      throw new Error(`Provider does not support ${capability}`);
    }
  }
}

const idSchema = z.string().min(1);
const jsonObjectSchema = z.record(z.string(), z.json());
const providerErrorSchema = z
  .object({ message: z.string(), code: z.string().optional(), diagnostic: z.string().optional() })
  .strip();
const persistenceSchema = z
  .object({ version: z.number().int().nonnegative(), data: z.json() })
  .strip();
const mcpServerSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("stdio"),
      command: z.string(),
      args: z.array(z.string()).optional(),
      env: z.record(z.string(), z.string()).optional(),
      alwaysLoad: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      alwaysLoad: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sse"),
      url: z.string(),
      headers: z.record(z.string(), z.string()).optional(),
      alwaysLoad: z.boolean().optional(),
    })
    .strict(),
]);
const toolPolicySchema = z
  .object({
    preapproved: z.array(
      z.object({ kind: z.literal("mcp"), server: idSchema, tool: idSchema }).strict(),
    ),
  })
  .strict();
const providerPermissionResponseSchema: z.ZodType<ProviderPermissionResponse> =
  z.discriminatedUnion("behavior", [
    z
      .object({
        behavior: z.literal("allow"),
        selectedActionId: z.string().optional(),
        updatedInput: jsonObjectSchema.optional(),
        updatedPermissions: z.array(jsonObjectSchema).optional(),
      })
      .strip(),
    z
      .object({
        behavior: z.literal("deny"),
        selectedActionId: z.string().optional(),
        message: z.string().optional(),
        interrupt: z.boolean().optional(),
      })
      .strip(),
  ]);
const sessionConfigSchema = z
  .object({
    cwd: z.string(),
    env: z.record(z.string(), z.string()),
    systemPrompt: z.string().optional(),
    mcpServers: z.record(z.string(), mcpServerSchema),
    toolPolicy: toolPolicySchema.optional(),
    model: z.string().optional(),
    mode: z.string().optional(),
    thinkingOption: z.string().optional(),
    settings: jsonObjectSchema,
    providerOptions: jsonObjectSchema.optional(),
    title: z.string().optional(),
    persist: z.boolean(),
  })
  .strict();
const externalResourceSchema = z
  .object({
    provider: z.string(),
    providerLabel: z.string(),
    resourceType: z.string(),
    id: z.string(),
    identifier: z.string(),
    title: z.string(),
    url: z.string(),
  })
  .strip();
const reviewContextLineSchema = z
  .object({
    oldLineNumber: z.number().int().positive().nullable(),
    newLineNumber: z.number().int().positive().nullable(),
    type: z.enum(["add", "remove", "context"]),
    content: z.string(),
  })
  .strip();
const providerContentSchema: z.ZodType<ProviderContent> = z.union([
  z.object({ type: z.literal("text"), text: z.string() }).strict(),
  z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }).strict(),
  z
    .object({
      type: z.literal("forge_change_request"),
      mimeType: z.literal("application/paseo-forge-change-request"),
      forge: z.string().optional(),
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      body: z.string().nullable().optional(),
      projectPath: z.string().optional(),
      baseRefName: z.string().nullable().optional(),
      headRefName: z.string().nullable().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("forge_issue"),
      mimeType: z.literal("application/paseo-forge-issue"),
      forge: z.string().optional(),
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      body: z.string().nullable().optional(),
      projectPath: z.string().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("github_pr"),
      mimeType: z.literal("application/github-pr"),
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      body: z.string().nullable().optional(),
      baseRefName: z.string().nullable().optional(),
      headRefName: z.string().nullable().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("github_issue"),
      mimeType: z.literal("application/github-issue"),
      number: z.number().int().positive(),
      title: z.string(),
      url: z.string(),
      body: z.string().nullable().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("text"),
      mimeType: z.literal("text/plain"),
      contextKind: z.string().optional(),
      title: z.string().nullable().optional(),
      text: z.string(),
      externalResource: externalResourceSchema.optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("review"),
      mimeType: z.literal("application/paseo-review"),
      cwd: z.string(),
      mode: z.enum(["uncommitted", "base"]),
      baseRef: z.string().nullable().optional(),
      comments: z.array(
        z
          .object({
            filePath: z.string(),
            side: z.enum(["old", "new"]),
            lineNumber: z.number().int().positive(),
            body: z.string(),
            context: z
              .object({
                hunkHeader: z.string(),
                targetLine: reviewContextLineSchema,
                lines: z.array(reviewContextLineSchema),
              })
              .strip(),
          })
          .strip(),
      ),
    })
    .strip(),
  z
    .object({
      type: z.literal("uploaded_file"),
      id: z.string(),
      fileName: z.string(),
      mimeType: z.string(),
      size: z.number().int().nonnegative(),
      path: z.string(),
    })
    .strip(),
]);
const promptSchema = z
  .object({
    clientMessageId: idSchema,
    delivery: z.enum(["auto", "steer"]),
    input: z.union([
      z.object({ type: z.literal("message"), content: z.array(providerContentSchema) }).strict(),
      z.object({ type: z.literal("command"), name: idSchema, arguments: z.string() }).strict(),
    ]),
    outputSchema: z.json().optional(),
    clearPendingPermissions: z.boolean().optional(),
  })
  .strict();
const configChangesSchema = z
  .object({
    model: z.string().nullable().optional(),
    mode: z.string().nullable().optional(),
    thinkingOption: z.string().nullable().optional(),
    settings: jsonObjectSchema.optional(),
  })
  .strict();

export const ProviderInputSchema: z.ZodType<ProviderInput> = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("catalog"), requestId: idSchema, cwd: z.string().optional() })
    .strict(),
  z
    .object({
      type: z.literal("sessions"),
      requestId: idSchema,
      query: z.string().optional(),
      cwd: z.string().optional(),
      limit: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("session.open"),
      requestId: idSchema,
      sessionId: idSchema,
      config: sessionConfigSchema,
      persistence: persistenceSchema.optional(),
      history: z.enum(["replay", "skip"]),
    })
    .strict(),
  z
    .object({ type: z.literal("session.prompt"), sessionId: idSchema, prompt: promptSchema })
    .strict(),
  z
    .object({ type: z.literal("session.interrupt"), requestId: idSchema, sessionId: idSchema })
    .strict(),
  z
    .object({
      type: z.literal("session.permission"),
      sessionId: idSchema,
      permissionId: idSchema,
      response: providerPermissionResponseSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.configure"),
      requestId: idSchema,
      sessionId: idSchema,
      changes: configChangesSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.revert"),
      requestId: idSchema,
      sessionId: idSchema,
      token: z.json(),
      scope: z.enum(["conversation", "files", "both"]),
    })
    .strict(),
  z
    .object({
      type: z.literal("session.archive"),
      requestId: idSchema,
      persistence: persistenceSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("session.unarchive"),
      requestId: idSchema,
      persistence: persistenceSchema,
    })
    .strict(),
  z.object({ type: z.literal("session.close"), requestId: idSchema, sessionId: idSchema }).strict(),
]);

const modeSchema = z
  .object({
    id: idSchema,
    label: z.string(),
    description: z.string().optional(),
    icon: z.string().optional(),
    colorTier: z.string().optional(),
    isUnattended: z.boolean().optional(),
  })
  .strip();
const selectOptionSchema = z
  .object({
    id: idSchema,
    label: z.string(),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strip();
const modelSchema = z
  .object({
    id: idSchema,
    aliases: z.array(z.string()).optional(),
    isSelectable: z.boolean().optional(),
    label: z.string(),
    description: z.string().optional(),
    isDefault: z.boolean().optional(),
    metadata: jsonObjectSchema.optional(),
    contextWindowMaxTokens: z.number().optional(),
    thinkingOptions: z.array(selectOptionSchema).optional(),
    defaultThinkingOptionId: z.string().optional(),
  })
  .strip();
const settingSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("toggle"),
      id: idSchema,
      label: z.string(),
      description: z.string().optional(),
      value: z.boolean(),
    })
    .strip(),
  z
    .object({
      type: z.literal("select"),
      id: idSchema,
      label: z.string(),
      description: z.string().optional(),
      value: z.string().nullable(),
      options: z.array(z.object({ label: z.string(), value: z.string() }).strip()),
    })
    .strip(),
]);
const configStateSchema = z
  .object({
    model: z.string().optional(),
    mode: z.string().optional(),
    thinkingOption: z.string().optional(),
    models: z.array(modelSchema),
    modes: z.array(modeSchema),
    thinkingOptions: z.array(selectOptionSchema),
    settings: z.array(settingSchema),
  })
  .strip();
const catalogSchema = z
  .object({
    models: z.array(modelSchema),
    modes: z.array(modeSchema),
    thinkingOptions: z.array(selectOptionSchema).optional(),
    defaultModel: z.string().optional(),
    defaultMode: z.string().optional(),
    defaultThinkingOption: z.string().optional(),
  })
  .strip();
const noticeSchema = z
  .object({
    id: idSchema,
    severity: z.enum(["info", "warning", "error"]),
    title: z.string(),
    description: z.string().optional(),
    dismissed: z.boolean().optional(),
  })
  .strip();
const commandSchema = z
  .object({ name: idSchema, description: z.string(), argumentHint: z.string().optional() })
  .strip();
const usageSchema = z
  .object({
    inputTokens: z.number().optional(),
    cachedInputTokens: z.number().optional(),
    outputTokens: z.number().optional(),
    totalCostUsd: z.number().optional(),
    contextWindowMaxTokens: z.number().optional(),
    contextWindowUsedTokens: z.number().optional(),
  })
  .strip();
const worktreeCommandSchema = z
  .object({
    index: z.number().int().positive(),
    command: z.string(),
    cwd: z.string(),
    log: z.string(),
    status: z.enum(["running", "completed", "failed"]),
    exitCode: z.number().nullable(),
    durationMs: z.number().nonnegative().optional(),
  })
  .strip();
const toolCallDetailSchema: z.ZodType<ProviderToolCallDetail> = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("shell"),
      command: z.string(),
      cwd: z.string().optional(),
      output: z.string().optional(),
      exitCode: z.number().nullable().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("read"),
      filePath: z.string(),
      content: z.string().optional(),
      offset: z.number().optional(),
      limit: z.number().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("edit"),
      filePath: z.string(),
      oldString: z.string().optional(),
      newString: z.string().optional(),
      unifiedDiff: z.string().optional(),
    })
    .strip(),
  z
    .object({ type: z.literal("write"), filePath: z.string(), content: z.string().optional() })
    .strip(),
  z
    .object({
      type: z.literal("search"),
      query: z.string(),
      toolName: z.enum(["search", "grep", "glob", "web_search"]).optional(),
      content: z.string().optional(),
      filePaths: z.array(z.string()).optional(),
      webResults: z.array(z.object({ title: z.string(), url: z.string() }).strip()).optional(),
      annotations: z.array(z.string()).optional(),
      numFiles: z.number().optional(),
      numMatches: z.number().optional(),
      durationMs: z.number().optional(),
      durationSeconds: z.number().optional(),
      truncated: z.boolean().optional(),
      mode: z.enum(["content", "files_with_matches", "count"]).optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("fetch"),
      url: z.string(),
      prompt: z.string().optional(),
      result: z.string().optional(),
      code: z.number().optional(),
      codeText: z.string().optional(),
      bytes: z.number().optional(),
      durationMs: z.number().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("worktree_setup"),
      worktreePath: z.string(),
      branchName: z.string(),
      log: z.string(),
      commands: z.array(worktreeCommandSchema),
      truncated: z.boolean().optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("sub_agent"),
      subAgentType: z.string().optional(),
      description: z.string().optional(),
      childSessionId: z.string().optional(),
      log: z.string(),
      actions: z
        .array(
          z
            .object({
              index: z.number().int().positive(),
              toolName: z.string(),
              summary: z.string().optional(),
            })
            .strip(),
        )
        .optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("plain_text"),
      label: z.string().optional(),
      text: z.string().optional(),
      icon: z
        .enum([
          "wrench",
          "square_terminal",
          "eye",
          "pencil",
          "search",
          "bot",
          "sparkles",
          "brain",
          "mic_vocal",
        ])
        .optional(),
    })
    .strip(),
  z.object({ type: z.literal("plan"), text: z.string() }).strip(),
  z.object({ type: z.literal("unknown"), input: z.json(), output: z.json() }).strip(),
]);
const timelineIdentityShape = { id: idSchema, revertToken: z.json().optional() };
const toolCallBaseShape = {
  ...timelineIdentityShape,
  type: z.literal("tool_call"),
  callId: idSchema,
  name: z.string(),
  detail: toolCallDetailSchema,
  metadata: jsonObjectSchema.optional(),
};
const timelineItemSchema: z.ZodType<ProviderTimelineItem> = z.union([
  z
    .object({
      ...timelineIdentityShape,
      type: z.literal("user_message"),
      text: z.string(),
      messageId: z.string().optional(),
      clientMessageId: z.string().optional(),
    })
    .strip(),
  z
    .object({
      ...timelineIdentityShape,
      type: z.literal("assistant_message"),
      text: z.string(),
      messageId: z.string().optional(),
    })
    .strip(),
  z.object({ ...timelineIdentityShape, type: z.literal("reasoning"), text: z.string() }).strip(),
  z.object({ ...toolCallBaseShape, status: z.literal("running"), error: z.null() }).strip(),
  z.object({ ...toolCallBaseShape, status: z.literal("completed"), error: z.null() }).strip(),
  z.object({ ...toolCallBaseShape, status: z.literal("failed"), error: z.json() }).strip(),
  z.object({ ...toolCallBaseShape, status: z.literal("canceled"), error: z.null() }).strip(),
  z
    .object({
      ...timelineIdentityShape,
      type: z.literal("todo"),
      items: z.array(
        z
          .object({
            text: z.string(),
            completed: z.boolean(),
            id: z.string().optional(),
            status: z.enum(["pending", "in_progress", "completed"]).optional(),
            activeForm: z.string().optional(),
          })
          .strip(),
      ),
    })
    .strip(),
  z.object({ ...timelineIdentityShape, type: z.literal("error"), message: z.string() }).strip(),
  z
    .object({
      ...timelineIdentityShape,
      type: z.literal("notification"),
      level: z.enum(["info", "warning", "error"]),
      message: z.string(),
    })
    .strip(),
  z
    .object({
      ...timelineIdentityShape,
      type: z.literal("compaction"),
      status: z.enum(["loading", "completed"]),
      trigger: z.enum(["auto", "manual"]).optional(),
      preTokens: z.number().optional(),
    })
    .strip(),
  z
    .object({
      ...timelineIdentityShape,
      type: z.literal("plugin"),
      pluginId: idSchema,
      kind: z.string(),
      version: z.number(),
      data: z.json(),
    })
    .strip(),
]);
const permissionActionSchema = z
  .object({
    id: idSchema,
    label: z.string(),
    behavior: z.enum(["allow", "deny"]),
    variant: z.enum(["primary", "secondary", "danger"]).optional(),
    intent: z.enum(["implement", "implement_resume", "dismiss"]).optional(),
  })
  .strip();
const providerPermissionRequestSchema: z.ZodType<ProviderPermissionRequest> = z
  .object({
    id: idSchema,
    name: z.string(),
    kind: z.enum(["tool", "plan", "question", "mode", "other"]),
    title: z.string().optional(),
    description: z.string().optional(),
    input: jsonObjectSchema.optional(),
    detail: toolCallDetailSchema.optional(),
    suggestions: z.array(jsonObjectSchema).optional(),
    actions: z.array(permissionActionSchema).optional(),
    metadata: jsonObjectSchema.optional(),
  })
  .strip();

export const ProviderEventSchema: z.ZodType<ProviderEvent> = z.discriminatedUnion("type", [
  z.object({ type: z.literal("catalog"), requestId: idSchema, catalog: catalogSchema }).strip(),
  z
    .object({
      type: z.literal("sessions"),
      requestId: idSchema,
      sessions: z.array(
        z
          .object({
            persistence: persistenceSchema,
            cwd: z.string(),
            title: z.string().optional(),
            description: z.string().optional(),
            updatedAt: z.string().optional(),
          })
          .strip(),
      ),
    })
    .strip(),
  z.object({ type: z.literal("request.completed"), requestId: idSchema }).strip(),
  z
    .object({ type: z.literal("request.failed"), requestId: idSchema, error: providerErrorSchema })
    .strip(),
  z
    .object({
      type: z.literal("session.opened"),
      requestId: idSchema.optional(),
      sessionId: idSchema,
      parentSessionId: idSchema.optional(),
      capabilities: z.array(z.string()),
      restoration: z.enum(["core", "parent"]),
      persistence: persistenceSchema.optional(),
      title: z.string().optional(),
      description: z.string().optional(),
      cwd: z.string(),
    })
    .strip(),
  z
    .object({
      type: z.literal("session.ready"),
      requestId: idSchema.optional(),
      sessionId: idSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("session.closed"),
      sessionId: idSchema,
      error: providerErrorSchema.optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("session.runtime_failed"),
      sessionId: idSchema,
      error: providerErrorSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("session.persistence"),
      sessionId: idSchema,
      persistence: persistenceSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("session.prompt_result"),
      sessionId: idSchema,
      clientMessageId: idSchema,
      result: z.union([
        z.object({ type: z.literal("turn"), turnId: idSchema }).strip(),
        z.object({ type: z.literal("steer"), turnId: idSchema }).strip(),
        z.object({ type: z.literal("completed") }).strip(),
        z.object({ type: z.literal("failed"), error: providerErrorSchema }).strip(),
      ]),
    })
    .strip(),
  z
    .object({
      type: z.literal("session.turn"),
      sessionId: idSchema,
      turnId: idSchema,
      state: z.enum(["started", "completed", "failed", "canceled"]),
      error: providerErrorSchema.optional(),
    })
    .strip(),
  z
    .object({
      type: z.literal("session.usage"),
      sessionId: idSchema,
      turnId: idSchema.optional(),
      usage: usageSchema,
    })
    .strip(),
  z
    .object({ type: z.literal("session.config"), sessionId: idSchema, config: configStateSchema })
    .strip(),
  z
    .object({
      type: z.literal("session.commands"),
      sessionId: idSchema,
      commands: z.array(commandSchema),
    })
    .strip(),
  z
    .object({
      type: z.literal("session.permission"),
      sessionId: idSchema,
      request: providerPermissionRequestSchema,
    })
    .strip(),
  z
    .object({
      type: z.literal("session.permission_resolved"),
      sessionId: idSchema,
      permissionId: idSchema,
    })
    .strip(),
  z
    .object({ type: z.literal("session.notice"), sessionId: idSchema, notice: noticeSchema })
    .strip(),
  z
    .object({
      type: z.literal("timeline.item"),
      sessionId: idSchema,
      item: timelineItemSchema,
      timestamp: z.string().optional(),
    })
    .strip(),
]);
