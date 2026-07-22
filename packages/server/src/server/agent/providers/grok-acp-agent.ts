import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { InitializeResponse } from "@agentclientprotocol/sdk";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  AgentSlashCommand,
  AgentSlashCommandKind,
  AgentStreamEvent,
  ImportableProviderSession,
  ListImportableSessionsOptions,
} from "../agent-sdk-types.js";
import type {
  ACPExtensionNotificationParser,
  ACPInitialCommandsParser,
  ACPThinkingOptionWriter,
  SessionStateResponse,
} from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import { readGrokSubagentDiskMeta } from "./grok-subagent-meta.js";
import { mapGrokAcpToolDetail, transformGrokAcpToolSnapshot } from "./grok-tool-mapper.js";

interface GrokACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

const GROK_INITIALIZE_META = {
  clientType: "generic",
  clientIdentifier: "paseo",
};
const GROK_AUTH_ENV_KEYS = [
  "XAI_API_KEY",
  "GROK_CODE_XAI_API_KEY",
  "GROK_AUTH",
  "GROK_AUTH_PROVIDER_COMMAND",
  "GROK_DEPLOYMENT_KEY",
] as const;

const GROK_REASONING_CONFIG_ID = "_paseo.grok.reasoning_effort";
const GROK_CANONICAL_REASONING_EFFORT: Record<string, string> = {
  none: "none",
  minimal: "minimal",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "xhigh",
};

const GROK_SESSION_NOTIFICATION_METHODS: Record<string, true> = {
  "x.ai/session_notification": true,
  "_x.ai/session_notification": true,
  "x.ai/session/update": true,
  "_x.ai/session/update": true,
};

const GrokSessionConfigOptionSchema = z
  .object({
    id: z.string(),
    category: z.string(),
    label: z.string(),
    description: z.string().nullish(),
    selected: z.boolean(),
  })
  .passthrough();

const GrokSessionConfigSchema = z
  .object({
    options: z.array(GrokSessionConfigOptionSchema),
  })
  .passthrough();

type GrokSessionConfigOption = z.infer<typeof GrokSessionConfigOptionSchema>;

