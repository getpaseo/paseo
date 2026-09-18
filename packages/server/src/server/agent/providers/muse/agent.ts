import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentProvider,
  AgentResumeSessionOptions,
  AgentSelectOption,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
  ImportableProviderSession,
  ImportedProviderSession,
  ImportProviderSessionContext,
  ImportProviderSessionInput,
  ListImportableSessionsOptions,
  ProviderCatalog,
  ProviderRefreshContext,
} from "../../agent-sdk-types.js";
import { runProviderRefreshActivity } from "../../provider-refresh-deadline.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../../provider-launch-config.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "../diagnostic-utils.js";
import { importSessionFromPersistence } from "../../provider-session-import.js";
import { createPathEquivalenceMatcher } from "../../../../utils/path.js";
import {
  spawnMuseHost,
  type MuseHostConnection,
  type MuseHostSpawnOptions,
  type MuseHostSpawner,
  type MuseModelCatalogEntry,
} from "./host.js";
import { mapMuseMcpServers } from "./mcps.js";
import { MuseAgentSession } from "./session.js";
import { composeSystemPromptParts } from "../../system-prompt.js";

export const MUSE_PROVIDER = "muse";

const MUSE_DEFAULT_BINARY = "muse";

export const MUSE_MODES: AgentMode[] = [
  {
    id: "onRequest",
    label: "On Request",
    description: "Approves only on request; unmatched subjects follow the host default",
  },
  {
    id: "promptUnmatched",
    label: "Always Ask",
    description: "Every unmatched subject stops for review",
  },
  {
    id: "denyUnmatched",
    label: "Auto Deny",
    description: "Unmatched subjects fail with a typed denial instead of prompting",
  },
  {
    id: "allowAll",
    label: "Allow All",
    description: "Automatically approves all Muse tool, path, and URL requests.",
  },
];

export const MUSE_DEFAULT_THINKING_OPTION_ID = "high";

const MUSE_THINKING_TIERS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export type MuseThinkingTier = (typeof MUSE_THINKING_TIERS)[number];

export const MUSE_THINKING_OPTIONS: AgentSelectOption[] = [
  { id: "minimal", label: "Minimal", description: "Quick answers with least reasoning" },
  { id: "low", label: "Low", description: "Light reasoning for simple tasks" },
  { id: "medium", label: "Medium", description: "Balanced reasoning" },
  {
    id: "high",
    label: "High",
    description: "Deep reasoning for hard problems",
    isDefault: true,
  },
  { id: "xhigh", label: "Extra High", description: "Extended reasoning" },
  { id: "max", label: "Max", description: "Maximum reasoning depth" },
  { id: "ultra", label: "Ultra", description: "Delegating ultra reasoning" },
];

export function normalizeMuseThinkingOption(
  value: string | null | undefined,
): MuseThinkingTier | null {
  if (!value) {
    return null;
  }
  return (MUSE_THINKING_TIERS as readonly string[]).includes(value)
    ? (value as MuseThinkingTier)
    : null;
}

const MUSE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: false,
};

const MuseProviderParamsSchema = z.object({}).strict();

export interface MuseAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
  providerParams?: unknown;
  hostSpawner?: MuseHostSpawner;
}

export type MuseAuthFileState = "found" | "not found" | "present but unreadable";

export function describeMuseAuthFileState(
  authFilePath: string,
  access: (path: string) => void = (path) => accessSync(path, constants.R_OK),
): MuseAuthFileState {
  try {
    access(authFilePath);
    return "found";
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return "not found";
    }
    return "present but unreadable";
  }
}

function stderrTail(chunks: string[]): string {
  const text = chunks.join("").trim();
  if (!text) {
    return "";
  }
  return text.split("\n").slice(-10).join("\n").slice(-2000);
}

export function mapMuseCatalogEntry(entry: MuseModelCatalogEntry): AgentModelDefinition | null {
  if (typeof entry.modelId !== "string" || typeof entry.displayLabel !== "string") {
    return null;
  }
  return {
    provider: MUSE_PROVIDER,
    id: entry.modelId,
    label: entry.displayLabel,
    ...(typeof entry.description === "string" && entry.description
      ? { description: entry.description }
      : {}),
    ...(entry.isDefault === true ? { isDefault: true } : {}),
    ...(typeof entry.contextLimit === "number"
      ? { contextWindowMaxTokens: entry.contextLimit }
      : {}),
    thinkingOptions: MUSE_THINKING_OPTIONS,
    defaultThinkingOptionId: MUSE_DEFAULT_THINKING_OPTION_ID,
  };
}

