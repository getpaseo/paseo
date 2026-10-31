import { promises as fs } from "node:fs";
import path from "node:path";

import type { AgentSlashCommand } from "../agent-sdk-types.js";

/**
 * Skills an ACP agent advertised itself. The agent expands `/name` into the
 * skill body itself, so Paseo must not expand these a second time.
 */
export interface DiscoveredACPSkill {
  name: string;
  description: string;
  argumentHint: string;
  /** The skill body, used when Paseo expands the command itself. */
  body: string;
  /** Absolute path of the SKILL.md the skill was read from. */
  source: string;
}

export interface ACPSkillDiscoveryOptions {
  /** Directory holding `<name>/SKILL.md` directories. */
  roots: readonly string[];
}

/**
 * A skill directory is a real directory or a symlink to one. `Dirent.isDirectory()`
 * is false for a symlink, so a plain `isDirectory()` filter drops every linked
 * skill — which is how agent homes that link their skills in from a shared
 * checkout end up invisible.
 */
function isDirectoryEntry(entry: { isDirectory(): boolean; isSymbolicLink(): boolean }): boolean {
  return entry.isDirectory() || entry.isSymbolicLink();
}

/**
 * Split a leading `---` YAML frontmatter block off a markdown file.
 *
 * Deliberately not a YAML parser: skill frontmatter is flat `key: value`
 * lines, and a dependency would not pay for itself. Anything unparseable is
 * dropped, and the caller falls back to the body.
 */
function splitFrontMatter(contents: string): { frontMatter: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(contents);
  if (!match) {
    return { frontMatter: {}, body: contents };
  }

  const frontMatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line
      .slice(separator + 1)
      .trim()
      .replace(/^["'](.*)["']$/, "$1")
      .trim();
    if (key.length > 0 && value.length > 0) {
      frontMatter[key] = value;
    }
  }

  return { frontMatter, body: contents.slice(match[0].length) };
}

function describeSkill(frontMatter: Record<string, string>, body: string, name: string): string {
  const candidates = [
    frontMatter["description"],
    /^#{1,6}[ \t]+(.+)$/m.exec(body)?.[1],
    body
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#")),
  ];
  for (const candidate of candidates) {
    const text = candidate?.replace(/\s+/g, " ").trim();
    if (text) {
      return text;
    }
  }
  return `Run the /${name} skill.`;
}

/**
 * Read one skill directory. Returns null when it holds no readable SKILL.md.
 */
async function readSkill(
  skillDir: string,
  fallbackName: string,
): Promise<DiscoveredACPSkill | null> {
  const skillPath = path.join(skillDir, "SKILL.md");
  const contents = await fs.readFile(skillPath, "utf8").catch(() => null);
  if (contents === null) {
    return null;
  }

  const { frontMatter, body } = splitFrontMatter(contents);
  const name = frontMatter["name"]?.trim() || fallbackName;
  return {
    name,
    description: describeSkill(frontMatter, body, name),
    argumentHint: frontMatter["argument-hint"] ?? frontMatter["argument_hint"] ?? "",
    body: body.trim(),
    source: skillPath,
  };
}

/**
 * Discover the skills installed in the given roots.
 *
 * Earlier roots win, matching the precedence Paseo already applies to its own
 * managed skill copies: a project-level skill shadows a user-level one with the
 * same name.
 */
export async function discoverACPSkills(
  options: ACPSkillDiscoveryOptions,
): Promise<DiscoveredACPSkill[]> {
  const byName = new Map<string, DiscoveredACPSkill>();

  for (const root of options.roots) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const skillDirs = entries.filter(isDirectoryEntry).map((entry) => path.join(root, entry.name));

    const skills = await Promise.all(
      skillDirs.map((skillDir) => readSkill(skillDir, path.basename(skillDir))),
    );

    for (const skill of skills) {
      if (!skill || byName.has(skill.name)) {
        continue;
      }
      byName.set(skill.name, skill);
    }
  }

  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function toSlashCommand(skill: DiscoveredACPSkill): AgentSlashCommand {
  return {
    name: skill.name,
    description: skill.description,
    argumentHint: skill.argumentHint,
    kind: "skill",
  };
}

/**
 * Match a prompt against the discovered skills.
 *
 * Returns undefined for anything that is not a leading `/name` the caller
 * knows, so prose that happens to start with a slash still reaches the model
 * untouched.
 */
export function parseACPSkillInvocation(
  text: string,
  skills: readonly DiscoveredACPSkill[],
): { skill: DiscoveredACPSkill; args: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) {
    return undefined;
  }
  const skill = skills.find((candidate) => candidate.name === match[1]);
  if (!skill) {
    return undefined;
  }
  return { skill, args: match[2]?.trim() ?? "" };
}

/**
 * Render an invoked skill as the user message the model actually sees.
 *
 * The body is presented as instructions rather than as opaque data: the user
 * explicitly typed `/name`, so running what that file says *is* the request.
 * `$ARGUMENTS` is substituted where the definition asks for it, which is the
 * convention `SKILL.md` files are written against.
 */
export function renderACPSkillInvocation(invocation: {
  skill: DiscoveredACPSkill;
  args: string;
}): string {
  const { skill, args } = invocation;
  const usesPlaceholder = skill.body.includes("$ARGUMENTS");
  const body = usesPlaceholder ? skill.body.replaceAll("$ARGUMENTS", args) : skill.body;
  const lines = [
    `<skill name="${skill.name}" source="${skill.source}">`,
    `The user invoked the /${skill.name} skill. Follow the instructions below.`,
    "",
    body,
  ];
  if (args.length > 0 && !usesPlaceholder) {
    lines.push("", `Arguments: ${args}`);
  }
  lines.push("</skill>");
  return lines.join("\n");
}
