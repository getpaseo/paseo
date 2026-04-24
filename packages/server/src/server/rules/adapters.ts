import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { HubcodeRule, RuleInstallStatus } from "./types.js";

/**
 * Writes enabled rules into a managed section of each agent's canonical
 * guidelines file. Preserves everything outside the sentinel markers so the
 * user's own notes survive a sync.
 *
 * Marker format (stable; bump only with a migration):
 *   <!-- hubcode:rules start -->
 *   ...generated content...
 *   <!-- hubcode:rules end -->
 */

const BEGIN = "<!-- hubcode:rules start -->";
const END = "<!-- hubcode:rules end -->";

export interface RuleTarget {
  id: string;
  name: string;
  /** Absolute file path for scope=global, or null if unsupported. */
  globalFile: string | null;
  /** Sub-path relative to each project root for scope=project. */
  projectFile: string | null;
}

export const RULE_TARGETS: RuleTarget[] = [
  {
    id: "claude",
    name: "Claude Code",
    globalFile: path.join(os.homedir(), ".claude", "CLAUDE.md"),
    projectFile: "CLAUDE.md",
  },
  {
    id: "codex",
    name: "Codex",
    globalFile: path.join(os.homedir(), ".codex", "AGENTS.md"),
    projectFile: "AGENTS.md",
  },
  {
    id: "opencode",
    name: "OpenCode",
    globalFile: path.join(os.homedir(), ".config", "opencode", "AGENTS.md"),
    projectFile: "AGENTS.md",
  },
  {
    id: "cursor",
    name: "Cursor",
    globalFile: null,
    projectFile: ".cursorrules",
  },
  {
    id: "gemini",
    name: "Gemini",
    globalFile: path.join(os.homedir(), ".gemini", "GEMINI.md"),
    projectFile: "GEMINI.md",
  },
  {
    id: "hubcode-gui",
    name: "Hubcode (GUI)",
    globalFile: null,
    projectFile: null,
  },
];

export interface RuleAdapterDeps {
  logger: Logger;
  resolveActiveAgents: () => Promise<Set<string>>;
}

export class RuleAdapter {
  private readonly logger: Logger;
  private readonly resolveActiveAgents: () => Promise<Set<string>>;

  constructor(deps: RuleAdapterDeps) {
    this.logger = deps.logger.child({ module: "rule-adapter" });
    this.resolveActiveAgents = deps.resolveActiveAgents;
  }

  async syncAll(enabled: HubcodeRule[]): Promise<void> {
    const active = await this.resolveActiveAgents();
    // Map absolute file path → rules to include.
    const byFile = new Map<string, HubcodeRule[]>();

    for (const target of RULE_TARGETS) {
      if (!active.has(target.id) || target.id === "hubcode-gui") continue;
      for (const rule of enabled) {
        if (
          rule.targetAgents &&
          rule.targetAgents.length > 0 &&
          !rule.targetAgents.includes(target.id)
        )
          continue;
        const files = resolveFilesForScope(rule, target);
        for (const file of files) {
          if (!file) continue;
          const list = byFile.get(file) ?? [];
          // Deduplicate by rule id (two targets pointing at the same file).
          if (!list.some((r) => r.id === rule.id)) list.push(rule);
          byFile.set(file, list);
        }
      }
      // Ensure global file gets cleared even if zero rules are enabled for it.
      if (target.globalFile) {
        if (!byFile.has(target.globalFile)) byFile.set(target.globalFile, []);
      }
    }

    for (const [file, rules] of byFile) {
      try {
        await this.writeFile(file, rules);
      } catch (err) {
        this.logger.warn({ err, file }, "rules write failed");
      }
    }
  }

