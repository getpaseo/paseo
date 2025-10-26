export type AgentType = "claude" | "codex";

export interface AgentModeDefinition {
  id: string;
  name: string;
  description?: string;
}

export interface AgentTypeDefinition {
  id: AgentType;
  label: string;
  spawn: {
    command: string;
    args: string[];
  };
  supportsSessionPersistence: boolean;
  availableModes: AgentModeDefinition[];
  defaultModeId: string;
}

export const agentTypeDefinitions: Record<AgentType, AgentTypeDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    spawn: {
      command: "npx",
      args: ["@boudra/claude-code-acp"],
    },
    supportsSessionPersistence: true,
    availableModes: [
      {
        id: "plan",
        name: "Plan",
        description: "Plan and design before implementing",
      },
      {
        id: "bypassPermissions",
        name: "Bypass Permissions",
        description: "Skip permission prompts for faster execution",
      },
    ],
    defaultModeId: "plan",
  },
  codex: {
    id: "codex",
    label: "Codex",
    spawn: {
      command: "npx",
      args: ["@zed-industries/codex-acp"],
    },
    supportsSessionPersistence: false,
    availableModes: [
      {
        id: "default",
        name: "Default",
        description: "Standard coding mode",
      },
    ],
    defaultModeId: "default",
  },
} as const;

export function getAgentTypeDefinition(type: AgentType): AgentTypeDefinition {
  return agentTypeDefinitions[type];
}

export function getAgentModes(type: AgentType): AgentModeDefinition[] {
  return agentTypeDefinitions[type].availableModes;
}
