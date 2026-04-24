import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "pino";

import type { CommandInstallStatus, HubcodeCommand } from "./types.js";

/**
 * Installs Hubcode commands into each supported CLI/GUI agent's native
 * command directory. Adapters are data-driven: one descriptor per target
 * agent describes where files go and what extension to use. Unsupported
 * agents surface a clear status in the UI instead of silently dropping.
 *
 * Sentinel header is written at the top of every generated file so stale
 * Hubcode-authored files can be removed without clobbering user edits.
 */

const SENTINEL = "<!-- hubcode:command -->";

export interface CommandTarget {
  /** Matches CLI provider id from `shared/cli-provider-registry` or `hubcode-gui`. */
  id: string;
  name: string;
  /** Where to install for scope=global. `null` = unsupported. */
  globalDir: string | null;
  /** Sub-path within a project root for scope=project. `null` = unsupported. */
  projectSubdir: string | null;
  /** File extension for command files. Default .md. */
  ext?: string;
}

export const COMMAND_TARGETS: CommandTarget[] = [
  {
    id: "claude",
    name: "Claude Code",
    globalDir: path.join(os.homedir(), ".claude", "commands"),
    projectSubdir: path.join(".claude", "commands"),
  },
  {
    id: "codex",
    name: "Codex",
    globalDir: path.join(os.homedir(), ".codex", "prompts"),
    projectSubdir: path.join(".codex", "prompts"),
  },
  {
    id: "opencode",
    name: "OpenCode",
    globalDir: path.join(os.homedir(), ".config", "opencode", "command"),
    projectSubdir: path.join(".opencode", "command"),
  },
  {
    id: "cursor",
    name: "Cursor",
    // Cursor has no stable global command dir; only `.cursor/rules` for rules.
    globalDir: null,
    projectSubdir: path.join(".cursor", "commands"),
  },
  {
    id: "gemini",
    name: "Gemini",
    // Gemini uses TOML for commands — not supported yet.
    globalDir: null,
    projectSubdir: null,
  },
  {
    id: "hubcode-gui",
    name: "Hubcode (GUI)",
    // Virtual target — the daemon serves commands directly at runtime.
    globalDir: null,
    projectSubdir: null,
  },
];

export interface CommandAdapterDeps {
  logger: Logger;
  /**
   * Returns the set of CLI provider ids the user has activated/detected on
   * this host (plus "hubcode-gui" which is always active). Used to decide
   * whether a target is currently live; inactive targets still surface in
   * the UI with `agentActive: false` so the user can see "will install when
   * I activate this CLI".
   */
  resolveActiveAgents: () => Promise<Set<string>>;
}

export class CommandAdapter {
  private readonly logger: Logger;
  private readonly resolveActiveAgents: () => Promise<Set<string>>;

  constructor(deps: CommandAdapterDeps) {
    this.logger = deps.logger.child({ module: "command-adapter" });
    this.resolveActiveAgents = deps.resolveActiveAgents;
  }

  /**
   * Write every enabled command to every supported, active target. Targets
   * the command did not opt into (via `targetAgents`) are skipped. For
   * project-scoped commands, writes inside each `projectPaths[i]`.
   */
  async syncAll(enabled: HubcodeCommand[]): Promise<void> {
    const active = await this.resolveActiveAgents();
    for (const target of COMMAND_TARGETS) {
      if (!active.has(target.id)) continue;
      if (target.id === "hubcode-gui") continue; // virtual
      try {
        await this.syncTarget(target, enabled);
      } catch (err) {
        this.logger.warn({ err, target: target.id }, "command sync failed");
      }
    }
  }

  private async syncTarget(target: CommandTarget, enabled: HubcodeCommand[]): Promise<void> {
    const ext = target.ext ?? ".md";
    // Group commands by destination dir.
    const byDir = new Map<string, HubcodeCommand[]>();

    for (const cmd of enabled) {
      if (cmd.targetAgents && cmd.targetAgents.length > 0 && !cmd.targetAgents.includes(target.id))
        continue;

      const dirs = resolveDirsForScope(cmd, target);
      for (const dir of dirs) {
        if (!dir) continue;
        const list = byDir.get(dir) ?? [];
        list.push(cmd);
        byDir.set(dir, list);
      }
    }

    // We also need to clean stale files from any dir we manage. We track by
    // scanning every possible managed dir (globalDir + project dirs) and
    // removing files that carry our sentinel but aren't in the current set.
    const dirsToClean = new Set<string>(byDir.keys());
    if (target.globalDir) dirsToClean.add(target.globalDir);
    // Project dirs are captured via byDir already.

    for (const dir of dirsToClean) {
      const desired = byDir.get(dir) ?? [];
      await this.writeDir(dir, desired, ext);
    }
  }