  private async writeFile(file: string, rules: HubcodeRule[]): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    let existing = "";
    try {
      existing = await fs.readFile(file, "utf8");
    } catch {
      existing = "";
    }
    const body = renderManagedSection(rules);
    const next = replaceManagedSection(existing, body);
    if (next === existing) return;
    const tmp = `${file}.hubcode.tmp`;
    await fs.writeFile(tmp, next, "utf8");
    await fs.rename(tmp, file);
  }

  async removeAll(): Promise<void> {
    for (const target of RULE_TARGETS) {
      if (target.id === "hubcode-gui") continue;
      if (!target.globalFile) continue;
      try {
        const raw = await fs.readFile(target.globalFile, "utf8");
        const stripped = replaceManagedSection(raw, "");
        if (stripped !== raw) await fs.writeFile(target.globalFile, stripped, "utf8");
      } catch {
        // file missing — nothing to clean
      }
    }
  }

  async statusFor(rule: HubcodeRule): Promise<RuleInstallStatus[]> {
    const active = await this.resolveActiveAgents();
    const statuses: RuleInstallStatus[] = [];
    for (const target of RULE_TARGETS) {
      const agentActive = active.has(target.id);
      if (
        rule.targetAgents &&
        rule.targetAgents.length > 0 &&
        !rule.targetAgents.includes(target.id)
      )
        continue;
      if (target.id === "hubcode-gui") {
        statuses.push({ agentId: target.id, agentActive, status: "installed" });
        continue;
      }
      if (!supportsScope(target, rule)) {
        statuses.push({
          agentId: target.id,
          agentActive,
          status: "unsupported",
          reason: `${target.name} does not support ${rule.scope}-scope rules yet.`,
        });
        continue;
      }
      if (!agentActive) {
        statuses.push({
          agentId: target.id,
          agentActive,
          status: "disabled",
          reason: "CLI not activated. Will install on activation.",
        });
        continue;
      }
      const installed = await probeInstalled(rule, target);
      statuses.push({
        agentId: target.id,
        agentActive,
        status: installed ? "installed" : "not-installed",
      });
    }
    return statuses;
  }
}

function resolveFilesForScope(rule: HubcodeRule, target: RuleTarget): Array<string | null> {
  if (rule.scope === "global") return [target.globalFile];
  if (rule.scope === "project") {
    if (!target.projectFile) return [null];
    return (rule.projectPaths ?? []).map((p) => path.join(p, target.projectFile as string));
  }
  return [];
}

function supportsScope(target: RuleTarget, rule: HubcodeRule): boolean {
  if (rule.scope === "global") return target.globalFile !== null;
  return target.projectFile !== null;
}

async function probeInstalled(rule: HubcodeRule, target: RuleTarget): Promise<boolean> {
  const candidates: string[] = [];
  if (rule.scope === "global" && target.globalFile) candidates.push(target.globalFile);
  if (rule.scope === "project" && target.projectFile) {
    for (const p of rule.projectPaths ?? []) candidates.push(path.join(p, target.projectFile));
  }
  for (const c of candidates) {
    try {
      const raw = await fs.readFile(c, "utf8");
      if (raw.includes(BEGIN) && raw.includes(`<!-- hubcode:rule ${rule.id} -->`)) return true;
    } catch {
      // skip
    }
  }
  return false;
}

function renderManagedSection(rules: HubcodeRule[]): string {
  if (rules.length === 0) return "";
  const parts: string[] = [BEGIN, "", "# Hubcode Rules", ""];
  for (const rule of rules) {
    parts.push(`<!-- hubcode:rule ${rule.id} -->`);
    parts.push(`## ${rule.title}`);
    if (rule.description) parts.push(`*${rule.description}*`, "");
    parts.push(rule.body.trim(), "");
  }
  parts.push(END);
  return parts.join("\n");
}

function replaceManagedSection(source: string, replacement: string): string {
  const beginIdx = source.indexOf(BEGIN);
  const endIdx = source.indexOf(END);
  const hasBoth = beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx;

  if (!hasBoth) {
    if (!replacement) return source;
    const sep = source.length > 0 && !source.endsWith("\n") ? "\n\n" : "\n";
    return source + sep + replacement + "\n";
  }

  const before = source.slice(0, beginIdx).replace(/\n+$/, "");
  const after = source.slice(endIdx + END.length).replace(/^\n+/, "");

  if (!replacement) {
    if (!before && !after) return "";
    return [before, after].filter(Boolean).join("\n\n") + (after ? "" : "\n");
  }
  const joined = [before, replacement, after].filter(Boolean).join("\n\n");
  return joined.endsWith("\n") ? joined : joined + "\n";
}