export class MuseAgentClient implements AgentClient {
  readonly provider: AgentProvider = MUSE_PROVIDER;
  readonly capabilities: AgentCapabilityFlags = MUSE_CAPABILITIES;

  private readonly logger: Logger;
  private readonly runtimeSettings?: ProviderRuntimeSettings;
  private readonly hostSpawner: MuseHostSpawner;

  constructor(options: MuseAgentClientOptions) {
    this.logger = options.logger;
    this.runtimeSettings = options.runtimeSettings;
    MuseProviderParamsSchema.parse(options.providerParams ?? {});
    this.hostSpawner = options.hostSpawner ?? spawnMuseHost;
  }

  async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const approvalMode = resolveMuseApprovalMode(config.modeId);
    const host = await this.spawnSessionHost(config.cwd, launchContext?.env);
    try {
      const mcpServers = mapMuseMcpServers(config.mcpServers, this.logger);
      const started = (await host.command("session/start", {
        workspaceRoot: config.cwd,
        approvalMode,
        ...(config.model ? { modelId: config.model } : {}),
        ...(mcpServers ? { config: { mcpServers } } : {}),
      })) as unknown as Record<string, unknown>;
      const session = readSessionRecord(started);
      if (!session.sessionId) {
        throw new Error("Muse session/start did not return a session id");
      }
      const thinkingOptionId = config.thinkingOptionId
        ? requireMuseThinkingOption(config.thinkingOptionId)
        : null;
      if (thinkingOptionId) {
        await host.command("session/setReasoningEffort", {
          sessionId: session.sessionId,
          reasoningEffort: thinkingOptionId,
        });
      }
      return new MuseAgentSession({
        host,
        sessionId: session.sessionId,
        config,
        capabilities: this.capabilities,
        modelId: session.modelId ?? config.model ?? null,
        modeId: session.approvalMode ?? approvalMode,
        thinkingOptionId,
        systemPrefix: composeSystemPromptParts(
          config.systemPrompt,
          config.daemonAppendSystemPrompt,
        ),
        logger: this.logger,
      });
    } catch (error) {
      await host.close().catch(() => undefined);
      throw error;
    }
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
    _options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const nativeHandle = handle.nativeHandle ?? handle.sessionId;
    const metadata = handle.metadata ?? {};
    const cwd =
      overrides?.cwd ?? (typeof metadata["cwd"] === "string" ? metadata["cwd"] : homedir());
    const host = await this.spawnSessionHost(cwd, launchContext?.env);
    try {
      const resumed = (await host.command("session/resume", {
        sessionId: nativeHandle,
      })) as unknown as Record<string, unknown>;
      const session = readSessionRecord(resumed);
      if (!session.sessionId) {
        throw new Error("Muse session/resume did not return a session id");
      }
      const modeId =
        overrides?.modeId ??
        readMetadataString(metadata, "modeId") ??
        session.approvalMode ??
        "onRequest";
      const model = overrides?.model ?? readMetadataString(metadata, "model");
      const thinkingOptionId =
        overrides?.thinkingOptionId ?? readMetadataString(metadata, "thinkingOptionId") ?? null;
      const config: AgentSessionConfig = {
        provider: this.provider,
        cwd,
        ...(model ? { model } : {}),
        modeId,
        ...(thinkingOptionId ? { thinkingOptionId } : {}),
      };
      return new MuseAgentSession({
        host,
        sessionId: session.sessionId,
        config,
        capabilities: this.capabilities,
        modelId: config.model ?? session.modelId ?? null,
        modeId,
        thinkingOptionId,
        logger: this.logger,
      });
    } catch (error) {
      await host.close().catch(() => undefined);
      throw error;
    }
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    let host: MuseHostConnection | undefined;
    let closePromise: Promise<void> | undefined;
    const closeHost = () => {
      if (!host) return Promise.resolve();
      closePromise ??= host.close();
      return closePromise;
    };
    const handleAbort = () => void closeHost().catch(() => undefined);
    context?.signal.addEventListener("abort", handleAbort, { once: true });
    const stderrChunks: string[] = [];
    try {
      try {
        await runProviderRefreshActivity(context, "msp.initialize", async () => {
          host = await this.spawnSessionHost(
            options.scope === "global" ? homedir() : options.cwd,
            undefined,
            (chunk) => {
              stderrChunks.push(chunk);
            },
          );
          if (context?.signal.aborted) await closeHost();
        });
        if (!host) throw new Error("Muse catalog host did not start");
        const catalogHost = host;
        if (catalogHost.fingerprintWarning) {
          this.logger.warn(
            {
              pinned: catalogHost.fingerprintWarning.pinned,
              served: catalogHost.fingerprintWarning.served,
            },
            catalogHost.fingerprintWarning.message,
          );
        }
        const result = await runProviderRefreshActivity(context, "model/list", () =>
          catalogHost.modelList(),
        );
        const models = Array.isArray(result.models)
          ? result.models.flatMap((entry) => {
              const mapped = mapMuseCatalogEntry(entry);
              if (!mapped) {
                this.logger.warn(
                  { entry },
                  "Skipping Muse catalog row with an unexpected shape",
                );
                return [];
              }
              return [mapped];
            })
          : [];
        return { models, modes: MUSE_MODES };
      } catch (error) {
        const tail = stderrTail(stderrChunks);
        if (!tail) {
          throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`${message} (muse stderr: ${tail})`, { cause: error });
      }
    } finally {
      context?.signal.removeEventListener("abort", handleAbort);
      await closeHost();
    }
  }

  async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    const limit = options?.limit ?? MUSE_IMPORTABLE_SESSION_LIMIT;
    const scanLimit = Math.min(options?.scanLimit ?? limit, 500);
    const belongsToWorkspace = options?.cwd
      ? createPathEquivalenceMatcher(options.cwd)
      : null;
    const host = await this.spawnSessionHost(options?.cwd ?? homedir());
    try {
      const candidates: ImportableProviderSession[] = [];
      const seenCursors = new Set<string>();
      let cursor: string | undefined;
      let scanned = 0;
      for (;;) {
        const page = await host.command("session/list", {
          ...(cursor ? { cursor } : {}),
          limit: 200,
        });
        const { sessions, nextCursor } = readSessionListPage(page);
        for (const session of sessions) {
          if (scanned >= scanLimit || candidates.length >= limit) break;
          scanned += 1;
          const row = mapMuseImportableSession(session);
          if (belongsToWorkspace && !belongsToWorkspace(row.cwd)) continue;
          candidates.push(row);
        }
        if (candidates.length >= limit || scanned >= scanLimit) break;
        if (!nextCursor || seenCursors.has(nextCursor)) break;
        seenCursors.add(nextCursor);
        cursor = nextCursor;
      }
      return candidates
        .sort((left, right) => right.lastActivityAt.getTime() - left.lastActivityAt.getTime())
        .slice(0, limit);
    } finally {
      await host.close().catch(() => undefined);
    }
  }

  async importSession(
    input: ImportProviderSessionInput,
    context: ImportProviderSessionContext,
  ): Promise<ImportedProviderSession> {
    return importSessionFromPersistence({
      provider: this.provider,
      request: input,
      context,
      resumeSession: this.resumeSession.bind(this),
    });
  }

  async isAvailable(): Promise<boolean> {
    try {
      const launch = await this.resolveMuseLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      return availability.available;
    } catch {
      return false;
    }
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await this.resolveMuseLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      const authFilePath = join(homedir(), ".config", "muse", "auth.json");

      return {
        diagnostic: formatProviderDiagnostic("Muse", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: [launch.command],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          {
            label: "API key (META_API_KEY)",
            value: process.env["META_API_KEY"] ? "set" : "not set",
          },
          {
            label: "Auth file (~/.config/muse/auth.json)",
            value: describeMuseAuthFileState(authFilePath),
          },
        ]),
      };
    } catch (error) {
      this.logger.debug({ err: error }, "Muse diagnostic lookup failed");
      return {
        diagnostic: formatProviderDiagnosticError("Muse", error),
      };
    }
  }

  private resolveMuseLaunch() {
    return resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: MUSE_DEFAULT_BINARY,
    });
  }

  private async spawnSessionHost(
    cwd: string,
    env?: Record<string, string>,
    onStderr?: (chunk: string) => void,
  ) {
    const launch = await this.resolveMuseLaunch();
    const options: MuseHostSpawnOptions = {
      command: launch.command,
      args: [...launch.args, "serve", "--trust-workspace"],
      cwd,
      env: { ...process.env, ...this.runtimeSettings?.env, ...env },
      ...(onStderr ? { onStderr } : {}),
    };
    return this.hostSpawner(options);
  }
}

