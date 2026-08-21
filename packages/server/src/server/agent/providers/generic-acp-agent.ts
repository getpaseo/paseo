import type { Logger } from "pino";
import { z } from "zod";

import type {
  AgentCapabilityFlags,
  AgentFeature,
  AgentLaunchContext,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
  ImportableProviderSession,
  ListImportableSessionsOptions,
  ProviderCatalog,
  ProviderRefreshContext,
} from "../agent-sdk-types.js";
import { checkProviderLaunchAvailable, resolveProviderLaunch } from "../provider-launch-config.js";
import {
  ACPAgentClient,
  type ACPCatalogModelResolver,
  type ACPClientCapabilityMeta,
  type ACPConfigFeatureOption,
  DEFAULT_ACP_CAPABILITIES,
  type ACPExtensionCommandsParser,
} from "./acp-agent.js";
import {
  buildBinaryDiagnosticRows,
  formatProviderDiagnostic,
  type DiagnosticEntry,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";
import { HermesCliProfileCommand, HermesProfileManager } from "./hermes-profile-manager.js";

export const GenericACPProviderParamsSchema = z
  .object({
    supportsMcpServers: z.boolean().optional(),
    clientCapabilities: z
      .object({
        fs: z
          .object({
            readTextFile: z.boolean().optional(),
            writeTextFile: z.boolean().optional(),
          })
          .optional(),
        terminal: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

type GenericACPProviderParams = z.infer<typeof GenericACPProviderParamsSchema>;

interface GenericACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
  waitForInitialCommands?: boolean;
  initialCommandsWaitTimeoutMs?: number;
  diagnosticPhaseTimeoutMs?: number;
  clientCapabilityMeta?: ACPClientCapabilityMeta;
  configFeatureOptions?: ACPConfigFeatureOption[];
  extensionCommandsParser?: ACPExtensionCommandsParser;
  catalogModelResolver?: ACPCatalogModelResolver;
  hermesProfileManager?: Pick<HermesProfileManager, "prepare"> &
    Partial<Pick<HermesProfileManager, "delete">>;
}

export class GenericACPAgentClient extends ACPAgentClient {
  private readonly command: [string, ...string[]];
  private readonly providerId?: string;
  private readonly label?: string;
  private readonly diagnosticPhaseTimeoutMs?: number;
  private readonly hermesProfileManager?: Pick<HermesProfileManager, "prepare"> &
    Partial<Pick<HermesProfileManager, "delete">>;
  private probeProfileReady?: Promise<void>;

  constructor(options: GenericACPAgentClientOptions) {
    const providerParams = parseGenericACPProviderParams(options.providerParams);
    super({
      provider: "acp",
      logger: options.logger,
      runtimeSettings: {
        env: options.env,
      },
      defaultCommand: options.command,
      capabilities: buildGenericACPCapabilities(providerParams),
      waitForInitialCommands: options.waitForInitialCommands,
      initialCommandsWaitTimeoutMs: options.initialCommandsWaitTimeoutMs,
      clientCapabilities: providerParams.clientCapabilities,
      clientCapabilityMeta: options.clientCapabilityMeta,
      configFeatureOptions: options.configFeatureOptions,
      extensionCommandsParser: options.extensionCommandsParser,
      catalogModelResolver: options.catalogModelResolver,
    });

    this.command = options.command;
    this.providerId = options.providerId;
    this.label = options.label;
    this.diagnosticPhaseTimeoutMs = options.diagnosticPhaseTimeoutMs;
    this.hermesProfileManager =
      options.hermesProfileManager ??
      (options.providerId === "hermes"
        ? new HermesProfileManager({
            command: new HermesCliProfileCommand({
              executable: options.command[0],
              env: options.env,
            }),
          })
        : undefined);
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return super.createSession(config, await this.scopeHermesLaunchContext(launchContext));
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    return super.resumeSession(
      handle,
      overrides,
      await this.scopeHermesLaunchContext(launchContext, handle.sessionId),
    );
  }

  async deleteAgentResources(agentId: string): Promise<void> {
    if (!this.hermesProfileManager) return;
    if (!this.hermesProfileManager.delete) {
      throw new Error("Hermes profile isolation cannot delete provider-owned resources");
    }
    await this.hermesProfileManager.delete(agentId);
  }

  override async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    await this.ensureHermesProbeProfile();
    return super.fetchCatalog(options, context);
  }

  override async listFeatures(config: AgentSessionConfig): Promise<AgentFeature[]> {
    await this.ensureHermesProbeProfile();
    return super.listFeatures(config);
  }

  override async listImportableSessions(
    options?: ListImportableSessionsOptions,
  ): Promise<ImportableProviderSession[]> {
    await this.ensureHermesProbeProfile();
    return super.listImportableSessions(options);
  }

  protected override async resolveLaunchCommand(): Promise<{ command: string; args: string[] }> {
    return {
      command: this.command[0],
      args: this.command.slice(1),
    };
  }

  override async isAvailable(): Promise<boolean> {
    const launch = await this.resolveConfiguredLaunch();
    const availability = await checkProviderLaunchAvailable(launch);
    return availability.available;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    await this.ensureHermesProbeProfile();
    const providerName = formatProviderName(this.label, this.providerId);
    const entries: DiagnosticEntry[] = [
      { label: "Provider ID", value: this.providerId ?? "unknown" },
      { label: "Configured command", value: this.command.join(" ") },
    ];
    const versionProbe = buildVersionProbeCommand(this.command);

    try {
      const launch = await this.resolveConfiguredLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      entries.push(
        ...(await buildBinaryDiagnosticRows(launch, availability, {
          binaryLabel: "Launcher binary",
          versionCommand: {
            command: versionProbe.command,
            args: versionProbe.args,
            env: this.runtimeSettings?.env,
          },
        })),
      );
    } catch (error) {
      entries.push({
        label: "Launcher binary",
        value: `error: ${toDiagnosticErrorMessage(error)}`,
      });
    }

    entries.push(
      {
        label: "Version command",
        value: formatCommand(versionProbe.command, versionProbe.args),
      },
      ...(await this.getACPProbeRowsForDiagnostic()),
    );

    return {
      diagnostic: formatProviderDiagnostic(providerName, entries),
    };
  }

  private async resolveConfiguredLaunch() {
    return resolveProviderLaunch({
      commandConfig: { mode: "replace", argv: this.command },
      defaultBinary: this.command[0],
    });
  }

  private async scopeHermesLaunchContext(
    launchContext?: AgentLaunchContext,
    runtimeSessionId?: string,
  ): Promise<AgentLaunchContext | undefined> {
    if (!this.hermesProfileManager) return launchContext;
    const agentId = launchContext?.agentId?.trim();
    if (!agentId) {
      throw new Error("Hermes profile isolation requires a Paseo agent ID");
    }

    const assignment = await this.hermesProfileManager.prepare(agentId, {
      includeRuntimeState: runtimeSessionId !== undefined,
      ...(runtimeSessionId === undefined ? {} : { runtimeSessionId }),
    });
    return {
      ...launchContext,
      env: {
        ...launchContext?.env,
        HERMES_HOME: assignment.home,
        HERMES_PROFILE: assignment.profile,
      },
    };
  }

  private async ensureHermesProbeProfile(): Promise<void> {
    if (!this.hermesProfileManager) return;
    this.probeProfileReady ??= this.hermesProfileManager
      .prepare("__paseo_provider_probe__")
      .then((assignment) => {
        if (!this.runtimeSettings) {
          throw new Error("Hermes profile isolation requires provider runtime settings");
        }
        this.runtimeSettings.env = {
          ...this.runtimeSettings.env,
          HERMES_HOME: assignment.home,
          HERMES_PROFILE: assignment.profile,
        };
        return undefined;
      });
    await this.probeProfileReady;
  }

  private async getACPProbeRowsForDiagnostic() {
    try {
      return await this.buildACPProbeDiagnosticRows({
        phaseTimeoutMs: this.diagnosticPhaseTimeoutMs,
      });
    } catch (error) {
      return [
        {
          label: "ACP probe",
          value: `error: ${toDiagnosticErrorMessage(error)}`,
        },
      ];
    }
  }
}

function buildGenericACPCapabilities(params: GenericACPProviderParams): AgentCapabilityFlags {
  return {
    ...DEFAULT_ACP_CAPABILITIES,
    supportsMcpServers: params.supportsMcpServers ?? DEFAULT_ACP_CAPABILITIES.supportsMcpServers,
  };
}

function parseGenericACPProviderParams(params: unknown): GenericACPProviderParams {
  return GenericACPProviderParamsSchema.parse(params ?? {});
}

export interface CommandInvocation {
  command: string;
  args: string[];
}

function formatProviderName(label: string | undefined, providerId: string | undefined): string {
  if (label) {
    return `${label} (ACP)`;
  }
  if (providerId) {
    return `${providerId} (ACP)`;
  }
  return "Custom ACP";
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

export function buildVersionProbeCommand(command: [string, ...string[]]): CommandInvocation {
  const [launcher, ...args] = command;
  if (isPackageRunner(launcher)) {
    return {
      command: launcher,
      args: [...takePackageRunnerPrefix(args), "--version"],
    };
  }

  return {
    command: launcher,
    args: ["--version"],
  };
}

function isPackageRunner(command: string): boolean {
  return ["npx", "bunx", "pnpm", "uvx"].includes(command);
}

function takePackageRunnerPrefix(args: string[]): string[] {
  if (args.length === 0) {
    return [];
  }
  if (args[0] === "dlx") {
    return ["dlx", ...takePackageSpecPrefix(args.slice(1))];
  }
  return takePackageSpecPrefix(args);
}

function takePackageSpecPrefix(args: string[]): string[] {
  const prefix: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    prefix.push(arg);
    if (arg === "--package" || arg === "-p") {
      if (args[index + 1]) {
        prefix.push(args[index + 1]);
        index += 1;
      }
      continue;
    }
    if (!arg.startsWith("-")) {
      break;
    }
  }
  return prefix;
}
