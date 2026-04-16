import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "pino";

import type {
  AgentCapabilityFlags,
  AgentLaunchContext,
  AgentMetadata,
  AgentMode,
  AgentModelDefinition,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  ListModelsOptions,
} from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { findExecutable } from "../../../utils/executable.js";
import { ACPAgentClient, ACPAgentSession } from "./acp-agent.js";
import { listDroidSlashCommands } from "./droid-slash-commands.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const execFileAsync = promisify(execFile);

const DROID_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const DROID_MODES: AgentMode[] = [];

type DroidACPAgentClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

type DroidReasoningEntry = {
  defaultThinkingOptionId: string | null;
  thinkingOptions: NonNullable<AgentModelDefinition["thinkingOptions"]>;
};

const DROID_REASONING_LINE_RE =
  /^-\s+(?<label>.+?):\s+supports reasoning:\s+(?<supports>yes|no);\s+supported:\s+\[(?<supported>[^\]]*)\];\s+default:\s+(?<default>.+)$/i;

let droidReasoningCache: Promise<Map<string, DroidReasoningEntry>> | null = null;

function coerceDroidSessionConfigMetadata(
  metadata: AgentMetadata | undefined,
): Partial<AgentSessionConfig> {
  if (!metadata || typeof metadata !== "object") {
    return {};
  }
  return metadata as Partial<AgentSessionConfig>;
}

function normalizeDroidThinkingOptionId(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function parseThinkingList(raw: string): string[] {
  const ids = raw
    .split(",")
    .map((entry) => normalizeDroidThinkingOptionId(entry))
    .filter((entry): entry is string => entry !== null);
  return Array.from(new Set(ids));
}

export function parseDroidExecHelpReasoningMap(helpText: string): Map<string, DroidReasoningEntry> {
  const result = new Map<string, DroidReasoningEntry>();
  const modelDetailsIndex = helpText.indexOf("Model details:");
  if (modelDetailsIndex === -1) {
    return result;
  }

  const modelDetailsSection = helpText.slice(modelDetailsIndex + "Model details:".length);
  for (const rawLine of modelDetailsSection.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("- ")) {
      continue;
    }

    const match = line.match(DROID_REASONING_LINE_RE);
    if (!match?.groups?.label) {
      continue;
    }

    const label = match.groups.label.trim();
    const supportedIds = parseThinkingList(match.groups.supported ?? "");
    const defaultThinkingOptionId = normalizeDroidThinkingOptionId(match.groups.default ?? null);
    const thinkingOptions = supportedIds.map((id) => ({
      id,
      label: id,
      isDefault: id === defaultThinkingOptionId,
    }));

    result.set(label, {
      defaultThinkingOptionId,
      thinkingOptions,
    });
  }

  return result;
}

function annotateDroidModels(
  models: AgentModelDefinition[],
  reasoningMap: Map<string, DroidReasoningEntry>,
): AgentModelDefinition[] {
  return models.map((model) => {
    const reasoning = reasoningMap.get(model.label);
    if (!reasoning || reasoning.thinkingOptions.length === 0) {
      return model;
    }

    return {
      ...model,
      thinkingOptions: reasoning.thinkingOptions,
      defaultThinkingOptionId:
        reasoning.defaultThinkingOptionId ??
        reasoning.thinkingOptions.find((option) => option.isDefault)?.id ??
        reasoning.thinkingOptions[0]?.id,
      metadata: {
        ...(model.metadata ?? {}),
        defaultReasoningEffort: reasoning.defaultThinkingOptionId,
        supportedReasoningEfforts: reasoning.thinkingOptions.map((option) => option.id),
      },
    };
  });
}

async function getDroidReasoningMetadata(): Promise<Map<string, DroidReasoningEntry>> {
  if (!droidReasoningCache) {
    droidReasoningCache = (async () => {
      const resolvedBinary = await findExecutable("droid");
      if (!resolvedBinary) {
        return new Map<string, DroidReasoningEntry>();
      }

      const { stdout } = await execFileAsync(resolvedBinary, ["exec", "--help"], {
        maxBuffer: 1024 * 1024,
      });
      return parseDroidExecHelpReasoningMap(stdout);
    })().catch(() => new Map<string, DroidReasoningEntry>());
  }

  return droidReasoningCache;
}

export function buildDroidDefaultCommand(
  baseCommand: readonly [string, ...string[]],
  config: Pick<AgentSessionConfig, "modeId" | "model" | "thinkingOptionId">,
): [string, ...string[]] {
  const command = [...baseCommand];
  const normalizedMode = config.modeId?.trim() ?? "";
  const normalizedModel = config.model?.trim() ?? "";
  const normalizedThinking = normalizeDroidThinkingOptionId(config.thinkingOptionId);

  if (normalizedMode === "spec") {
    command.push("--use-spec");
  } else if (normalizedMode === "auto-low") {
    command.push("--auto", "low");
  } else if (normalizedMode === "auto-medium") {
    command.push("--auto", "medium");
  } else if (normalizedMode === "auto-high") {
    command.push("--auto", "high");
  }

  if (normalizedModel) {
    command.push("--model", normalizedModel);
  }

  if (normalizedThinking) {
    command.push("--reasoning-effort", normalizedThinking);
  }

  return command as [string, ...string[]];
}

