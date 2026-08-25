import type { CommandInfo } from "@opencode-ai/client";
import type { Logger } from "pino";

import type { AgentSlashCommand } from "../../agent-sdk-types.js";
import type { OpenCodeV2ClientLike } from "./client.js";

/**
 * Built-in slash commands the opencode-v2 provider handles itself. opencode2's
 * `command.list` only returns custom commands (plus `init`), so compact and
 * summarize are surfaced here and dispatched via `session.compact`.
 */
export const OPENCODE_V2_HANDLED_BUILTIN_SLASH_COMMANDS: AgentSlashCommand[] = [
  {
    name: "compact",
    description: "Compact the current session",
    argumentHint: "",
    kind: "command",
  },
  {
    name: "summarize",
    description: "Compact the current session",
    argumentHint: "",
    kind: "command",
  },
];

/**
 * Budget for the opencode2 command registry to finish loading after a cold
 * start. A freshly spawned server returns an empty `command.list` payload for
 * ~1s until its config plugin finishes scanning command sources, so listings
 * and slash-command resolution retry briefly before giving up.
 */
export const OPENCODE_V2_COMMAND_LOAD_ATTEMPTS = 3;
export const OPENCODE_V2_COMMAND_LOAD_RETRY_DELAY_MS = 500;

function delayOpenCodeV2CommandLoad(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function mapOpenCodeV2Commands(data: readonly CommandInfo[]): AgentSlashCommand[] {
  const commandsByName = new Map(
    OPENCODE_V2_HANDLED_BUILTIN_SLASH_COMMANDS.map((command) => [command.name, command]),
  );
  for (const command of data) {
    commandsByName.set(command.name, {
      name: command.name,
      description: command.description ?? "",
      argumentHint: "",
      kind: "command",
    });
  }
  return Array.from(commandsByName.values());
}

/**
 * List the opencode2 commands for a directory. The listing is fetched live
 * from the server via `command.list` on every call — never cached — so newly
 * registered commands appear without a restart. When the server's command
 * registry is still loading after a cold start (an empty payload), retry
 * briefly before returning the (possibly empty) result.
 */
export async function listOpenCodeV2Commands(
  client: OpenCodeV2ClientLike,
  directory: string,
  logger: Pick<Logger, "debug">,
): Promise<AgentSlashCommand[]> {
  for (let attempt = 0; attempt < OPENCODE_V2_COMMAND_LOAD_ATTEMPTS; attempt += 1) {
    try {
      const response = await client.command.list({ location: { directory } });
      if (response.data.length > 0 || attempt === OPENCODE_V2_COMMAND_LOAD_ATTEMPTS - 1) {
        return mapOpenCodeV2Commands(response.data);
      }
    } catch (error) {
      if (attempt === OPENCODE_V2_COMMAND_LOAD_ATTEMPTS - 1) {
        throw error;
      }
      logger.debug({ err: error }, "OpenCode 2 command list not ready; retrying");
    }
    await delayOpenCodeV2CommandLoad(OPENCODE_V2_COMMAND_LOAD_RETRY_DELAY_MS);
  }
  return mapOpenCodeV2Commands([]);
}

/**
 * Parse a `/command args` prompt into its command name and argument string.
 * Returns null for input that is not a slash command (including a bare "/" or
 * a name containing another slash, e.g. a path like "/etc/hosts").
 */
export function parseOpenCodeV2SlashCommandInput(
  text: string,
): { commandName: string; args?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/") || trimmed.length <= 1) {
    return null;
  }
  const withoutPrefix = trimmed.slice(1);
  const firstWhitespaceIdx = withoutPrefix.search(/\s/);
  const commandName =
    firstWhitespaceIdx === -1 ? withoutPrefix : withoutPrefix.slice(0, firstWhitespaceIdx);
  if (!commandName || commandName.includes("/")) {
    return null;
  }
  const rawArgs =
    firstWhitespaceIdx === -1 ? "" : withoutPrefix.slice(firstWhitespaceIdx + 1).trim();
  return rawArgs.length > 0 ? { commandName, args: rawArgs } : { commandName };
}

export function isOpenCodeV2CompactCommand(commandName: string): boolean {
  return commandName === "compact" || commandName === "summarize";
}
