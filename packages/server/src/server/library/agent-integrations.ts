import os from "node:os";
import path from "node:path";
import type { McpTransport } from "./types.js";

/**
 * Registry of agent CLIs the library can sync MCPs + Skills into. Shape
 * mirrors Emdash's (generalaction/emdash) so new agents are one config entry
 * + one adapter for novel formats.
 *
 * Paths are stored as segments + a builder so we can redirect `~` to a tmp
 * dir in tests without mutating the registry.
 */
export type McpAdapterId =
  | "passthrough" // { command, args, env } or { type, url, headers } direct
  | "codex" // TOML under [mcp_servers.<name>]
  | "cursor" // mcpServers with `type`-less shape
  | "gemini" // mcpServers with command+args+env
  | "opencode" // mcp with { type: "local" | "remote" }
  | "copilot"; // mcpServers with { command|url, args, env }

export interface AgentMcpConfig {
  /** File path split as segments under `home`. */
  configPathSegments: string[];
  /** Keypath inside the file that holds the server dict. */
  serversPath: string[];
  /** Starting skeleton when the file doesn't exist. */
  template: Record<string, unknown>;
  format: "json" | "jsonc" | "toml";
  adapter: McpAdapterId;
  /** Some targets only accept stdio (Codex). UI greys out the rest. */
  supportsHttp: boolean;
}

export interface AgentSkillTarget {
  /** Segments under `home`, ending with `<skillId>`. Caller substitutes `<id>`. */
  dirSegments: (skillId: string) => string[];
}

export interface AgentIntegration {
  id: string;
  label: string;
  bin: string;
  installHint?: string;
  promptStyle?: "positional" | "-i" | "-p" | "-t" | "-c" | "--prompt";
  mcp?: AgentMcpConfig;
  skills?: AgentSkillTarget;
}

/**
 * Resolve an integration's MCP config path against a `home` dir (usually
 * `os.homedir()`; tests pass a tmp dir). Keeping this a pure function makes
 * the registry trivially testable.
 */
export function mcpConfigPathFor(agent: AgentIntegration, home = os.homedir()): string | null {
  if (!agent.mcp) return null;
  return path.join(home, ...agent.mcp.configPathSegments);
}

export function skillsDirFor(
  agent: AgentIntegration,
  skillId: string,
  home = os.homedir(),
): string | null {
  if (!agent.skills) return null;
  return path.join(home, ...agent.skills.dirSegments(skillId));
}

/** Canonical directory holding every synced skill. Symlink source. */
export function canonicalSkillsDir(home = os.homedir()): string {
  return path.join(home, ".agentskills");
}

