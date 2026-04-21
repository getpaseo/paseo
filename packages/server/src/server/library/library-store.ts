import type { McpServerConfig } from "../agent/agent-sdk-types.js";
import {
  TRANSPORT_BY_TARGET,
  type LibrarySyncTarget,
  type MaterializedMcpEntry,
  type MaterializedSkillEntry,
} from "./types.js";

/**
 * In-memory store of the most recent library sync. Populated by the
 * `library_sync_request` handler; read at agent-create time so newly spawned
 * agents pick up activated MCPs + Skills even before the user touches their
 * CLI config files.
 */
export class LibraryStore {
  private mcps: MaterializedMcpEntry[] = [];
  private skills: MaterializedSkillEntry[] = [];

  setMcps(entries: MaterializedMcpEntry[]): void {
    this.mcps = entries;
  }

  setSkills(entries: MaterializedSkillEntry[]): void {
    this.skills = entries;
  }

  /**
   * Build the `mcpServers` record to merge into a draft for the given agent
   * provider. User-defined entries win on key collision.
   */
  mcpServersForProvider(
    provider: string,
    userMcps: Record<string, McpServerConfig> | undefined,
  ): Record<string, McpServerConfig> | undefined {
    const target = providerToTarget(provider);
    if (!target) return userMcps;

    const fromLibrary: Record<string, McpServerConfig> = {};
    for (const entry of this.mcps) {
      if (!entry.syncTargets.includes(target)) continue;
      if (!TRANSPORT_BY_TARGET[target].includes(entry.payload.transport)) continue;
      fromLibrary[entry.name] = toMcpServerConfig(entry);
    }

    if (Object.keys(fromLibrary).length === 0) return userMcps;
    return { ...fromLibrary, ...(userMcps ?? {}) };
  }

  /**
   * Build a system-prompt block from skills that target `provider`. Claude
   * Code already picks skills up from `~/.claude/skills/` natively, so for
   * the `claude` provider we return null and let the SDK handle it. Codex
   * and OpenCode don't scan that folder, so we inline the instructions into
   * the systemPrompt at launch — same effect, different delivery.
   */
  skillsInstructionsForProvider(provider: string, userSystemPrompt?: string): string | undefined {
    const target = providerToTarget(provider);
    if (!target) return userSystemPrompt;
    if (target === "claude-code") return userSystemPrompt;

    const relevant = this.skills.filter((s) => s.syncTargets.includes(target));
    if (relevant.length === 0) return userSystemPrompt;

    const blocks: string[] = [];
    for (const skill of relevant) {
      const body = skill.payload.instructionsInline?.trim();
      if (!body) continue;
      blocks.push(
        `<skill name="${skill.name}"${
          skill.description ? ` description="${escapeAttr(skill.description)}"` : ""
        }>\n${body}\n</skill>`,
      );
    }
    if (blocks.length === 0) return userSystemPrompt;

    const header =
      "The following skills are available — load them contextually when relevant:";
    const skillsSection = [header, ...blocks].join("\n\n");
    return userSystemPrompt
      ? `${userSystemPrompt}\n\n${skillsSection}`
      : skillsSection;
  }
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/\n/g, " ");
}

function providerToTarget(provider: string): LibrarySyncTarget | null {
  const normalized = provider.toLowerCase();
  if (normalized === "claude" || normalized === "claude-code") return "claude-code";
  if (normalized === "codex") return "codex";
  if (normalized === "opencode") return "opencode";
  return null;
}

function toMcpServerConfig(entry: MaterializedMcpEntry): McpServerConfig {
  if (entry.payload.transport === "stdio") {
    return {
      type: "stdio",
      command: entry.payload.command,
      ...(entry.payload.args && entry.payload.args.length > 0
        ? { args: entry.payload.args }
        : {}),
      ...(entry.payload.env && Object.keys(entry.payload.env).length > 0
        ? { env: entry.payload.env }
        : {}),
    };
  }
  return {
    type: entry.payload.transport,
    url: entry.payload.url,
    ...(entry.payload.headers && Object.keys(entry.payload.headers).length > 0
      ? { headers: entry.payload.headers }
      : {}),
  };
}
