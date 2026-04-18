import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

export type SkillInfo = {
  name: string;
  description: string;
  filePath: string;
};

/**
 * Scans skill directories for markdown skill files, parses their YAML
 * frontmatter, and provides skill content for system prompt injection.
 *
 * Supports two layouts:
 *   - Single file: skills/my-skill.md
 *   - Directory:   skills/my-skill/SKILL.md
 */
export class SkillManager {
  private skills = new Map<string, SkillInfo>();

  constructor(private dirs: string[]) {}

  /** Scan all configured directories and populate the skill catalog. */
  scan(): void {
    this.skills.clear();
    for (const dir of this.dirs) {
      const resolved = dir.startsWith("~") ? path.join(os.homedir(), dir.slice(1)) : dir;
      if (!existsSync(resolved)) continue;

      let entries: string[];
      try {
        entries = readdirSync(resolved);
      } catch {
        continue;
      }

      for (const entry of entries) {
        const fullPath = path.join(resolved, entry);
        const stat = statSync(fullPath, { throwIfNoEntry: false });
        if (!stat) continue;

        if (stat.isFile() && entry.endsWith(".md")) {
          this.tryLoadSkill(fullPath, entry.replace(/\.md$/, ""));
        } else if (stat.isDirectory()) {
          const skillMd = path.join(fullPath, "SKILL.md");
          if (existsSync(skillMd)) {
            this.tryLoadSkill(skillMd, entry);
          }
        }
      }
    }
  }

  /** Return all discovered skills. */
  list(): SkillInfo[] {
    return [...this.skills.values()];
  }

  /** Get a skill by name. */
  get(name: string): SkillInfo | undefined {
    return this.skills.get(name);
  }

  /** Read the full markdown content of a skill (for system prompt injection). */
  getContent(name: string): string | null {
    const skill = this.skills.get(name);
    if (!skill) return null;
    try {
      return readFileSync(skill.filePath, "utf-8");
    } catch {
      return null;
    }
  }

  /** Format skills as ACP available commands. */
  toAvailableCommands(): Array<{ name: string; description: string }> {
    return this.list().map((s) => ({
      name: s.name,
      description: s.description,
    }));
  }

  private tryLoadSkill(filePath: string, fallbackName: string): void {
    try {
      const raw = readFileSync(filePath, "utf-8");
      const fm = parseFrontmatter(raw);
      const name = fm.name || fallbackName;
      const description = fm.description || `Skill: ${name}`;

      // Don't overwrite if already loaded (first directory wins)
      if (!this.skills.has(name)) {
        this.skills.set(name, { name, description, filePath });
      }
    } catch {
      // Skip unreadable files
    }
  }
}

/** Parse YAML frontmatter from a markdown file. */
function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};

  const result: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/** Try to read CLAUDE.md from a directory (for project context injection). */
export function loadProjectContext(cwd: string): string | null {
  const candidates = [path.join(cwd, "CLAUDE.md"), path.join(cwd, ".claude", "CLAUDE.md")];

  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) {
        return readFileSync(candidate, "utf-8");
      }
    } catch {
      continue;
    }
  }
  return null;
}

/** Resolve default skill directories from environment + well-known paths. */
export function resolveSkillDirs(): string[] {
  const dirs: string[] = [];

  // User's Claude Code skills
  const claudeSkills = path.join(os.homedir(), ".claude", "skills");
  if (existsSync(claudeSkills)) {
    dirs.push(claudeSkills);
  }

  // Configurable via environment variable (colon-separated)
  const envDirs = process.env.OPENROUTER_SKILL_DIRS?.trim();
  if (envDirs) {
    for (const d of envDirs.split(":")) {
      const resolved = d.startsWith("~") ? path.join(os.homedir(), d.slice(1)) : d;
      if (existsSync(resolved)) {
        dirs.push(resolved);
      }
    }
  }

  return dirs;
}
