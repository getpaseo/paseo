import type { Agent } from "@/stores/session-store";
import type { WorkspaceDraftTabSetup } from "@/workspace-tabs/model";

export type ClientSlashCommandKind = "archive-agent" | "replace-agent-with-draft" | "start-goal";
export type ClientSlashCommandExecution = "immediate" | "insert";

export interface ClientSlashCommand {
  name: string;
  aliases: readonly string[];
  description: string;
  descriptionKey:
    | "composer.clientCommands.archiveAgent"
    | "composer.clientCommands.freshDraft"
    | "composer.clientCommands.startGoal";
  argumentHint: string;
  /** Whether text after the command name is passed on instead of making it an ordinary message. */
  acceptsArgs: boolean;
  kind: ClientSlashCommandKind;
  execution: ClientSlashCommandExecution;
}

export const CLIENT_SLASH_COMMANDS: readonly ClientSlashCommand[] = [
  {
    name: "exit",
    aliases: ["quit", "q"],
    description: "Archive the current agent",
    descriptionKey: "composer.clientCommands.archiveAgent",
    argumentHint: "",
    acceptsArgs: false,
    kind: "archive-agent",
    execution: "immediate",
  },
  {
    name: "clear",
    aliases: ["new"],
    description: "Archive this agent and start a fresh draft",
    descriptionKey: "composer.clientCommands.freshDraft",
    argumentHint: "",
    acceptsArgs: false,
    kind: "replace-agent-with-draft",
    execution: "immediate",
  },
  {
    name: "goal",
    aliases: [],
    description: "Start a goal from this chat",
    descriptionKey: "composer.clientCommands.startGoal",
    argumentHint: "[objective]",
    acceptsArgs: true,
    kind: "start-goal",
    execution: "immediate",
  },
];

const COMMAND_BY_NAME = new Map<string, ClientSlashCommand>();
for (const command of CLIENT_SLASH_COMMANDS) {
  COMMAND_BY_NAME.set(command.name, command);
  for (const alias of command.aliases) {
    COMMAND_BY_NAME.set(alias, command);
  }
}

export interface ResolvedClientSlashCommand {
  command: ClientSlashCommand;
  /** Trimmed text after the command name; always empty for a command without arguments. */
  args: string;
}

export function resolveClientSlashCommand(input: {
  text: string;
  hasAttachments: boolean;
}): ResolvedClientSlashCommand | null {
  if (input.hasAttachments) {
    return null;
  }

  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(input.text.trim());
  if (!match) {
    return null;
  }

  const command = COMMAND_BY_NAME.get(match[1]) ?? null;
  const args = (match[2] ?? "").trim();
  if (!command || (args && !command.acceptsArgs)) {
    return null;
  }
  return { command, args };
}

export function buildDraftAgentSetup(agent: Agent): WorkspaceDraftTabSetup {
  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}
