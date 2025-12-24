import type { AgentMode, AgentProvider } from "./agent-sdk-types.js";

export interface AgentProviderDefinition {
  id: AgentProvider;
  label: string;
  description: string;
  defaultModeId: string | null;
  modes: AgentMode[];
}

const CLAUDE_MODES: AgentMode[] = [
  {
    id: "default",
    label: "Always Ask",
    description: "Prompts for permission the first time a tool is used",
  },
  {
    id: "acceptEdits",
    label: "Accept File Edits",
    description: "Automatically approves edit-focused tools without prompting",
  },
  {
    id: "plan",
    label: "Plan Mode",
    description: "Analyze the codebase without executing tools or edits",
  },
  {
    id: "bypassPermissions",
    label: "Bypass Permissions",
    description: "Skip all permission prompts (use with caution)",
  },
];

const CODEX_MODES: AgentMode[] = [
  {
    id: "read-only",
    label: "Read Only",
    description:
      "Read files and answer questions. Manual approval required for edits, commands, or network ops.",
  },
  {
    id: "auto",
    label: "Auto",
    description:
      "Edit files and run commands but still request approval before escalating scope.",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Edit files, run commands, and access the network without additional prompts.",
  },
];

export const AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  {
    id: "claude",
    label: "Claude",
    description:
      "Anthropic's multi-tool assistant with MCP support, streaming, and deep reasoning",
    defaultModeId: "default",
    modes: CLAUDE_MODES,
  },
  {
    id: "codex",
    label: "Codex",
    description:
      "OpenAI's Codex workspace agent with sandbox controls and optional network access",
    defaultModeId: "auto",
    modes: CODEX_MODES,
  },
  {
    id: "codex-mcp",
    label: "Codex MCP",
    description:
      "Codex workspace agent via MCP with streaming events and permission elicitation",
    defaultModeId: "auto",
    modes: CODEX_MODES,
  },
];

export function getAgentProviderDefinition(provider: AgentProvider): AgentProviderDefinition {
  const definition = AGENT_PROVIDER_DEFINITIONS.find((entry) => entry.id === provider);
  if (!definition) {
    throw new Error(`Unknown agent provider: ${provider}`);
  }
  return definition;
}
