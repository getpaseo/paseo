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
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
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
      return new MuseAgentSession({
        host,
        sessionId: session.sessionId,
        config,
        capabilities: this.capabilities,
        modelId: session.modelId ?? config.model ?? null,
        modeId: session.approvalMode ?? approvalMode,
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
      const config: AgentSessionConfig = {
        provider: this.provider,
        cwd,
        ...(model ? { model } : {}),
        modeId,
      };
      return new MuseAgentSession({
        host,
        sessionId: session.sessionId,
        config,
        capabilities: this.capabilities,
        modelId: config.model ?? session.modelId ?? null,
        modeId,
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
