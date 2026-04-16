import { execSync } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { AgentSlashCommand } from "../agent-sdk-types.js";
import { slugify } from "../../../utils/worktree.js";

const DROID_BUILTIN_SLASH_COMMANDS: readonly AgentSlashCommand[] = [
  { name: "account", description: "Open Factory account settings in browser", argumentHint: "" },
  { name: "billing", description: "View and manage billing settings", argumentHint: "" },
  { name: "bg-process", description: "Manage background processes", argumentHint: "" },
  {
    name: "bug",
    description: "Create a bug report with session data and logs",
    argumentHint: "[title]",
  },
  { name: "clear", description: "Start a new session", argumentHint: "" },
  { name: "commands", description: "Manage custom slash commands", argumentHint: "" },
  {
    name: "compress",
    description: "Compress session and move to new one with summary",
    argumentHint: "[prompt]",
  },
  { name: "cost", description: "Show token usage statistics", argumentHint: "" },
  {
    name: "create-skill",
    description: "Create a reusable skill from current session",
    argumentHint: "",
  },
  { name: "droids", description: "Manage custom droids", argumentHint: "" },
  { name: "enter-mission", description: "Enter Mission mode", argumentHint: "" },
  { name: "favorite", description: "Mark current session as a favorite", argumentHint: "" },
  {
    name: "fork",
    description: "Duplicate current session with all messages into a new session",
    argumentHint: "",
  },
  { name: "generate_blog", description: "Generate semantic diff blog post", argumentHint: "" },
  { name: "help", description: "Show available slash commands", argumentHint: "" },
  { name: "hooks", description: "Manage lifecycle hooks", argumentHint: "" },
  { name: "ide", description: "Configure IDE integrations", argumentHint: "" },
  { name: "install-github-app", description: "Install Factory GitHub App", argumentHint: "" },
  { name: "login", description: "Sign in to Factory", argumentHint: "" },
  { name: "logout", description: "Sign out of Factory", argumentHint: "" },
  { name: "mcp", description: "Manage Model Context Protocol servers", argumentHint: "" },
  { name: "mission", description: "Open Mission Control", argumentHint: "" },
  { name: "missions", description: "List and select missions to resume", argumentHint: "" },
  { name: "model", description: "Switch AI model mid-session", argumentHint: "" },
  { name: "new", description: "Start a new session", argumentHint: "" },
  { name: "plugins", description: "Manage plugins and marketplaces", argumentHint: "" },
  { name: "quit", description: "Exit droid", argumentHint: "" },
  { name: "readiness-report", description: "Generate readiness report", argumentHint: "" },
  { name: "rename", description: "Rename current session", argumentHint: "" },
  { name: "review", description: "Start AI-powered code review workflow", argumentHint: "" },
  {
    name: "rewind-conversation",
    description: "Undo recent changes in the session",
    argumentHint: "",
  },
  { name: "sessions", description: "List and select previous sessions", argumentHint: "" },
  { name: "settings", description: "Configure application settings", argumentHint: "" },
  { name: "share", description: "Share session with organization", argumentHint: "" },
  { name: "skills", description: "Manage and invoke skills", argumentHint: "" },
  { name: "status", description: "Show current droid status and configuration", argumentHint: "" },
  { name: "statusline", description: "Configure custom status line", argumentHint: "" },
  {
    name: "terminal-setup",
    description: "Configure terminal keybindings for Shift+Enter",
    argumentHint: "",
  },
  { name: "wrapped", description: "Show Droid usage statistics", argumentHint: "" },
];

type ParsedFrontMatter = {
  frontMatter: Record<string, string>;
};

function parseFrontMatter(markdown: string): ParsedFrontMatter {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith("---")) {
    return { frontMatter: {} };
  }

  const newline = trimmed.indexOf("\n");
  if (newline === -1) {
    return { frontMatter: {} };
  }

  const endMarker = trimmed.indexOf("\n---", newline + 1);
  if (endMarker === -1) {
    return { frontMatter: {} };
  }

  const frontMatterText = trimmed.slice(newline + 1, endMarker).trim();
  const frontMatter: Record<string, string> = {};

  const lines = frontMatterText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }

    const key = line.slice(0, idx).trim().toLowerCase();
    let value = line.slice(idx + 1).trim();

    if ((value === ">" || value === "|") && key) {
      const separator = value === "|" ? "\n" : " ";
      const blockLines: string[] = [];
      while (index + 1 < lines.length) {
        const nextLine = lines[index + 1] ?? "";
        if (!/^\s+/.test(nextLine)) {
          break;
        }
        blockLines.push(nextLine.trim());
        index += 1;
      }
      value = blockLines.join(separator).trim();
    }

    value = value.replace(/^['"]/, "").replace(/['"]$/, "");
    if (key && value) {
      frontMatter[key] = value;
    }
  }

  return { frontMatter };
}

function parseBoolean(value: string | undefined): boolean | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no"].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "");
}

