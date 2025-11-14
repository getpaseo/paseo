export type AgentType = "claude" | "codex";

export interface AgentModeDefinition {
  id: string;
  name: string;
  description?: string | null;
}

export interface AgentTypeDefinition {
  id: AgentType;
  label: string;
  description?: string;
  spawn: {
    command: string;
    args: string[];
  };
  supportsSessionPersistence: boolean;
  availableModes: AgentModeDefinition[];
  defaultModeId: string;
}

const CLAUDE_MODES: AgentModeDefinition[] = [
  {
    id: "default",
    name: "Default",
    description: "Default Claude Code mode with standard permissions",
  },
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
];

const CODEX_MODES: AgentModeDefinition[] = [
  {
    id: "read-only",
    name: "Read Only",
    description: "Codex can read files and answer questions. Codex requires approval to make edits, run commands, or access network",
  },
  {
    id: "auto",
    name: "Auto",
    description: "Codex can read files, make edits, and run commands in the workspace. Codex requires approval to work outside the workspace or access network",
  },
  {
    id: "full-access",
    name: "Full Access",
    description: "Codex can read files, make edits, and run commands with network access, without approval. Exercise caution",
  },
];

const agentTypeDefinitions: Record<AgentType, AgentTypeDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    description: "Full Claude Code agent with session persistence",
    spawn: {
      command: "npx",
      args: ["@boudra/claude-code-acp"],
    },
    supportsSessionPersistence: true,
    availableModes: CLAUDE_MODES,
    defaultModeId: "plan",
  },
  codex: {
    id: "codex",
    label: "Codex",
    description: "Zed Codex ACP integration with session persistence",
    spawn: {
      command: "npx",
      args: ["@zed-industries/codex-acp"],
    },
    supportsSessionPersistence: true,
    availableModes: CODEX_MODES,
    defaultModeId: "auto",
  },
} as const;

export function getAgentTypeDefinition(type: AgentType): AgentTypeDefinition {
  return agentTypeDefinitions[type];
}

export function getAgentModes(type: AgentType): AgentModeDefinition[] {
  return agentTypeDefinitions[type].availableModes;
}

export function listAgentTypeDefinitions(): AgentTypeDefinition[] {
  return Object.values(agentTypeDefinitions);
}
