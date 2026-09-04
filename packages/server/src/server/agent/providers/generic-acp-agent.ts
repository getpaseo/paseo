import type { Logger } from "pino";
import { z } from "zod";

import type { AgentCapabilityFlags } from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderTransport,
} from "../provider-launch-config.js";
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
  command?: [string, ...string[]];
  transport?: ProviderTransport;
  authMethodId?: string;
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
}

export class GenericACPAgentClient extends ACPAgentClient {
  private readonly command?: [string, ...string[]];
  private readonly transport?: ProviderTransport;
  private readonly providerId?: string;
  private readonly label?: string;
  private readonly diagnosticPhaseTimeoutMs?: number;

  constructor(options: GenericACPAgentClientOptions) {
    const providerParams = parseGenericACPProviderParams(options.providerParams);
    super({
      provider: "acp",
      logger: options.logger,
      runtimeSettings: {
        env: options.env,
        transport: options.transport,
        authMethodId: options.authMethodId,
      },
      defaultCommand: options.command ?? ["remote-acp"],
      capabilities: buildGenericACPCapabilities(providerParams, options.transport),
      waitForInitialCommands: options.waitForInitialCommands,
      initialCommandsWaitTimeoutMs: options.initialCommandsWaitTimeoutMs,
      clientCapabilities: buildGenericACPClientCapabilities(providerParams, options.transport),
      clientCapabilityMeta: options.clientCapabilityMeta,
      configFeatureOptions: options.configFeatureOptions,
      extensionCommandsParser: options.extensionCommandsParser,
      catalogModelResolver: options.catalogModelResolver,
    });

    this.command = options.command;
    this.transport = options.transport;
    this.providerId = options.providerId;
    this.label = options.label;
    this.diagnosticPhaseTimeoutMs = options.diagnosticPhaseTimeoutMs;
  }

  override async isAvailable(): Promise<boolean> {
    if (this.transport?.type === "websocket") {
      return super.isAvailable();
    }
    const launch = await this.resolveConfiguredLaunch();
    const availability = await checkProviderLaunchAvailable(launch);
    return availability.available;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    const providerName = formatProviderName(this.label, this.providerId);
    const entries: DiagnosticEntry[] = [
      { label: "Provider ID", value: this.providerId ?? "unknown" },
    ];
    if (this.transport?.type === "websocket") {
      const headerAuth =
        Object.keys(this.transport.headers ?? {}).length > 0 ? "Custom headers" : "None";
      entries.push(
        { label: "Transport", value: "WebSocket" },
        { label: "Endpoint", value: formatRemoteEndpoint(this.transport.url) },
        {
          label: "Transport auth",
          value: this.transport.bearerTokenEnv
            ? `Bearer token from ${this.transport.bearerTokenEnv}`
            : headerAuth,
        },
        ...(this.runtimeSettings?.authMethodId
          ? [{ label: "ACP auth method", value: this.runtimeSettings.authMethodId }]
          : []),
        ...(await this.getACPProbeRowsForDiagnostic()),
      );
      return { diagnostic: formatProviderDiagnostic(providerName, entries) };
    }

    if (!this.command) {
      entries.push({ label: "Configured command", value: "missing" });
      return { diagnostic: formatProviderDiagnostic(providerName, entries) };
    }
    entries.push({ label: "Configured command", value: this.command.join(" ") });
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
    if (!this.command) {
      throw new Error("ACP command is not configured");
    }
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

function buildGenericACPCapabilities(
  params: GenericACPProviderParams,
  transport: ProviderTransport | undefined,
): AgentCapabilityFlags {
  return {
    ...DEFAULT_ACP_CAPABILITIES,
    supportsMcpServers:
      params.supportsMcpServers ??
      (transport?.type === "websocket" ? false : DEFAULT_ACP_CAPABILITIES.supportsMcpServers),
  };
}

function buildGenericACPClientCapabilities(
  params: GenericACPProviderParams,
  transport: ProviderTransport | undefined,
): GenericACPProviderParams["clientCapabilities"] {
  if (transport?.type !== "websocket") return params.clientCapabilities;
  return {
    terminal: false,
    ...params.clientCapabilities,
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

function formatRemoteEndpoint(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.search = url.search ? "?redacted" : "";
  url.hash = "";
  return url.toString();
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