function normalizeSlashCommand(command: AgentSlashCommand): AgentSlashCommand | null {
  const name = normalizeCommandName(command.name);
  if (!name) {
    return null;
  }

  return {
    name,
    description: command.description.trim(),
    argumentHint: command.argumentHint.trim(),
  };
}

function mergeSlashCommands(
  ...lists: ReadonlyArray<ReadonlyArray<AgentSlashCommand>>
): AgentSlashCommand[] {
  const commandsByName = new Map<string, AgentSlashCommand>();

  for (const list of lists) {
    for (const command of list) {
      const normalized = normalizeSlashCommand(command);
      if (!normalized || commandsByName.has(normalized.name)) {
        continue;
      }
      commandsByName.set(normalized.name, normalized);
    }
  }

  return Array.from(commandsByName.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function resolveRepoRoot(cwd: string): string | null {
  try {
    const output = execSync("git rev-parse --show-toplevel", {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const trimmed = output.trim();
    return trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

function getWorkspaceRoots(cwd: string): string[] {
  const resolvedCwd = path.resolve(cwd);
  const repoRoot = resolveRepoRoot(resolvedCwd);
  if (!repoRoot) {
    return [resolvedCwd];
  }

  const roots: string[] = [];
  let current = resolvedCwd;
  while (true) {
    roots.push(current);
    if (current === repoRoot) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return roots;
}

async function readDirents(directoryPath: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(directoryPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function readOptionalFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function isShebangFile(filePath: string): Promise<boolean> {
  const content = await readOptionalFile(filePath);
  return content?.startsWith("#!") ?? false;
}

async function listLegacySlashCommands(rootPath: string): Promise<AgentSlashCommand[]> {
  const commandsDir = path.join(rootPath, ".factory", "commands");
  const entries = await readDirents(commandsDir);
  const commands: AgentSlashCommand[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const fullPath = path.join(commandsDir, entry.name);
    const ext = path.extname(entry.name).toLowerCase();
    const isMarkdown = ext === ".md";
    const isExecutable = !isMarkdown && (await isShebangFile(fullPath));
    if (!isMarkdown && !isExecutable) {
      continue;
    }

    const baseName = path.basename(entry.name, ext);
    const name = slugify(baseName);
    if (!name) {
      continue;
    }

    const content = await readOptionalFile(fullPath);
    const { frontMatter } = parseFrontMatter(content ?? "");
    commands.push({
      name,
      description:
        frontMatter.description ??
        (isExecutable ? "Executable custom command" : "Custom slash command"),
      argumentHint: frontMatter["argument-hint"] ?? frontMatter.argument_hint ?? "",
    });
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function readSkillMarkdown(skillDir: string): Promise<string | null> {
  const candidates = ["SKILL.md", "skill.mdx"];
  for (const candidate of candidates) {
    const content = await readOptionalFile(path.join(skillDir, candidate));
    if (content !== null) {
      return content;
    }
  }
  return null;
}

async function listSkillsFromDirectory(skillsDir: string): Promise<AgentSlashCommand[]> {
  const entries = await readDirents(skillsDir);
  const commands: AgentSlashCommand[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }

    const skillDir = path.join(skillsDir, entry.name);
    const content = await readSkillMarkdown(skillDir);
    if (content === null) {
      continue;
    }

    const { frontMatter } = parseFrontMatter(content);
    if (parseBoolean(frontMatter["user-invocable"]) === false) {
      continue;
    }

    const configuredName = frontMatter.name?.trim();
    const name = normalizeCommandName(configuredName || slugify(entry.name));
    if (!name) {
      continue;
    }

    commands.push({
      name,
      description: frontMatter.description ?? "Skill",
      argumentHint: frontMatter["argument-hint"] ?? frontMatter.argument_hint ?? "",
    });
  }

  return commands.sort((a, b) => a.name.localeCompare(b.name));
}

async function listWorkspaceAndPersonalSlashCommands(cwd: string): Promise<AgentSlashCommand[]> {
  const roots = getWorkspaceRoots(cwd);
  const personalRoot = homedir();
  const customLists: AgentSlashCommand[][] = [];

  for (const root of roots) {
    customLists.push(await listSkillsFromDirectory(path.join(root, ".factory", "skills")));
    customLists.push(await listSkillsFromDirectory(path.join(root, ".agent", "skills")));
    customLists.push(await listLegacySlashCommands(root));
  }

  customLists.push(await listSkillsFromDirectory(path.join(personalRoot, ".factory", "skills")));
  customLists.push(await listLegacySlashCommands(personalRoot));

  return mergeSlashCommands(...customLists);
}

export async function listDroidSlashCommands(
  cwd: string,
  baseCommands: readonly AgentSlashCommand[] = [],
): Promise<AgentSlashCommand[]> {
  const customCommands = await listWorkspaceAndPersonalSlashCommands(cwd);
  return mergeSlashCommands(baseCommands, customCommands, DROID_BUILTIN_SLASH_COMMANDS);
}