function wrapDroidSession(
  session: AgentSession,
  config: Pick<AgentSessionConfig, "cwd" | "thinkingOptionId">,
): AgentSession {
  let commandsPromise: Promise<AgentSlashCommand[]> | null = null;
  const cwd = config.cwd;
  const configuredThinkingOptionId = normalizeDroidThinkingOptionId(config.thinkingOptionId);

  return new Proxy(session, {
    get(target, prop, receiver) {
      if (prop === "listCommands") {
        return async () => {
          if (!commandsPromise) {
            commandsPromise = (async () => {
              const providerCommands = target.listCommands ? await target.listCommands() : [];
              return listDroidSlashCommands(cwd, providerCommands);
            })();
          }
          return commandsPromise;
        };
      }

      if (prop === "getRuntimeInfo") {
        return async () => {
          const runtimeInfo = await target.getRuntimeInfo();
          return {
            ...runtimeInfo,
            thinkingOptionId: runtimeInfo.thinkingOptionId ?? configuredThinkingOptionId,
          };
        };
      }

      if (prop === "setThinkingOption") {
        return async () => {
          throw new Error(
            "Droid reasoning effort can only be set when creating or resuming a session.",
          );
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export class DroidACPAgentClient extends ACPAgentClient {
  constructor(options: DroidACPAgentClientOptions) {
    super({
      provider: "droid",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: ["droid", "exec", "--output-format", "acp"],
      defaultModes: DROID_MODES,
      capabilities: DROID_CAPABILITIES,
    });
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }

  override async listModels(options?: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const [models, reasoningMap] = await Promise.all([
      super.listModels(options),
      getDroidReasoningMetadata(),
    ]);
    return annotateDroidModels(models, reasoningMap);
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = new ACPAgentSession(
      { ...config, provider: this.provider },
      {
        provider: this.provider,
        logger: this.logger,
        runtimeSettings: this.runtimeSettings,
        defaultCommand: buildDroidDefaultCommand(this.defaultCommand, config),
        defaultModes: this.defaultModes,
        capabilities: this.capabilities,
        launchEnv: launchContext?.env,
      },
    );
    await session.initializeNewSession();
    return wrapDroidSession(session, config);
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    if (handle.provider !== this.provider) {
      throw new Error(`Cannot resume ${handle.provider} handle with ${this.provider} provider`);
    }

    const storedConfig = coerceDroidSessionConfigMetadata(handle.metadata);
    const storedCwd = storedConfig.cwd?.trim() ? storedConfig.cwd : null;
    const mergedConfig: AgentSessionConfig = {
      ...storedConfig,
      ...overrides,
      provider: this.provider,
      cwd: overrides?.cwd ?? storedCwd ?? process.cwd(),
    };

    const session = new ACPAgentSession(mergedConfig, {
      provider: this.provider,
      logger: this.logger,
      runtimeSettings: this.runtimeSettings,
      defaultCommand: buildDroidDefaultCommand(this.defaultCommand, mergedConfig),
      defaultModes: this.defaultModes,
      capabilities: this.capabilities,
      handle,
      launchEnv: launchContext?.env,
    });
    await session.initializeResumedSession();
    return wrapDroidSession(session, {
      cwd: mergedConfig.cwd,
      thinkingOptionId: mergedConfig.thinkingOptionId,
    });
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const resolvedBinary = await findExecutable("droid");
      let modelsValue = "Not checked";
      let status = formatDiagnosticStatus(available);

      if (available) {
        try {
          const models = await this.listModels();
          modelsValue = String(models.length);
        } catch (error) {
          modelsValue = `Error - ${toDiagnosticErrorMessage(error)}`;
          status = formatDiagnosticStatus(available, {
            source: "model fetch",
            cause: error,
          });
        }

        if (!modelsValue.startsWith("Error -")) {
          try {
            await this.listModes();
          } catch (error) {
            status = formatDiagnosticStatus(available, {
              source: "mode fetch",
              cause: error,
            });
          }
        }
      }

      return {
        diagnostic: formatProviderDiagnostic("Droid", [
          {
            label: "Binary",
            value: resolvedBinary ?? "not found",
          },
          {
            label: "Version",
            value: resolvedBinary ? await resolveBinaryVersion(resolvedBinary) : "unknown",
          },
          { label: "Models", value: modelsValue },
          { label: "Status", value: status },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Droid", error),
      };
    }
  }
}
