import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { z } from "zod";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentProvider,
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
  type MuseHostSpawner,
  type MuseModelCatalogEntry,
} from "./host.js";

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
    _config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    throw new Error("Muse agent sessions are not implemented yet");
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    throw new Error("Muse agent sessions are not implemented yet");
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    const launch = await this.resolveMuseLaunch();
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
          host = await this.hostSpawner({
            command: launch.command,
            args: [...launch.args, "serve", "--trust-workspace"],
            cwd: options.scope === "global" ? homedir() : options.cwd,
            env: { ...process.env, ...this.runtimeSettings?.env },
            onStderr: (chunk) => {
              stderrChunks.push(chunk);
            },
          });
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
}