interface GrokReasoningOption {
  sourceId: string;
  value: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

const GrokSessionListRowSchema = z
  .object({
    sessionId: z.string(),
    cwd: z.string(),
    title: z.string().nullish(),
    summary: z.string().nullish(),
    firstPrompt: z.string().nullish(),
    updatedAt: z.string().nullish(),
    lastActiveAt: z.string().nullish(),
    createdAt: z.string().nullish(),
  })
  .passthrough();

const GrokSessionListEnvelopeSchema = z
  .object({
    result: z
      .object({
        sessions: z.array(GrokSessionListRowSchema),
        nextCursor: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
    error: z.unknown().nullish(),
  })
  .passthrough();

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readCommandArgumentHint(command: Record<string, unknown>): string {
  const input = isRecord(command.input) ? command.input : null;
  if (!input) return "";
  const directHint = readString(input, "hint");
  if (directHint) return directHint;
  const unstructured = isRecord(input.unstructured) ? input.unstructured : null;
  return unstructured ? (readString(unstructured, "hint") ?? "") : "";
}

function mapGrokCommands(value: unknown): AgentSlashCommand[] {
  if (!Array.isArray(value)) return [];
  const commands: AgentSlashCommand[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)) continue;
    const name = (readString(item, "name") ?? "").replace(/^\/+/, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const meta = isRecord(item._meta) ? item._meta : null;
    const kind: AgentSlashCommandKind = meta?.path || meta?.scope ? "skill" : "command";
    commands.push({
      name,
      description: readString(item, "description") ?? "",
      argumentHint: readCommandArgumentHint(item),
      kind,
    });
  }
  return commands;
}

export const parseGrokInitialCommands: ACPInitialCommandsParser = (response) => {
  const meta = response._meta;
  if (!isRecord(meta) || !Array.isArray(meta.availableCommands)) return null;
  return mapGrokCommands(meta.availableCommands);
};

function normalizeModelReasoningOptions(
  rawEfforts: unknown[],
  sessionOptions: GrokSessionConfigOption[],
): GrokReasoningOption[] {
  const options: GrokReasoningOption[] = [];
  const seenValues = new Set<string>();
  for (const rawEffort of rawEfforts) {
    const record = isRecord(rawEffort) ? rawEffort : null;
    let rawValue: string | null = null;
    if (typeof rawEffort === "string") {
      rawValue = rawEffort;
    } else if (record) {
      rawValue = readString(record, "value");
    }
    if (!rawValue) continue;
    const value = GROK_CANONICAL_REASONING_EFFORT[rawValue.toLowerCase()];
    if (!value || seenValues.has(value)) continue;
    seenValues.add(value);
    const sourceId = (record ? readString(record, "id") : null) ?? rawValue;
    const sessionOption = sessionOptions.find((option) => option.id === sourceId);
    options.push({
      sourceId,
      value,
      name: (record ? readString(record, "label") : null) ?? sessionOption?.label ?? sourceId,
      description:
        (record ? readString(record, "description") : null) ?? sessionOption?.description ?? null,
      isDefault: record?.default === true,
    });
  }
  return options;
}

function normalizeSessionReasoningOptions(
  sessionOptions: GrokSessionConfigOption[],
): GrokReasoningOption[] {
  const options: GrokReasoningOption[] = [];
  const seenValues = new Set<string>();
  for (const sessionOption of sessionOptions) {
    const value = GROK_CANONICAL_REASONING_EFFORT[sessionOption.id.toLowerCase()];
    if (!value || seenValues.has(value)) continue;
    seenValues.add(value);
    options.push({
      sourceId: sessionOption.id,
      value,
      name: sessionOption.label,
      description: sessionOption.description ?? null,
      isDefault: false,
    });
  }
  return options;
}

function resolveGrokReasoningCurrentValue(
  modelMeta: Record<string, unknown> | null,
  sessionOptions: GrokSessionConfigOption[],
  options: GrokReasoningOption[],
): string {
  const selectedSessionId = sessionOptions.find((option) => option.selected)?.id;
  const modelEffort = modelMeta ? readString(modelMeta, "reasoningEffort") : null;
  return (
    (modelEffort ? GROK_CANONICAL_REASONING_EFFORT[modelEffort.toLowerCase()] : undefined) ??
    options.find((option) => option.sourceId === selectedSessionId)?.value ??
    options.find((option) => option.isDefault)?.value ??
    options[0].value
  );
}

export function transformGrokSessionResponse(response: SessionStateResponse): SessionStateResponse {
  const meta = response._meta;
  if (!isRecord(meta)) return response;
  const parsed = GrokSessionConfigSchema.safeParse(meta["x.ai/sessionConfig"]);
  if (!parsed.success) return response;

  const sessionOptions = parsed.data.options.filter((option) => option.category === "mode");
  const selectedModelId = parsed.data.options.find(
    (option) => option.category === "model" && option.selected,
  )?.id;
  const currentModel = response.models?.availableModels?.find(
    (model) =>
      model.modelId === response.models?.currentModelId || model.modelId === selectedModelId,
  );
  const modelMeta = currentModel && isRecord(currentModel._meta) ? currentModel._meta : null;
  const rawEfforts =
    modelMeta && Array.isArray(modelMeta.reasoningEfforts) ? modelMeta.reasoningEfforts : [];
  const modelOptions = normalizeModelReasoningOptions(rawEfforts, sessionOptions);
  const options =
    modelOptions.length > 0 ? modelOptions : normalizeSessionReasoningOptions(sessionOptions);
  if (options.length === 0) return response;

  const currentValue = resolveGrokReasoningCurrentValue(modelMeta, sessionOptions, options);

  return {
    ...response,
    configOptions: [
      ...(response.configOptions ?? []).filter((option) => option.id !== GROK_REASONING_CONFIG_ID),
      {
        type: "select",
        id: GROK_REASONING_CONFIG_ID,
        name: "Reasoning effort",
        category: "thought_level",
        currentValue,
        options: options.map((option) => ({
          value: option.value,
          name: option.name,
          description: option.description,
        })),
      },
    ],
  };
}

export const writeGrokThinkingOption: ACPThinkingOptionWriter = async ({
  connection,
  sessionId,
  modelId,
  thinkingOptionId,
}) => {
  await connection.unstable_setSessionModel({
    sessionId,
    modelId,
    _meta: { reasoningEffort: thinkingOptionId },
  });
};

function subagentStatus(value: unknown): "completed" | "failed" | "canceled" {
  if (value === "completed") return "completed";
  if (value === "cancelled" || value === "canceled") return "canceled";
  return "failed";
}

/**
 * Grok-only presentation: fold model/effort into the existing title field
 * (same idea as OMP). No protocol/store/UI schema changes required — track
 * rows and tab labels already show `title`.
 */
export function formatGrokSubagentTitle(input: {
  baseTitle: string;
  model?: string | null;
  thinkingOptionId?: string | null;
}): string {
  const parts = [input.baseTitle.trim() || "Grok subagent"];
  const model = input.model?.trim();
  if (model) parts.push(model);
  const thinking = input.thinkingOptionId?.trim();
  if (thinking) parts.push(thinking);
  return parts.join(" · ");
}

interface GrokSubagentDisplayState {
  baseTitle: string;
  description: string | null;
  model: string | null;
  thinkingOptionId: string | null;
}

function diskMetaForChild(subagentId: string): {
  model: string | null;
  thinkingOptionId: string | null;
} | null {
  return readGrokSubagentDiskMeta({
    childSessionId: subagentId,
    env: process.env,
    canonicalReasoningEffort: GROK_CANONICAL_REASONING_EFFORT,
  });
}

type GrokDiskMetaReader = (subagentId: string) => {
  model: string | null;
  thinkingOptionId: string | null;
} | null;

/**
 * Apply disk summary.json model/effort onto display state.
 * Early-out once both values are known so ~2s progress ticks skip readdirSync.
 */
export function applyDiskMeta(
  state: GrokSubagentDisplayState,
  subagentId: string,
  readDisk: GrokDiskMetaReader = diskMetaForChild,
): boolean {
  // Once both are populated, further disk walks cannot improve the title.
  if (state.model && state.thinkingOptionId) {
    return false;
  }
  const disk = readDisk(subagentId);
  if (!disk) return false;
  let changed = false;
  if (disk.model && disk.model !== state.model) {
    state.model = disk.model;
    changed = true;
  }
  if (disk.thinkingOptionId && disk.thinkingOptionId !== state.thinkingOptionId) {
    state.thinkingOptionId = disk.thinkingOptionId;
    changed = true;
  }
  return changed;
}

function upsertWithDisplay(
  provider: string,
  id: string,
  status: "running" | "completed" | "failed" | "canceled",
  state: GrokSubagentDisplayState,
): AgentStreamEvent {
  return {
    type: "provider_subagent",
    provider,
    event: {
      type: "upsert",
      id,
      status,
      title: formatGrokSubagentTitle(state),
      description: state.description,
    },
  };
}

/**
 * Per-client factory for Grok extension notifications. Owns the subagent
 * display map so two Grok sessions in one daemon never share (or leak) state.
 */
export function createGrokExtensionNotificationParser(): ACPExtensionNotificationParser {
  const grokSubagentDisplay = new Map<string, GrokSubagentDisplayState>();

  function mapSpawnedSubagent(
    update: Record<string, unknown>,
    subagentId: string,
    provider: string,
  ): AgentStreamEvent[] {
    const baseTitle = readString(update, "description") ?? "Grok subagent";
    const description = readString(update, "subagent_type");
    const wireModel = readString(update, "model");
    const state: GrokSubagentDisplayState = {
      baseTitle,
      description,
      model: wireModel,
      thinkingOptionId: null,
    };
    // Best-effort: reasoning is not on the spawn wire; summary may already exist.
    applyDiskMeta(state, subagentId);
    if (!state.model && wireModel) state.model = wireModel;
    grokSubagentDisplay.set(subagentId, state);
    return [upsertWithDisplay(provider, subagentId, "running", state)];
  }

  function mapProgressSubagent(subagentId: string, provider: string): AgentStreamEvent[] {
    const state = grokSubagentDisplay.get(subagentId);
    if (!state) {
      return [
        {
          type: "provider_subagent",
          provider,
          event: { type: "upsert", id: subagentId, status: "running" },
        },
      ];
    }
    // Progress ticks (~2s): retry disk for reasoning once summary is written.
    applyDiskMeta(state, subagentId);
    return [upsertWithDisplay(provider, subagentId, "running", state)];
  }

  function mapFinishedSubagent(
    update: Record<string, unknown>,
    subagentId: string,
    provider: string,
  ): AgentStreamEvent[] {
    const events: AgentStreamEvent[] = [];
    const output = readString(update, "output");
    if (output) {
      events.push({
        type: "provider_subagent",
        provider,
        event: {
          type: "timeline",
          id: subagentId,
          item: { type: "assistant_message", text: output },
        },
      });
    }
    const error = readString(update, "error");
    if (error) {
      events.push({
        type: "provider_subagent",
        provider,
        event: {
          type: "timeline",
          id: subagentId,
          item: { type: "error", message: error },
        },
      });
    }
    const state = grokSubagentDisplay.get(subagentId) ?? {
      baseTitle: "Grok subagent",
      description: null,
      model: null,
      thinkingOptionId: null,
    };
    applyDiskMeta(state, subagentId);
    events.push(upsertWithDisplay(provider, subagentId, subagentStatus(update.status), state));
    grokSubagentDisplay.delete(subagentId);
    return events;
  }

  function parseGrokSubagentUpdate(
    update: Record<string, unknown>,
    provider: string,
  ): AgentStreamEvent[] | null {
    const type = readString(update, "sessionUpdate");
    const subagentId = readString(update, "child_session_id") ?? readString(update, "subagent_id");
    if (!subagentId) return null;
    if (type === "subagent_spawned") return mapSpawnedSubagent(update, subagentId, provider);
    if (type === "subagent_progress") return mapProgressSubagent(subagentId, provider);
    if (type === "subagent_finished") return mapFinishedSubagent(update, subagentId, provider);
    return null;
  }

  return (method, params, context) => {
    let notificationMethod = method;
    let notificationParams = params;
    if (method === "_x.ai/session_notification") {
      notificationMethod = readString(params, "method") ?? method;
      notificationParams = isRecord(params.params) ? params.params : params;
    }
    if (!GROK_SESSION_NOTIFICATION_METHODS[notificationMethod]) return null;
    const targetSessionId = readString(notificationParams, "sessionId");
    if (targetSessionId && context.sessionId && targetSessionId !== context.sessionId) return null;
    const update = isRecord(notificationParams.update) ? notificationParams.update : null;
    return update ? parseGrokSubagentUpdate(update, context.provider) : null;
  };
}

/** Shared parser instance for tests and one-off callers; production clients use a per-client factory. */
export const parseGrokExtensionNotification: ACPExtensionNotificationParser =
  createGrokExtensionNotificationParser();

function isGrokInitialize(response: InitializeResponse): boolean {
  return isRecord(response._meta) && response._meta.grokShell === true;
}

function toActivityDate(row: z.infer<typeof GrokSessionListRowSchema>): Date {
  for (const value of [row.lastActiveAt, row.updatedAt, row.createdAt]) {
    if (!value) continue;
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date(0);
}
export function parseGrokSessionListPage(response: unknown): {
  sessions: ImportableProviderSession[];
  nextCursor: string | null;
} {
  const parsed = GrokSessionListEnvelopeSchema.parse(response);
  if (parsed.error != null || !parsed.result) {
    throw new Error("Grok session listing failed");
  }
  return {
    sessions: parsed.result.sessions.map((row) => ({
      providerHandleId: row.sessionId,
      cwd: row.cwd,
      title: row.title ?? row.summary ?? null,
      firstPromptPreview: row.firstPrompt ?? null,
      lastPromptPreview: null,
      lastActivityAt: toActivityDate(row),
    })),
    nextCursor: parsed.result.nextCursor ?? null,
  };
}

function authPath(env: Record<string, string | undefined>): string {
  if (env.GROK_AUTH_PATH) return env.GROK_AUTH_PATH;
  return join(env.GROK_HOME ?? join(homedir(), ".grok"), "auth.json");
}

export class GrokACPAgentClient extends GenericACPAgentClient {
  private readonly configuredEnv: Record<string, string>;

  constructor(options: GrokACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      initializeRequestMeta: GROK_INITIALIZE_META,
      initialCommandsParser: parseGrokInitialCommands,
      forwardChildSessionUpdates: true,
      extensionNotificationParser: createGrokExtensionNotificationParser(),
      sessionResponseTransformer: transformGrokSessionResponse,
      thinkingOptionWriter: writeGrokThinkingOption,
      toolSnapshotTransformer: transformGrokAcpToolSnapshot,
      toolDetailMapper: mapGrokAcpToolDetail,
    });
    this.configuredEnv = options.env ?? {};
  }

  override async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    const probe = await this.spawnProcess({ NO_BROWSER: "true" });
    if (!isGrokInitialize(probe.initialize)) {
      await this.closeProbe(probe);
      return await super.listImportableSessions(options);
    }
    try {
      const sessions: ImportableProviderSession[] = [];
      let cursor: string | null = null;
      for (;;) {
        const response = await this.runACPRequest(() =>
          probe.connection.extMethod("_x.ai/session/list", {
            ...(options?.cwd ? { cwd: options.cwd } : {}),
            ...(cursor ? { cursor } : {}),
            limit: options?.limit ?? 30,
          }),
        );
        const page = parseGrokSessionListPage(response);
        sessions.push(...page.sessions);
        cursor = page.nextCursor;
        if (!cursor || (options?.limit != null && sessions.length >= options.limit)) break;
      }
      return options?.limit == null ? sessions : sessions.slice(0, options.limit);
    } finally {
      await this.closeProbe(probe);
    }
  }

  override async getDiagnostic(): Promise<{ diagnostic: string }> {
    const result = await super.getDiagnostic();
    const env = { ...process.env, ...this.configuredEnv };
    const authEnvKey = GROK_AUTH_ENV_KEYS.find((key) => Boolean(env[key])) ?? null;
    if (authEnvKey) {
      return { diagnostic: `${result.diagnostic}\n  Authentication: configured via ${authEnvKey}` };
    }

    const path = authPath(env);
    try {
      await access(path);
      return { diagnostic: `${result.diagnostic}\n  Authentication: credentials found at ${path}` };
    } catch {
      return {
        diagnostic: `${result.diagnostic}\n  Authentication: no environment credential or auth.json found (config.toml and interactive login not inspected); run grok login or set XAI_API_KEY if launch fails`,
      };
    }
  }
}
