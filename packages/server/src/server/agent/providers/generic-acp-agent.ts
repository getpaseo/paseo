import { homedir } from "node:os";
import type { Logger } from "pino";

import type { AgentProvider } from "../agent-sdk-types.js";
import { checkProviderLaunchAvailable, resolveProviderLaunch } from "../provider-launch-config.js";
import {
  ACPAgentClient,
  deriveModelDefinitionsFromACP,
  deriveModesFromACP,
  type SessionStateResponse,
} from "./acp-agent.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  buildBinaryDiagnosticRows,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const ACP_DIAGNOSTIC_INITIALIZE_TIMEOUT_MS = 8_000;
const ACP_DIAGNOSTIC_SESSION_TIMEOUT_MS = 8_000;

interface GenericACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  waitForInitialCommands?: boolean;
  initialCommandsWaitTimeoutMs?: number;
}

export class GenericACPAgentClient extends ACPAgentClient {
  private readonly command: [string, ...string[]];
  private readonly providerId?: string;
  private readonly label?: string;

  constructor(options: GenericACPAgentClientOptions) {
    super({
      provider: "acp",
      logger: options.logger,
      runtimeSettings: {
        env: options.env,
      },
      defaultCommand: options.command,
      waitForInitialCommands: options.waitForInitialCommands,
      initialCommandsWaitTimeoutMs: options.initialCommandsWaitTimeoutMs,
    });

    this.command = options.command;
    this.providerId = options.providerId;
    this.label = options.label;
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

    try {
      const launch = await this.resolveConfiguredLaunch();
      const availability = await checkProviderLaunchAvailable(launch);
      const available = availability.available;
      const versionProbe = buildVersionProbeCommand(this.command);
      const probeResult = available
        ? await this.runDiagnosticACPProbe()
        : {
            status: formatDiagnosticStatus(false),
            initialize: "Not checked",
            session: "Not checked",
            models: "Not checked",
            modes: "Not checked",
          };

      return {
        diagnostic: formatProviderDiagnostic(providerName, [
          { label: "Provider ID", value: this.providerId ?? "unknown" },
          { label: "Configured command", value: this.command.join(" ") },
          ...(await buildBinaryDiagnosticRows(launch, availability, {
            binaryLabel: "Launcher binary",
            versionCommand: {
              command: versionProbe.command,
              args: versionProbe.args,
              env: this.runtimeSettings?.env,
            },
          })),
          {
            label: "Version command",
            value: formatCommand(versionProbe.command, versionProbe.args),
          },
          { label: "ACP initialize", value: probeResult.initialize },
          { label: "ACP session/new", value: probeResult.session },
          { label: "Models", value: probeResult.models },
          { label: "Modes", value: probeResult.modes },
          { label: "Status", value: probeResult.status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError(providerName, error),
      };
    }
  }

  private async resolveConfiguredLaunch() {
    return resolveProviderLaunch({
      commandConfig: { mode: "replace", argv: this.command },
      defaultBinary: this.command[0],
    });
  }

  private async runDiagnosticACPProbe(): Promise<ACPDiagnosticProbeResult> {
    let initializeValue = "Not checked";
    let sessionValue = "Not checked";

    try {
      const probe = await this.spawnProcess(
        {
          NO_BROWSER: "true",
          NO_OPEN_BROWSER: "1",
          GEMINI_CLI_NO_BROWSER: "true",
          CI: "1",
        },
        {
          initializeTimeoutMs: ACP_DIAGNOSTIC_INITIALIZE_TIMEOUT_MS,
        },
      );
      try {
        initializeValue = formatInitializeResult(probe.initialize);
        const response = await withTimeout(
          probe.connection.newSession({
            cwd: homedir(),
            mcpServers: [],
          }),
          ACP_DIAGNOSTIC_SESSION_TIMEOUT_MS,
          "ACP session/new",
        );
        sessionValue = response.sessionId ? `ok (${response.sessionId})` : "ok";
        const transformed = this.transformSessionResponse(response);
        return {
          status: formatDiagnosticStatus(true),
          initialize: initializeValue,
          session: sessionValue,
          ...summarizeSessionState(this.provider, transformed),
        };
      } finally {
        await this.closeProbe(probe);
      }
    } catch (error) {
      return {
        status: formatDiagnosticStatus(true, {
          source: "ACP probe",
          cause: error,
        }),
        initialize: formatProbeError(initializeValue, error),
        session:
          initializeValue === "Not checked" ? "Not checked" : formatProbeError(sessionValue, error),
        models: "Not checked",
        modes: "Not checked",
      };
    }
  }
}

interface ACPDiagnosticProbeResult {
  status: string;
  initialize: string;
  session: string;
  models: string;
  modes: string;
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

function formatInitializeResult(initialize: {
  protocolVersion: number;
  agentInfo?: unknown;
}): string {
  const agentInfo = isAgentInfo(initialize.agentInfo)
    ? `${initialize.agentInfo.name}${initialize.agentInfo.version ? ` ${initialize.agentInfo.version}` : ""}`
    : "ok";
  return `ok (protocol ${initialize.protocolVersion}, ${agentInfo})`;
}

function isAgentInfo(value: unknown): value is { name: string; version?: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof Reflect.get(value, "name") === "string"
  );
}

function summarizeSessionState(
  provider: AgentProvider,
  response: SessionStateResponse,
): Pick<ACPDiagnosticProbeResult, "models" | "modes"> {
  const models = deriveModelDefinitionsFromACP(provider, response.models, response.configOptions);
  const { modes } = deriveModesFromACP([], response.modes, response.configOptions);
  return {
    models: `${models.length}`,
    modes:
      modes.length > 0 ? modes.map((mode) => mode.label || mode.id).join(", ") : "none reported",
  };
}

function formatProbeError(currentValue: string, error: unknown): string {
  if (currentValue !== "Not checked") {
    return currentValue;
  }
  return `Error - ${toDiagnosticErrorMessage(error)}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}