export const AGENT_INTEGRATIONS: AgentIntegration[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    bin: "claude",
    installHint: "Installed via Anthropic onboarding",
    promptStyle: "positional",
    mcp: {
      configPathSegments: [".claude.json"],
      serversPath: ["mcpServers"],
      template: { mcpServers: {} },
      format: "json",
      adapter: "passthrough",
      supportsHttp: true,
    },
    skills: {
      dirSegments: (id) => [".claude", "skills", id],
    },
  },
  {
    id: "codex",
    label: "Codex",
    bin: "codex",
    installHint: "npm i -g @openai/codex",
    promptStyle: "positional",
    mcp: {
      configPathSegments: [".codex", "config.toml"],
      serversPath: ["mcp_servers"],
      template: { mcp_servers: {} },
      format: "toml",
      adapter: "codex",
      supportsHttp: false,
    },
    skills: {
      dirSegments: (id) => [".codex", "skills", id],
    },
  },
  {
    id: "opencode",
    label: "OpenCode",
    bin: "opencode",
    installHint: "npm i -g opencode-ai",
    promptStyle: "positional",
    mcp: {
      configPathSegments: [".config", "opencode", "opencode.json"],
      serversPath: ["mcp"],
      template: { mcp: {} },
      format: "jsonc",
      adapter: "opencode",
      supportsHttp: true,
    },
    skills: {
      dirSegments: (id) => [".config", "opencode", "skills", id],
    },
  },
  {
    id: "cursor",
    label: "Cursor",
    bin: "cursor-agent",
    installHint: "curl https://cursor.com/install -fsS | bash",
    promptStyle: "positional",
    mcp: {
      configPathSegments: [".cursor", "mcp.json"],
      serversPath: ["mcpServers"],
      template: { mcpServers: {} },
      format: "json",
      adapter: "cursor",
      supportsHttp: true,
    },
    skills: {
      dirSegments: (id) => [".cursor", "skills", id],
    },
  },
  {
    id: "amp",
    label: "Amp",
    bin: "amp",
    installHint: "npm i -g @sourcegraph/amp@latest",
    promptStyle: "positional",
    mcp: {
      configPathSegments: [".config", "amp", "settings.json"],
      serversPath: ["mcpServers"],
      template: { mcpServers: {} },
      format: "json",
      adapter: "passthrough",
      supportsHttp: true,
    },
    skills: {
      dirSegments: (id) => [".amp", "skills", id],
    },
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    bin: "gemini",
    installHint: "npm i -g @google/gemini-cli",
    promptStyle: "-i",
    mcp: {
      configPathSegments: [".gemini", "settings.json"],
      serversPath: ["mcpServers"],
      template: { mcpServers: {} },
      format: "json",
      adapter: "gemini",
      supportsHttp: true,
    },
    skills: {
      dirSegments: (id) => [".gemini", "skills", id],
    },
  },
  {
    id: "qwen",
    label: "Qwen Code",
    bin: "qwen",
    installHint: "npm i -g @qwen-code/qwen-code",
    promptStyle: "-i",
    mcp: {
      configPathSegments: [".qwen", "settings.json"],
      serversPath: ["mcpServers"],
      template: { mcpServers: {} },
      format: "json",
      adapter: "gemini",
      supportsHttp: true,
    },
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    bin: "copilot",
    installHint: "npm i -g @github/copilot",
    promptStyle: "-i",
    mcp: {
      configPathSegments: [".copilot", "mcp-config.json"],
      serversPath: ["mcpServers"],
      template: { mcpServers: {} },
      format: "json",
      adapter: "copilot",
      supportsHttp: true,
    },
  },
  {
    id: "droid",
    label: "Droid",
    bin: "droid",
    installHint: "curl -fsSL https://app.factory.ai/cli | sh",
    promptStyle: "positional",
    mcp: {
      configPathSegments: [".droid", "settings.json"],
      serversPath: ["mcpServers"],
      template: { mcpServers: {} },
      format: "json",
      adapter: "passthrough",
      supportsHttp: true,
    },
    skills: {
      dirSegments: (id) => [".droid", "skills", id],
    },
  },
  // ─── Skills-only agents (no MCP adapter yet — user selects, we drop a
  //     SKILL.md symlink in the agent's skills dir. MCP chip for these is
  //     disabled in the UI until an adapter lands). ──────────────────────
  {
    id: "hermes",
    label: "Hermes Agent",
    bin: "hermes",
    installHint: "curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash",
    promptStyle: "positional",
    skills: { dirSegments: (id) => [".hermes", "skills", id] },
  },
  {
    id: "crush",
    label: "Charm Crush",
    bin: "crush",
    installHint: "npm i -g @charmland/crush",
    skills: { dirSegments: (id) => [".crush", "skills", id] },
  },
  {
    id: "auggie",
    label: "Auggie",
    bin: "auggie",
    installHint: "npm i -g @augmentcode/auggie",
    promptStyle: "positional",
    skills: { dirSegments: (id) => [".auggie", "skills", id] },
  },
  {
    id: "goose",
    label: "Goose",
    bin: "goose",
    installHint: "curl -fsSL https://github.com/block/goose/releases/download/stable/download_cli.sh | bash",
    promptStyle: "-t",
    skills: { dirSegments: (id) => [".config", "goose", "skills", id] },
  },
  {
    id: "kimi",
    label: "Kimi",
    bin: "kimi",
    installHint: "uv tool install kimi-cli",
    promptStyle: "-c",
    skills: { dirSegments: (id) => [".kimi", "skills", id] },
  },
  {
    id: "kilocode",
    label: "Kilocode",
    bin: "kilocode",
    installHint: "npm i -g @kilocode/cli",
    promptStyle: "positional",
    skills: { dirSegments: (id) => [".kilocode", "skills", id] },
  },
  {
    id: "kiro",
    label: "Kiro (AWS)",
    bin: "kiro-cli",
    installHint: "curl -fsSL https://cli.kiro.dev/install | bash",
    promptStyle: "positional",
    skills: { dirSegments: (id) => [".kiro", "skills", id] },
  },
  {
    id: "rovodev",
    label: "Rovo Dev",
    bin: "rovodev",
    installHint: "acli rovodev auth login",
    skills: { dirSegments: (id) => [".rovodev", "skills", id] },
  },
  {
    id: "cline",
    label: "Cline",
    bin: "cline",
    installHint: "npm i -g cline",
    promptStyle: "positional",
    skills: { dirSegments: (id) => [".cline", "skills", id] },
  },
  {
    id: "continue",
    label: "Continue",
    bin: "cn",
    installHint: "npm i -g @continuedev/cli",
    promptStyle: "-p",
    skills: { dirSegments: (id) => [".continue", "skills", id] },
  },
  {
    id: "codebuff",
    label: "Codebuff",
    bin: "codebuff",
    installHint: "npm i -g codebuff",
    promptStyle: "positional",
    skills: { dirSegments: (id) => [".codebuff", "skills", id] },
  },
  {
    id: "vibe",
    label: "Mistral Vibe",
    bin: "vibe",
    installHint: "curl -LsSf https://mistral.ai/vibe/install.sh | bash",
    promptStyle: "--prompt",
    skills: { dirSegments: (id) => [".vibe", "skills", id] },
  },
  {
    id: "pi",
    label: "Pi",
    bin: "pi",
    installHint: "npm i -g @mariozechner/pi-coding-agent",
    promptStyle: "positional",
    skills: { dirSegments: (id) => [".pi", "agent", "skills", id] },
  },
  {
    id: "autohand",
    label: "Autohand Code",
    bin: "autohand",
    installHint: "npm i -g autohand-cli",
    promptStyle: "-p",
    skills: { dirSegments: (id) => [".autohand", "skills", id] },
  },
  {
    id: "forge",
    label: "Forge",
    bin: "forge",
    installHint: "curl -fsSL https://forgecode.dev/cli | sh",
    promptStyle: "-p",
    skills: { dirSegments: (id) => [".forge", "skills", id] },
  },
];

export function integrationById(id: string): AgentIntegration | undefined {
  return AGENT_INTEGRATIONS.find((a) => a.id === id);
}

export function mcpIntegrations(): AgentIntegration[] {
  return AGENT_INTEGRATIONS.filter((a) => !!a.mcp);
}

export function skillIntegrations(): AgentIntegration[] {
  return AGENT_INTEGRATIONS.filter((a) => !!a.skills);
}

export function agentSupportsTransport(id: string, transport: McpTransport): boolean {
  const agent = integrationById(id);
  if (!agent?.mcp) return false;
  if (transport === "stdio") return true;
  return agent.mcp.supportsHttp;
}
