import { z } from "zod";
import type { AgentMode } from "./agent-sdk-types.js";

export type AgentModeColorTier = "safe" | "moderate" | "dangerous" | "planning";
export type AgentModeIcon = "ShieldCheck" | "ShieldAlert" | "ShieldOff";

export interface AgentModeVisuals {
  icon: AgentModeIcon;
  colorTier: AgentModeColorTier;
}

export type AgentProviderModeDefinition = Omit<AgentMode, "icon" | "colorTier"> & AgentModeVisuals;

// TODO: `modes` should not be static. Providers (especially ACP) report their
// own modes at runtime via session/new. We should fetch modes from the provider
// as source of truth and enrich with UI metadata (icons, colorTier) on top.
export interface AgentProviderDefinition {
  id: string;
  label: string;
  description: string;
  defaultModeId: string | null;
  modes: AgentProviderModeDefinition[];
  voice?: {
    enabled: boolean;
    defaultModeId: string;
    defaultModel?: string;
  };
}

const CLAUDE_MODES: AgentProviderModeDefinition[] = [
  {
    id: "default",
    label: "Always Ask",
    description: "Prompts for permission the first time a tool is used",
    icon: "ShieldCheck",
    colorTier: "safe",
  },
  {
    id: "acceptEdits",
    label: "Accept File Edits",
    description: "Automatically approves edit-focused tools without prompting",
    icon: "ShieldAlert",
    colorTier: "moderate",
  },
  {
    id: "plan",
    label: "Plan Mode",
    description: "Analyze the codebase without executing tools or edits",
    icon: "ShieldCheck",
    colorTier: "planning",
  },
  {
    id: "bypassPermissions",
    label: "Bypass",
    description: "Skip all permission prompts (use with caution)",
    icon: "ShieldAlert",
    colorTier: "dangerous",
  },
];

const CODEX_MODES: AgentProviderModeDefinition[] = [
  {
    id: "auto",
    label: "Default Permissions",
    description: "Edit files and run commands with Codex's default approval flow.",
    icon: "ShieldAlert",
    colorTier: "moderate",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Edit files, run commands, and access the network without additional prompts.",
    icon: "ShieldAlert",
    colorTier: "dangerous",
  },
];

const COPILOT_MODES: AgentProviderModeDefinition[] = [
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#agent",
    label: "Agent",
    description: "Default agent mode for conversational interactions",
    icon: "ShieldAlert",
    colorTier: "moderate",
  },
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#plan",
    label: "Plan",
    description: "Plan mode for creating and executing multi-step plans",
    icon: "ShieldCheck",
    colorTier: "planning",
  },
  {
    id: "https://agentclientprotocol.com/protocol/session-modes#autopilot",
    label: "Autopilot",
    description: "Autonomous mode that runs until task completion without user interaction",
    icon: "ShieldOff",
    colorTier: "dangerous",
  },
];

const OPENCODE_MODES: AgentProviderModeDefinition[] = [
  {
    id: "build",
    label: "Build",
    description: "Allows edits and tool execution for implementation work",
    icon: "ShieldCheck",
    colorTier: "moderate",
  },
  {
    id: "full-access",
    label: "Full Access",
    description: "Automatically approves all tool permission prompts for the session",
    icon: "ShieldAlert",
    colorTier: "dangerous",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Read-only planning mode that avoids file edits",
    icon: "ShieldCheck",
    colorTier: "planning",
  },
];

const MOCK_LOAD_TEST_MODES: AgentProviderModeDefinition[] = [
  {
    id: "load-test",
    label: "Load Test",
    description: "Streams repeated markdown, reasoning, and tool calls for app stress testing",
    icon: "ShieldOff",
    colorTier: "dangerous",
  },
];

export const AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  {
    id: "claude",
    label: "Claude",
    description: "Anthropic's multi-tool assistant with MCP support, streaming, and deep reasoning",
    defaultModeId: "default",
    modes: CLAUDE_MODES,
    voice: {
      enabled: true,
      defaultModeId: "default",
      defaultModel: "haiku",
    },
  },
  {
    id: "codex",
    label: "Codex",
    description: "OpenAI's Codex workspace agent with sandbox controls and optional network access",
    defaultModeId: "auto",
    modes: CODEX_MODES,
    voice: {
      enabled: true,
      defaultModeId: "auto",
      defaultModel: "gpt-5.4-mini",
    },
  },
  {
    id: "copilot",
    label: "Copilot",
    description: "GitHub Copilot via Agent Client Protocol with dynamic modes and session support",
    defaultModeId: "https://agentclientprotocol.com/protocol/session-modes#agent",
    modes: COPILOT_MODES,
  },
  {
    id: "opencode",
    label: "OpenCode",
    description: "Open-source coding assistant with multi-provider model support",
    defaultModeId: "build",
    modes: OPENCODE_MODES,
    voice: {
      enabled: true,
      defaultModeId: "build",
    },
  },
  {
    id: "pi",
    label: "Pi",
    description: "Minimal terminal-based coding agent with multi-provider LLM support",
    defaultModeId: null,
    modes: [],
  },
];

export const DEV_AGENT_PROVIDER_DEFINITIONS: AgentProviderDefinition[] = [
  {
    id: "mock",
    label: "Mock Load Test",
    description:
      "Development-only provider that emits synthetic agent traffic for performance tests",
    defaultModeId: "load-test",
    modes: MOCK_LOAD_TEST_MODES,
  },
];

export function getAgentProviderDefinition(
  provider: string,
  definitions: AgentProviderDefinition[] = [
    ...AGENT_PROVIDER_DEFINITIONS,
    ...DEV_AGENT_PROVIDER_DEFINITIONS,
  ],
): AgentProviderDefinition {
  const definition = definitions.find((entry) => entry.id === provider);
  if (!definition) {
    throw new Error(`Unknown agent provider: ${provider}`);
  }
  return definition;
}

export const BUILTIN_PROVIDER_IDS = AGENT_PROVIDER_DEFINITIONS.map((d) => d.id);
export const AGENT_PROVIDER_IDS = BUILTIN_PROVIDER_IDS;

export const AgentProviderSchema = z.string();

export function isValidAgentProvider(
  value: string,
  validIds: Iterable<string> = BUILTIN_PROVIDER_IDS,
): boolean {
  return Array.isArray(validIds) ? validIds.includes(value) : new Set(validIds).has(value);
}

export function getModeVisuals(
  provider: string,
  modeId: string,
  definitions: AgentProviderDefinition[],
): AgentModeVisuals | undefined {
  const definition = definitions.find((entry) => entry.id === provider);
  const mode = definition?.modes.find((m) => m.id === modeId);
  if (!mode) return undefined;
  return { icon: mode.icon, colorTier: mode.colorTier };
}
