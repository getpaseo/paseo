import type { Logger } from "pino";

import type { ACPExtensionCommandsParser } from "./acp-agent.js";
import { GenericACPAgentClient } from "./generic-acp-agent.js";
import type { AgentSlashCommand, AgentSlashCommandKind } from "../agent-sdk-types.js";

interface KiroACPAgentClientOptions {
  logger: Logger;
  command: [string, ...string[]];
  env?: Record<string, string>;
  providerId?: string;
  label?: string;
  providerParams?: unknown;
}

// Kiro CLI publishes its slash commands and skills asynchronously through the
// `_kiro.dev/commands/available` extension notification shortly after
// `session/new` resolves. Wait for that first batch so listCommands() doesn't
// resolve to an empty list before Kiro has reported its commands.
const KIRO_INITIAL_COMMANDS_WAIT_TIMEOUT_MS = 10_000;

// ACP extension method (per the `_`-prefixed vendor namespace convention) that
// Kiro CLI uses to publish its slash commands and skills after session/new.
const KIRO_COMMANDS_AVAILABLE_METHOD = "_kiro.dev/commands/available";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

// Maps a `_kiro.dev/commands/available` payload onto Paseo slash commands.
// Kiro reports built-in slash commands under `commands` (names arrive with a
// leading "/", e.g. "/agent") and skills/prompts under `prompts` (names without
// a slash, tagged with a `skill:` serverName). Paseo stores command names
// without the leading slash — the composer prepends it on insertion.
function mapKiroAvailableCommands(params: Record<string, unknown>): AgentSlashCommand[] {
  const result: AgentSlashCommand[] = [];
  const seen = new Set<string>();

  const pushEntry = (entry: unknown): void => {
    if (!isRecord(entry)) {
      return;
    }
    const rawName = typeof entry.name === "string" ? entry.name.trim() : "";
    const name = rawName.replace(/^\/+/, "");
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);

    const description = typeof entry.description === "string" ? entry.description : "";
    const meta = isRecord(entry.meta) ? entry.meta : null;
    const argumentHint = meta && typeof meta.hint === "string" ? meta.hint : "";
    const serverName = typeof entry.serverName === "string" ? entry.serverName : "";
    const kind: AgentSlashCommandKind = serverName.startsWith("skill:") ? "skill" : "command";

    result.push({ name, description, argumentHint, kind });
  };

  if (Array.isArray(params.commands)) {
    for (const entry of params.commands) {
      pushEntry(entry);
    }
  }
  if (Array.isArray(params.prompts)) {
    for (const entry of params.prompts) {
      pushEntry(entry);
    }
  }

  return result;
}

// Provider-specific parser injected into the generic ACP session via the
// `extensionCommandsParser` option (mirrors how Cursor/Copilot inject their
// behavior through constructor options). Kiro advertises its slash commands and
// skills through the `_kiro.dev/commands/available` extension notification
// instead of the standard `available_commands_update` session update; this
// recognizes that one method and returns the parsed commands (possibly empty),
// or null for any other notification so the base session ignores it.
export const parseKiroExtensionCommands: ACPExtensionCommandsParser = (method, params) => {
  if (method !== KIRO_COMMANDS_AVAILABLE_METHOD) {
    return null;
  }
  return mapKiroAvailableCommands(params);
};

export class KiroACPAgentClient extends GenericACPAgentClient {
  constructor(options: KiroACPAgentClientOptions) {
    super({
      logger: options.logger,
      command: options.command,
      env: options.env,
      providerId: options.providerId,
      label: options.label,
      providerParams: options.providerParams,
      waitForInitialCommands: true,
      initialCommandsWaitTimeoutMs: KIRO_INITIAL_COMMANDS_WAIT_TIMEOUT_MS,
      extensionCommandsParser: parseKiroExtensionCommands,
    });
  }
}
