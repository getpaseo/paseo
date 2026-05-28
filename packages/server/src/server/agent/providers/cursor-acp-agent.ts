import { basename } from "node:path";
import type { Logger } from "pino";

import type { AgentModelDefinition, ListModelsOptions } from "../agent-sdk-types.js";
import * as spawnUtils from "../../../utils/spawn.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";

interface CursorACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
}

const CURSOR_MODELS_TIMEOUT_MS = 10_000;
const CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;
const CURSOR_MODEL_MARKER_PATTERN = /\s+\((?:default|current)\)$/;

export class CursorACPAgentClient extends GenericACPAgentClient {
  private readonly cursorCommand: [string, ...string[]];
  private readonly env?: Record<string, string>;

  constructor(options: CursorACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      // cursor-agent publishes slash commands asynchronously via available_commands_update.
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: CURSOR_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
    });
    this.cursorCommand = options.command;
    this.env = options.env;
  }

  override async listModels(options: ListModelsOptions): Promise<AgentModelDefinition[]> {
    const acpModels = await super.listModels(options);
    if (acpModels.length > 0) {
      return acpModels;
    }

    if (this.canUseCursorModelsFallback()) {
      return this.listCursorModelsFallback(acpModels);
    }

    return acpModels;
  }

  private canUseCursorModelsFallback(): boolean {
    return basename(this.cursorCommand[0]) === "cursor-agent";
  }

  private async listCursorModelsFallback(
    acpModels: AgentModelDefinition[],
  ): Promise<AgentModelDefinition[]> {
    try {
      const { stdout } = await spawnUtils.execCommand(this.cursorCommand[0], ["models"], {
        envOverlay: this.env,
        timeout: CURSOR_MODELS_TIMEOUT_MS,
        maxBuffer: 1024 * 1024,
      });
      const fallbackModels = parseCursorAgentModelsOutput(stdout);
      if (fallbackModels.length === 0) {
        this.logger.warn(
          { provider: "cursor" },
          "Cursor ACP model fallback returned no parseable models",
        );
        return acpModels;
      }
      return fallbackModels;
    } catch (error) {
      this.logger.warn(
        { err: error, provider: "cursor" },
        "Failed to list Cursor models via cursor-agent models fallback",
      );
      return acpModels;
    }
  }
}

interface ParsedCursorModel {
  provider: "acp";
  id: string;
  label: string;
  marker: "default" | "current" | null;
}

export function parseCursorAgentModelsOutput(output: string): AgentModelDefinition[] {
  const parsed = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && line !== "Available models" && !line.startsWith("Tip:"))
    .map((line) => {
      const separatorIndex = line.indexOf(" - ");
      if (separatorIndex <= 0) {
        return null;
      }

      const id = line.slice(0, separatorIndex).trim();
      const rawLabel = line.slice(separatorIndex + 3).trim();
      if (!id || !rawLabel) {
        return null;
      }

      let marker: "default" | "current" | null = null;
      if (rawLabel.endsWith(" (default)")) {
        marker = "default";
      } else if (rawLabel.endsWith(" (current)")) {
        marker = "current";
      }

      return {
        provider: "acp",
        id,
        label: rawLabel.replace(CURSOR_MODEL_MARKER_PATTERN, ""),
        marker,
      };
    })
    .filter((model): model is ParsedCursorModel => model !== null);

  const defaultModelId =
    parsed.find((model) => model.marker === "default")?.id ??
    parsed.find((model) => model.marker === "current")?.id ??
    parsed[0]?.id;

  return parsed.map((model) => ({
    provider: model.provider,
    id: model.id,
    label: model.label,
    isDefault: model.id === defaultModelId,
  }));
}
