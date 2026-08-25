import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentCreateSessionOptions,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentResumeSessionOptions,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderRefreshContext,
} from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  createProviderEnvSpec,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { execCommand } from "../../../utils/spawn.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const OPENCODE_V2_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsSessionListing: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
  supportsRewindConversation: false,
  supportsRewindFiles: false,
  supportsRewindBoth: true,
};

export class OpenCodeV2AgentClient implements AgentClient {
  readonly provider = "opencode-v2" as const;
  readonly capabilities = OPENCODE_V2_CAPABILITIES;

  private readonly runtimeSettings?: ProviderRuntimeSettings;

  constructor(
    _logger: Logger,
    runtimeSettings?: ProviderRuntimeSettings,
    _deps: { managedProcesses?: unknown } = {},
  ) {
    this.runtimeSettings = runtimeSettings;
  }

  async createSession(
    _config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    throw new Error("OpenCodeV2 createSession is not implemented yet");
  }

  async resumeSession(
    _handle: AgentPersistenceHandle,
    _overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
    _options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    throw new Error("OpenCodeV2 resumeSession is not implemented yet");
  }

  async fetchCatalog(
    _options: FetchCatalogOptions,
    _context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    // Scaffold: no runtime discovery yet. The catalog/modes feature replaces
    // this with a real probe of the opencode2 `/api/model` + `/api/agent`.
    // Returning an empty catalog keeps the provider "ready" in snapshots.
    return { models: [], modes: [] };
  }

  async isAvailable(_signal?: AbortSignal): Promise<boolean> {
    const launch = await resolveProviderLaunch({
      commandConfig: this.runtimeSettings?.command,
      defaultBinary: "opencode2",
    });
    const availability = await checkProviderLaunchAvailable(launch);
    return availability.available;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: "opencode2",
      });
      const availability = await checkProviderLaunchAvailable(launch);

      let authValue = "Not checked";
      const authCommand = availability.available
        ? (availability.resolvedPath ?? launch.command)
        : null;
      if (authCommand) {
        try {
          const { stdout, stderr } = await execCommand(
            authCommand,
            [...launch.args, "auth", "list"],
            {
              ...createProviderEnvSpec(),
              timeout: 5_000,
            },
          );
          const text = (stdout.trim() || stderr.trim()).trim();
          authValue = text ? `\n    ${text.replace(/\n/g, "\n    ")}` : "(empty)";
        } catch (error) {
          authValue = `Error - ${toDiagnosticErrorMessage(error)}`;
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("OpenCode 2", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["opencode2"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
          { label: "Auth", value: authValue },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("OpenCode 2", error),
      };
    }
  }

  async shutdown(): Promise<void> {
    // Scaffold: no server-managed processes yet. The server-manager feature
    // owns ref-counted process shutdown.
  }
}
