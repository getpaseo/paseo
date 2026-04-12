import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";

import type { AgentCapabilityFlags, AgentMode, AgentModelDefinition } from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { findExecutable } from "../../../utils/executable.js";
import { ACPAgentClient } from "./acp-agent.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const HERMES_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

const HERMES_MODES: AgentMode[] = [];

const DEFAULT_HERMES_HOME = join(homedir(), ".hermes");
type HermesProfileDefaults = {
  hermesHome: string;
  modelId: string | null;
  provider: string | null;
};

type HermesACPAgentClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

function parseTopLevelModelDefaults(configPath: string): { modelId: string | null; provider: string | null } {
  if (!existsSync(configPath)) {
    return { modelId: null, provider: null };
  }

  const lines = readFileSync(configPath, "utf8").split(/\r?\n/);
  let inModel = false;
  let modelIndent = 0;
  let modelId: string | null = null;
  let provider: string | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\t/g, "    ");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const indent = line.length - line.trimStart().length;
    if (!inModel) {
      if (trimmed === "model:") {
        inModel = true;
        modelIndent = indent;
      }
      continue;
    }

    if (indent <= modelIndent) {
      break;
    }

    const match = trimmed.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!match) {
      continue;
    }
    const [, key, valueRaw] = match;
    const value = valueRaw.trim().replace(/^['"]|['"]$/g, "");
    if (key === "default" && value) {
      modelId = value;
    } else if (key === "provider" && value) {
      provider = value;
    }
  }

  return { modelId, provider };
}

function resolveHermesProfileDefaults(explicitHermesHome?: string | null): HermesProfileDefaults {
  const hermesHome = explicitHermesHome?.trim() || DEFAULT_HERMES_HOME;
  const configPath = join(hermesHome, "config.yaml");
  const parsed = parseTopLevelModelDefaults(configPath);
  return {
    hermesHome,
    modelId: parsed.modelId,
    provider: parsed.provider,
  };
}

function buildSyntheticModel(providerId: string, defaults: HermesProfileDefaults): AgentModelDefinition[] {
  if (!defaults.modelId) {
    return [];
  }

  const label = defaults.provider ? `${defaults.modelId} (${defaults.provider})` : defaults.modelId;
  return [
    {
      provider: providerId,
      id: defaults.modelId,
      label,
      description: `Default model from ${defaults.hermesHome}/config.yaml`,
      isDefault: true,
      metadata: {
        source: "hermes-profile-default",
        hermesHome: defaults.hermesHome,
      },
    },
  ];
}

function mergeRuntimeSettings(
  runtimeSettings: ProviderRuntimeSettings | undefined,
  defaultEnv?: Record<string, string>,
): ProviderRuntimeSettings | undefined {
  if (!runtimeSettings && !defaultEnv) {
    return undefined;
  }
  return {
    ...(runtimeSettings ?? {}),
    env: {
      ...(defaultEnv ?? {}),
      ...(runtimeSettings?.env ?? {}),
    },
  };
}

export class HermesACPAgentClient extends ACPAgentClient {
  private readonly profileDefaults: HermesProfileDefaults;
  private readonly binaryName = "hermes";
  private readonly displayName = "Hermes";

  constructor(options: HermesACPAgentClientOptions) {
    const mergedRuntimeSettings = mergeRuntimeSettings(options.runtimeSettings, {
      HERMES_HOME: DEFAULT_HERMES_HOME,
    });
    const effectiveHermesHome = mergedRuntimeSettings?.env?.HERMES_HOME ?? DEFAULT_HERMES_HOME;
    const profileDefaults = resolveHermesProfileDefaults(effectiveHermesHome);
    super({
      provider: "hermes",
      logger: options.logger,
      runtimeSettings: mergedRuntimeSettings,
      defaultCommand: ["hermes", "acp"],
      defaultModes: HERMES_MODES,
      capabilities: HERMES_CAPABILITIES,
    });
    this.profileDefaults = profileDefaults;
  }

  override async listModels(): Promise<AgentModelDefinition[]> {
    return buildSyntheticModel(this.provider, this.profileDefaults);
  }

  override async listModes(): Promise<AgentMode[]> {
    return [];
  }

  override async isAvailable(): Promise<boolean> {
    return super.isAvailable();
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const available = await this.isAvailable();
      const resolvedBinary = await findExecutable(this.binaryName);
      const models = await this.listModels().catch((error) => {
        throw new Error(`model discovery failed: ${toDiagnosticErrorMessage(error)}`);
      });
      const modelValue =
        models.length > 0 ? models.map((model) => model.id).join(", ") : "No profile default model found";
      return {
        diagnostic: formatProviderDiagnostic(this.displayName, [
          { label: "Binary", value: resolvedBinary ?? "not found" },
          {
            label: "Version",
            value: resolvedBinary ? await resolveBinaryVersion(resolvedBinary) : "unknown",
          },
          { label: "Hermes home", value: this.profileDefaults.hermesHome },
          { label: "Models", value: modelValue },
          { label: "Status", value: formatDiagnosticStatus(available) },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError(this.displayName, error),
      };
    }
  }
}


