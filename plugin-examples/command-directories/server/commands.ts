import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import { type CommandDirectory, listCommandsRpc, resolveCommandRpc } from "../shared/commands";

const COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

interface CommandContext {
  workspaceDirectory: string;
  projectRootPath: string;
  directories: CommandDirectory[];
}

interface LoadedCommand {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
}

function commandDirectoryPath(directory: CommandDirectory, context: CommandContext): string {
  if (directory.relativeTo === "absolute") {
    if (!path.isAbsolute(directory.path)) {
      throw new Error(`Absolute command directory requires an absolute path: ${directory.path}`);
    }
    return path.normalize(directory.path);
  }
  if (path.isAbsolute(directory.path)) {
    throw new Error(
      `${directory.relativeTo} command directory requires a relative path: ${directory.path}`,
    );
  }
  const base =
    directory.relativeTo === "workspace" ? context.workspaceDirectory : context.projectRootPath;
  return path.resolve(base, directory.path);
}

async function directoryEntries(directory: string): Promise<Dirent[]> {
  try {
    return await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (typeof error === "object" && error !== null && Reflect.get(error, "code") === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function parseFrontMatter(markdown: string): {
  frontMatter: Record<string, string>;
  body: string;
} {
  const lines = markdown.split("\n");
  if (lines[0]?.trim() !== "---") return { frontMatter: {}, body: markdown };
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) return { frontMatter: {}, body: markdown };

  const frontMatter: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const rawValue = line.slice(separator + 1).trim();
    const value = rawValue.replace(/^['"]/, "").replace(/['"]$/, "");
    if (key && value) frontMatter[key] = value;
  }
  return {
    frontMatter,
    body: lines
      .slice(end + 1)
      .join("\n")
      .trim(),
  };
}

async function loadCommands(context: CommandContext): Promise<Map<string, LoadedCommand>> {
  const commands = new Map<string, LoadedCommand>();
  for (const configuredDirectory of context.directories) {
    const directory = commandDirectoryPath(configuredDirectory, context);
    const entries = (await directoryEntries(directory))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const name = entry.name.slice(0, -".md".length);
      if (!COMMAND_NAME.test(name)) {
        throw new Error(`Invalid command filename: ${path.join(directory, entry.name)}`);
      }
      if (commands.has(name)) continue;
      const markdown = await readFile(path.join(directory, entry.name), "utf8");
      const parsed = parseFrontMatter(markdown);
      commands.set(name, {
        name,
        description: parsed.frontMatter["description"] ?? "Custom command",
        argumentHint:
          parsed.frontMatter["argument-hint"] ?? parsed.frontMatter["argument_hint"] ?? "",
        body: parsed.body,
      });
    }
  }
  return commands;
}

function tokenizeCommandArgs(args: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  for (let index = 0; index < args.length; index += 1) {
    const character = args[index];
    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  if (current) tokens.push(current);
  return tokens;
}

function expandCommand(template: string, args: string): string {
  const trimmedArgs = args.trim();
  const named = new Map<string, string>();
  const positional: string[] = [];
  for (const token of tokenizeCommandArgs(trimmedArgs)) {
    const separator = token.indexOf("=");
    if (separator > 0) {
      named.set(token.slice(0, separator), token.slice(separator + 1));
    } else {
      positional.push(token);
    }
  }

  const dollarPlaceholder = "__PASEO_COMMAND_DOLLAR__";
  let prompt = template.split("$$").join(dollarPlaceholder);
  prompt = prompt.split("$ARGUMENTS").join(trimmedArgs);
  for (let index = 1; index <= 9; index += 1) {
    prompt = prompt.split(`$${index}`).join(positional[index - 1] ?? "");
  }
  const namedKeys = [...named.keys()].sort((left, right) => right.length - left.length);
  for (const key of namedKeys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    prompt = prompt.replace(new RegExp(`\\$${escaped}\\b`, "g"), named.get(key) ?? "");
  }
  return prompt.split(dollarPlaceholder).join("$");
}

export async function listCommands(
  input: RpcInput<typeof listCommandsRpc>,
): Promise<RpcOutput<typeof listCommandsRpc>> {
  const commands = await loadCommands(input);
  return {
    commands: [...commands.values()]
      .map(({ name, description, argumentHint }) => ({ name, description, argumentHint }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

export async function resolveCommand(
  input: RpcInput<typeof resolveCommandRpc>,
): Promise<RpcOutput<typeof resolveCommandRpc>> {
  const commands = await loadCommands(input);
  const command = commands.get(input.name);
  if (!command) throw new Error(`Command is unavailable in this workspace: ${input.name}`);
  return { prompt: expandCommand(command.body, input.args) };
}
