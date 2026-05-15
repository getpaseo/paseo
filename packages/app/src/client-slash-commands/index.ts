import { useEffect, useRef } from "react";
import type { AgentProvider } from "@server/server/agent/agent-sdk-types";
import type { Agent } from "@/stores/session-store";

export type ClientSlashCommandKind = "archive-agent" | "replace-agent-with-draft";

export interface ClientSlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind: ClientSlashCommandKind;
}

export interface DraftAgentSetupSeed {
  provider: AgentProvider;
  cwd: string;
  modeId: string | null;
  model: string | null;
  thinkingOptionId: string | null;
  featureValues: Record<string, unknown>;
}

export const CLIENT_SLASH_COMMANDS: readonly ClientSlashCommand[] = [
  {
    name: "quit",
    description: "Archive the current agent",
    argumentHint: "",
    kind: "archive-agent",
  },
  {
    name: "exit",
    description: "Archive the current agent",
    argumentHint: "",
    kind: "archive-agent",
  },
  {
    name: "q",
    description: "Archive the current agent",
    argumentHint: "",
    kind: "archive-agent",
  },
  {
    name: "clear",
    description: "Archive this agent and start a fresh draft",
    argumentHint: "",
    kind: "replace-agent-with-draft",
  },
  {
    name: "new",
    description: "Archive this agent and start a fresh draft",
    argumentHint: "",
    kind: "replace-agent-with-draft",
  },
];

const COMMAND_BY_NAME = new Map(CLIENT_SLASH_COMMANDS.map((command) => [command.name, command]));
const draftSetupSeeds = new Map<string, DraftAgentSetupSeed>();

export function resolveClientSlashCommand(input: {
  text: string;
  hasAttachments: boolean;
}): ClientSlashCommand | null {
  if (input.hasAttachments) {
    return null;
  }

  const trimmed = input.text.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const commandName = trimmed.slice(1);
  if (!commandName || /\s/.test(commandName)) {
    return null;
  }

  return COMMAND_BY_NAME.get(commandName) ?? null;
}

export function buildDraftAgentSetupSeed(agent: Agent): DraftAgentSetupSeed {
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

export function seedDraftAgentSetup(input: { draftId: string; setup: DraftAgentSetupSeed }): void {
  draftSetupSeeds.set(input.draftId, input.setup);
}

export function consumeDraftAgentSetupSeed(draftId: string): DraftAgentSetupSeed | null {
  const seed = draftSetupSeeds.get(draftId) ?? null;
  draftSetupSeeds.delete(draftId);
  return seed;
}

export function useDraftAgentSetupSeed(draftId: string): DraftAgentSetupSeed | null {
  const seedRef = useRef<{ draftId: string; seed: DraftAgentSetupSeed | null } | null>(null);
  if (seedRef.current?.draftId !== draftId) {
    seedRef.current = {
      draftId,
      seed: draftSetupSeeds.get(draftId) ?? null,
    };
  }

  useEffect(() => {
    draftSetupSeeds.delete(draftId);
  }, [draftId]);

  return seedRef.current.seed;
}

export const __private__ = {
  clearDraftAgentSetupSeeds: () => {
    draftSetupSeeds.clear();
  },
};