  private async writeDir(dir: string, cmds: HubcodeCommand[], ext: string): Promise<void> {
    // Avoid creating empty config dirs for CLIs that currently have nothing
    // to install — users will see an empty `~/.codex/prompts/` otherwise.
    let entries: string[] = [];
    let dirExists = false;
    try {
      entries = await fs.readdir(dir);
      dirExists = true;
    } catch {
      // missing
    }
    if (!dirExists && cmds.length === 0) return;
    if (!dirExists) await fs.mkdir(dir, { recursive: true });
    const desiredNames = new Set(cmds.map((c) => `${c.name}${ext}`));
    for (const entry of entries) {
      if (!entry.endsWith(ext)) continue;
      const full = path.join(dir, entry);
      if (desiredNames.has(entry)) continue;
      try {
        const content = await fs.readFile(full, "utf8");
        // Sentinel now lives just after the frontmatter (see renderCommandFile).
        // Check the first ~500 chars to cover small headers without loading
        // large user-authored files end-to-end.
        if (content.slice(0, 500).includes(SENTINEL)) await fs.unlink(full);
      } catch {
        // skip
      }
    }
    // Write current set.
    for (const cmd of cmds) {
      const file = path.join(dir, `${cmd.name}${ext}`);
      const body = renderCommandFile(cmd);
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, body, "utf8");
      await fs.rename(tmp, file);
    }
  }

  async removeAll(): Promise<void> {
    for (const target of COMMAND_TARGETS) {
      if (target.id === "hubcode-gui") continue;
      for (const dir of possibleDirsForTarget(target)) {
        try {
          const entries = await fs.readdir(dir);
          for (const entry of entries) {
            const full = path.join(dir, entry);
            try {
              const content = await fs.readFile(full, "utf8");
              if (content.slice(0, 500).includes(SENTINEL)) await fs.unlink(full);
            } catch {
              // skip
            }
          }
        } catch {
          // dir doesn't exist — nothing to clean
        }
      }
    }
  }

  /** Compute per-agent install status for UI display. */
  async statusFor(cmd: HubcodeCommand): Promise<CommandInstallStatus[]> {
    const active = await this.resolveActiveAgents();
    const statuses: CommandInstallStatus[] = [];
    for (const target of COMMAND_TARGETS) {
      const agentActive = active.has(target.id);
      if (cmd.targetAgents && cmd.targetAgents.length > 0 && !cmd.targetAgents.includes(target.id))
        continue;
      if (target.id === "hubcode-gui") {
        statuses.push({ agentId: target.id, agentActive, status: "installed" });
        continue;
      }
      if (!supportsScope(target, cmd)) {
        statuses.push({
          agentId: target.id,
          agentActive,
          status: "unsupported",
          reason: `${target.name} does not support ${cmd.scope}-scope commands yet.`,
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
      // Probe disk.
      const installed = await probeInstalled(cmd, target);
      statuses.push({
        agentId: target.id,
        agentActive,
        status: installed ? "installed" : "not-installed",
      });
    }
    return statuses;
  }
}

function resolveDirsForScope(cmd: HubcodeCommand, target: CommandTarget): Array<string | null> {
  if (cmd.scope === "global") return [target.globalDir];
  if (cmd.scope === "project") {
    if (!target.projectSubdir) return [null];
    return (cmd.projectPaths ?? []).map((p) => path.join(p, target.projectSubdir as string));
  }
  return [];
}

function possibleDirsForTarget(target: CommandTarget): string[] {
  return target.globalDir ? [target.globalDir] : [];
}

function supportsScope(target: CommandTarget, cmd: HubcodeCommand): boolean {
  if (cmd.scope === "global") return target.globalDir !== null;
  if (cmd.scope === "project") return target.projectSubdir !== null;
  return false;
}

async function probeInstalled(cmd: HubcodeCommand, target: CommandTarget): Promise<boolean> {
  const ext = target.ext ?? ".md";
  const filename = `${cmd.name}${ext}`;
  const candidates: string[] = [];
  if (cmd.scope === "global" && target.globalDir) {
    candidates.push(path.join(target.globalDir, filename));
  }
  if (cmd.scope === "project" && target.projectSubdir) {
    for (const p of cmd.projectPaths ?? []) {
      candidates.push(path.join(p, target.projectSubdir, filename));
    }
  }
  for (const c of candidates) {
    try {
      const stat = await fs.stat(c);
      if (stat.isFile()) return true;
    } catch {
      // not present
    }
  }
  return false;
}

function renderCommandFile(cmd: HubcodeCommand): string {
  // Claude Code, Codex and OpenCode all parse the file as:
  //   <frontmatter: ---\n key: value\n ---> <markdown body>
  // so the sentinel has to go INSIDE the body as an HTML comment — if it
  // sits before the opening `---` the frontmatter is ignored and the host
  // agent ends up showing the sentinel itself as the command description.
  const lines: string[] = ["---"];
  if (cmd.description) lines.push(`description: ${JSON.stringify(cmd.description)}`);
  if (cmd.tags && cmd.tags.length > 0) {
    lines.push(`tags: [${cmd.tags.map((t) => JSON.stringify(t)).join(", ")}]`);
  }
  lines.push("---", SENTINEL, "", cmd.prompt.trim(), "");
  return lines.join("\n");
}
