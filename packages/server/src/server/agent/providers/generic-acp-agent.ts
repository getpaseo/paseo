import type { Logger } from "pino";
import { z } from "zod";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type { AgentCapabilityFlags } from "../agent-sdk-types.js";
import { checkProviderLaunchAvailable, resolveProviderLaunch } from "../provider-launch-config.js";
import {
  ACPAgentClient,
  type ACPCatalogModelResolver,
  type ACPClientCapabilityMeta,
  type ACPConfigFeatureOption,
  DEFAULT_ACP_CAPABILITIES,
  type ACPExtensionCommandsParser,
  type ACPNewSessionStarter,
  type ACPProbeSessionCloser,
  type SessionStateResponse,
} from "./acp-agent.js";
import {
  buildBinaryDiagnosticRows,
  formatProviderDiagnostic,
  type DiagnosticEntry,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

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
  clientCapabilities?: GenericACPProviderParams["clientCapabilities"];
  clientCapabilityMeta?: ACPClientCapabilityMeta;
  configFeatureOptions?: ACPConfigFeatureOption[];
  extensionCommandsParser?: ACPExtensionCommandsParser;
  catalogModelResolver?: ACPCatalogModelResolver;
  newSessionStarter?: ACPNewSessionStarter;
  probeSessionCloser?: ACPProbeSessionCloser;
  sessionResponseTransformer?: (response: SessionStateResponse) => SessionStateResponse;
  configOptionsTransformer?: (configOptions: SessionConfigOption[]) => SessionConfigOption[];
  modeIdTransformer?: (modeId: string) => string | null;
}

export class GenericACPAgentClient extends ACPAgentClient {
  private readonly command: [string, ...string[]];
  private readonly providerId?: string;
  private readonly label?: string;
  private readonly diagnosticPhaseTimeoutMs?: number;

  constructor(options: GenericACPAgentClientOptions) {
    const providerParams = parseGenericACPProviderParams(options.providerParams);
    const clientCapabilities = mergeGenericACPClientCapabilities(
      options.clientCapabilities,
      providerParams.clientCapabilities,
    );
    super({
      provider: "acp",
      logger: options.logger,
      runtimeSettings: {
        env: options.env,
      },
      defaultCommand: options.command,
      capabilities: buildGenericACPCapabilities(providerParams),
      ...(options.waitForInitialCommands !== undefined
        ? { waitForInitialCommands: options.waitForInitialCommands }
        : {}),
      ...(options.initialCommandsWaitTimeoutMs !== undefined
        ? { initialCommandsWaitTimeoutMs: options.initialCommandsWaitTimeoutMs }
        : {}),
      ...(clientCapabilities ? { clientCapabilities } : {}),
      ...(options.clientCapabilityMeta
        ? { clientCapabilityMeta: options.clientCapabilityMeta }
        : {}),
      ...(options.configFeatureOptions
        ? { configFeatureOptions: options.configFeatureOptions }
        : {}),
      ...(options.extensionCommandsParser
        ? { extensionCommandsParser: options.extensionCommandsParser }
        : {}),
      ...(options.catalogModelResolver
        ? { catalogModelResolver: options.catalogModelResolver }
        : {}),
      ...(options.sessionResponseTransformer
        ? { sessionResponseTransformer: options.sessionResponseTransformer }
        : {}),
      ...(options.configOptionsTransformer
        ? { configOptionsTransformer: options.configOptionsTransformer }
        : {}),
      ...(options.modeIdTransformer ? { modeIdTransformer: options.modeIdTransformer } : {}),
      ...(options.newSessionStarter ? { newSessionStarter: options.newSessionStarter } : {}),
      ...(options.probeSessionCloser ? { probeSessionCloser: options.probeSessionCloser } : {}),
    });

    this.command = options.command;
    this.providerId = options.providerId;
    this.label = options.label;
    this.diagnosticPhaseTimeoutMs = options.diagnosticPhaseTimeoutMs;
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

function mergeGenericACPClientCapabilities(
  defaults: GenericACPProviderParams["clientCapabilities"],
  overrides: GenericACPProviderParams["clientCapabilities"],
): GenericACPProviderParams["clientCapabilities"] {
  if (!defaults && !overrides) {
    return undefined;
  }

  return {
    ...defaults,
    ...overrides,
    ...(defaults?.fs || overrides?.fs
      ? {
          fs: {
            ...defaults?.fs,
            ...overrides?.fs,
          },
        }
      : {}),
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
