import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Logger } from "pino";
import type {
  ClientSideConnection,
  SessionConfigOption,
  ToolKind,
} from "@agentclientprotocol/sdk";

import type { AgentCapabilityFlags, AgentModelDefinition } from "../agent-sdk-types.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { isCommandAvailable } from "../provider-launch-config.js";
import {
  ACPAgentClient,
  type ACPToolSnapshot,
  type SessionStateResponse,
} from "./acp-agent.js";

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
export function transformPiSessionResponse(
  response: SessionStateResponse,
): SessionStateResponse {
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
    configOptions: [
      thinkingOption,
      ...(response.configOptions ?? []),
    ],
  };
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
    });
  }

  override async isAvailable(): Promise<boolean> {
    if (!existsSync(resolvedPiAcpPath)) {
      return false;
    }
    if (!isCommandAvailable(process.env.PI_ACP_PI_COMMAND ?? "pi")) {
      return false;
    }
    return (
      Boolean(process.env.OPENAI_API_KEY) ||
      Boolean(process.env.ANTHROPIC_API_KEY) ||
      Boolean(process.env.OPENROUTER_API_KEY) ||
      existsSync(join(homedir(), ".pi", "agent", "auth.json"))
    );
  }
}
