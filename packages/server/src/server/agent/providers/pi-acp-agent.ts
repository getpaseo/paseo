import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import type { ClientSideConnection, SessionConfigOption, ToolKind } from "@agentclientprotocol/sdk";

import type {
  AgentLaunchContext,
  AgentCapabilityFlags,
  AgentFeature,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSession,
  AgentSessionConfig,
  AgentSlashCommand,
  AgentStreamEvent,
  AgentFeatureSelect,
} from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { findExecutable, isCommandAvailable } from "../../../utils/executable.js";
import { ACPAgentClient, type ACPToolSnapshot, type SessionStateResponse } from "./acp-agent.js";
import {
  formatDiagnosticStatus,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  resolveBinaryVersion,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

const require = createRequire(import.meta.url);
const resolvedPiAcpPath = require.resolve("pi-acp");

const PI_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: true,
  supportsMcpServers: false,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

// Pi tool kind corrections: pi-acp maps 'bash' to kind 'other' instead of 'execute'.
const PI_TOOL_KIND_MAP: Record<string, ToolKind> = {
  bash: "execute",
};

type PiACPAgentClientOptions = {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
};

function normalizePiModelLabel(label: string): string {
  return label.trim().replace(/[_\s]+/g, " ");
}

export function transformPiModels(models: AgentModelDefinition[]): AgentModelDefinition[] {
  return models.map((model) => {
    if (!model.label.includes("/")) {
      return model;
    }

    const segments = model.label.split("/").filter((segment) => segment.length > 0);
    const rawLabel = segments.at(-1);
    if (!rawLabel) {
      return model;
    }

    return {
      ...model,
      label: normalizePiModelLabel(rawLabel),
      description: model.description ?? model.label,
    };
  });
}

function transformPiToolSnapshot(snapshot: ACPToolSnapshot): ACPToolSnapshot {
  if (snapshot.kind === "other" && snapshot.title && PI_TOOL_KIND_MAP[snapshot.title]) {
    return { ...snapshot, kind: PI_TOOL_KIND_MAP[snapshot.title] };
  }
  return snapshot;
}

/**
 * Pi-acp reports thinking levels (off/minimal/low/medium/high/xhigh) as ACP
 * session modes rather than as configOptions with category 'thought_level'.
 * This transformer remaps them so the base ACP class treats them as thinking
 * options instead of permission modes.
 */
export function transformPiSessionResponse(response: SessionStateResponse): SessionStateResponse {
  const modes = response.modes;
  if (!modes?.availableModes?.length) {
    return response;
  }

  const thinkingOption: SessionConfigOption = {
    id: "thought_level",
    name: "Thinking",
    type: "select",
    category: "thought_level",
    currentValue: modes.currentModeId ?? "medium",
    options: modes.availableModes.map((mode) => ({
      value: mode.id,
      name: mode.name.replace(/^Thinking:\s*/i, ""),
      description: mode.description,
    })),
  };

  return {
    ...response,
    modes: undefined,
    configOptions: [thinkingOption, ...(response.configOptions ?? [])],
  };
}

function isThoughtLevelFeature(feature: AgentFeature): feature is AgentFeatureSelect {
  return feature.type === "select" && feature.id === "thought_level";
}

function normalizePiFeatures(
  features: AgentFeature[] | undefined,
  thinkingOptionId: string | null | undefined,
): AgentFeature[] | undefined {
  if (!features) {
    return features;
  }

  return features.map((feature) => {
    if (!isThoughtLevelFeature(feature)) {
      return feature;
    }

    return {
      ...feature,
      value: thinkingOptionId ?? feature.value,
    };
  });
}

class PiACPAgentSession implements AgentSession {
  readonly provider: AgentSession["provider"];
  readonly capabilities: AgentSession["capabilities"];

  get id(): string | null {
    return this.inner.id;
  }

  get features(): AgentFeature[] | undefined {
    return normalizePiFeatures(this.inner.features, this.thinkingOptionId);
  }

  private thinkingOptionId: string | null;

  constructor(
    private readonly inner: AgentSession,
    config: AgentSessionConfig,
  ) {
    this.provider = inner.provider;
    this.capabilities = inner.capabilities;
    this.thinkingOptionId = config.thinkingOptionId ?? null;
  }

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return this.inner.run(prompt, options);
  }

  async startTurn(
    prompt: AgentPromptInput,
    options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    return this.inner.startTurn(prompt, options);
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    return this.inner.subscribe(callback);
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    yield* this.inner.streamHistory();
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    const runtimeInfo = await this.inner.getRuntimeInfo();
    const thinkingOptionId =
      runtimeInfo.modeId ?? runtimeInfo.thinkingOptionId ?? this.thinkingOptionId;
    this.thinkingOptionId = thinkingOptionId ?? null;
    return {
      ...runtimeInfo,
      modeId: null,
      thinkingOptionId: thinkingOptionId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return null;
  }

  async setMode(modeId: string): Promise<void> {
    void modeId;
    throw new Error("Pi does not expose selectable modes");
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return this.inner.getPendingPermissions();
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    await this.inner.respondToPermission(requestId, response);
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.inner.describePersistence();
  }

  async interrupt(): Promise<void> {
    await this.inner.interrupt();
  }

  async close(): Promise<void> {
    await this.inner.close();
  }

  async listCommands(): Promise<AgentSlashCommand[]> {
    return this.inner.listCommands ? this.inner.listCommands() : [];
  }

  async setModel(modelId: string | null): Promise<void> {
    if (this.inner.setModel) {
      await this.inner.setModel(modelId);
    }
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    this.thinkingOptionId = thinkingOptionId ?? null;
    if (this.inner.setThinkingOption) {
      await this.inner.setThinkingOption(thinkingOptionId);
    }
  }

  async setFeature(featureId: string, value: unknown): Promise<void> {
    if (!this.inner.setFeature) {
      throw new Error("Agent session does not support setting features");
    }
    await this.inner.setFeature(featureId, value);
  }
}

export function wrapPiSession(
  session: AgentSession,
  config: Pick<AgentSessionConfig, "provider" | "cwd" | "thinkingOptionId">,
): AgentSession {
  return new PiACPAgentSession(session, config);
}

export class PiACPAgentClient extends ACPAgentClient {
  constructor(options: PiACPAgentClientOptions) {
    super({
      provider: "pi",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: [process.execPath, resolvedPiAcpPath],
      defaultModes: [],
      modelTransformer: transformPiModels,
      sessionResponseTransformer: transformPiSessionResponse,
      toolSnapshotTransformer: transformPiToolSnapshot,
      thinkingOptionWriter: async (
        connection: ClientSideConnection,
        sessionId: string,
        thinkingOptionId: string,
      ) => {
        await connection.setSessionMode({ sessionId, modeId: thinkingOptionId });
      },
      capabilities: PI_CAPABILITIES,
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: 1500,
    });
  }

  override async createSession(
    config: AgentSessionConfig,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = await super.createSession(config, launchContext);
    return wrapPiSession(session, config);
  }

  override async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    launchContext?: AgentLaunchContext,
  ): Promise<AgentSession> {
    const session = await super.resumeSession(handle, overrides, launchContext);
    return wrapPiSession(session, {
      provider: "pi",
      cwd: overrides?.cwd ?? process.cwd(),
      thinkingOptionId: overrides?.thinkingOptionId,
    });
  }

  override async isAvailable(): Promise<boolean> {
    if (!existsSync(resolvedPiAcpPath)) {
      return false;
    }
    if (!(await isCommandAvailable(process.env.PI_ACP_PI_COMMAND ?? "pi"))) {
      return false;
    }
    return (
      Boolean(process.env.OPENAI_API_KEY) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.OPENROUTER_API_KEY) ||
      existsSync(join(homedir(), ".pi", "agent", "auth.json"))
    );
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const piCommand = process.env.PI_ACP_PI_COMMAND ?? "pi";
      const piCliPath = await findExecutable(piCommand);
      const piVersion = piCliPath ? await resolveBinaryVersion(piCliPath) : "unknown";
      const authConfigPath = join(homedir(), ".pi", "agent", "auth.json");
      const available = await this.isAvailable();
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
        diagnostic: formatProviderDiagnostic("Pi", [
          {
            label: "pi-acp module",
            value: existsSync(resolvedPiAcpPath) ? "found" : "not found",
          },
          {
            label: "Binary",
            value: piCliPath ?? "not found",
          },
          {
            label: "Version",
            value: piVersion,
          },
          {
            label: "OPENAI_API_KEY",
            value: process.env.OPENAI_API_KEY ? "set" : "not set",
          },
          {
            label: "ANTHROPIC_API_KEY",
            value: process.env.ANTHROPIC_API_KEY ? "set" : "not set",
          },
          {
            label: "OPENROUTER_API_KEY",
            value: process.env.OPENROUTER_API_KEY ? "set" : "not set",
          },
          {
            label: "Auth config (~/.pi/agent/auth.json)",
            value: existsSync(authConfigPath) ? "found" : "not found",
          },
          {
            label: "Models",
            value: modelsValue,
          },
          {
            label: "Status",
            value: status,
          },
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Pi", error),
      };
    }
  }
}