function requireMuseThinkingOption(value: string): MuseThinkingTier {
  const tier = normalizeMuseThinkingOption(value);
  if (!tier) {
    throw new Error(`Unknown Muse thinking option: ${value}`);
  }
  return tier;
}

const MUSE_APPROVAL_MODES = new Set(["onRequest", "promptUnmatched", "denyUnmatched", "allowAll"]);

export function resolveMuseApprovalMode(modeId: string | undefined): string {
  if (!modeId) {
    return "onRequest";
  }
  if (!MUSE_APPROVAL_MODES.has(modeId)) {
    throw new Error(`Unknown Muse approval mode: ${modeId}`);
  }
  return modeId;
}

function readMetadataString(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readSessionRecord(result: Record<string, unknown>): {
  sessionId: string | null;
  modelId: string | null;
  approvalMode: string | null;
} {
  const session =
    typeof result["session"] === "object" && result["session"] !== null
      ? (result["session"] as Record<string, unknown>)
      : {};
  const sessionId = typeof session["sessionId"] === "string" ? session["sessionId"] : null;
  const modelId = typeof session["modelId"] === "string" ? session["modelId"] : null;
  const approvalModeRecord =
    typeof session["approvalMode"] === "object" && session["approvalMode"] !== null
      ? (session["approvalMode"] as Record<string, unknown>)
      : undefined;
  const approvalMode =
    (approvalModeRecord && typeof approvalModeRecord["mode"] === "string"
      ? approvalModeRecord["mode"]
      : undefined) ?? null;
  return { sessionId, modelId, approvalMode };
}

const MUSE_IMPORTABLE_SESSION_LIMIT = 50;

interface MuseSessionListRow {
  sessionId: string;
  workspaceRoot: string | null;
  title: string | null;
  updatedAt: string | null;
}

function readSessionListPage(payload: unknown): {
  sessions: MuseSessionListRow[];
  nextCursor?: string;
} {
  if (typeof payload !== "object" || payload === null) {
    return { sessions: [] };
  }
  const record = payload as Record<string, unknown>;
  const rows: MuseSessionListRow[] = [];
  if (Array.isArray(record["sessions"])) {
    for (const entry of record["sessions"]) {
      if (typeof entry !== "object" || entry === null) continue;
      const row = entry as Record<string, unknown>;
      if (typeof row["sessionId"] !== "string" || row["sessionId"].length === 0) continue;
      rows.push({
        sessionId: row["sessionId"],
        workspaceRoot: typeof row["workspaceRoot"] === "string" ? row["workspaceRoot"] : null,
        title:
          typeof row["title"] === "string" && row["title"].trim().length > 0 ? row["title"] : null,
        updatedAt: typeof row["updatedAt"] === "string" ? row["updatedAt"] : null,
      });
    }
  }
  const nextCursor = record["nextCursor"];
  return {
    sessions: rows,
    ...(typeof nextCursor === "string" && nextCursor.length > 0 ? { nextCursor } : {}),
  };
}

function mapMuseImportableSession(session: MuseSessionListRow): ImportableProviderSession {
  const parsed = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
  return {
    providerHandleId: session.sessionId,
    cwd: session.workspaceRoot ?? homedir(),
    title: session.title,
    // MSP session/list rows carry no prompt text, and per-session enrichment
    // would pull a full transcript for every candidate.
    firstPromptPreview: null,
    lastPromptPreview: null,
    lastActivityAt: Number.isNaN(parsed) ? new Date(0) : new Date(parsed),
  };
}
