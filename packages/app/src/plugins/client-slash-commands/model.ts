import type { PluginSlashCommandDescriptor } from "@getpaseo/plugin/client";

const PLUGIN_SLASH_COMMAND_NAME = /^[a-z][a-z0-9-]*$/;

export interface SlashCommandDescriptor {
  name: string;
  aliases?: readonly string[];
}

export function normalizePluginSlashCommandProviderCommands(input: {
  pluginId: string;
  providerId: string;
  commands: unknown;
}): PluginSlashCommandDescriptor[] {
  const provider = `${input.pluginId}/${input.providerId}`;
  if (!Array.isArray(input.commands)) {
    throw new Error(`${provider} must return an array of slash commands`);
  }

  const names = new Set<string>();
  return input.commands.map((command) => {
    if (typeof command !== "object" || command === null || Array.isArray(command)) {
      throw new Error(`${provider} returned a slash command that is not an object`);
    }
    const rawName = Reflect.get(command, "name");
    const rawDescription = Reflect.get(command, "description");
    const rawArgumentHint = Reflect.get(command, "argumentHint");
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!PLUGIN_SLASH_COMMAND_NAME.test(name)) {
      throw new Error(`${provider} returned invalid slash command name: ${String(rawName)}`);
    }
    if (names.has(name)) {
      throw new Error(`${provider} returned duplicate slash command: ${name}`);
    }
    const description = typeof rawDescription === "string" ? rawDescription.trim() : "";
    if (!description) {
      throw new Error(`${provider} returned slash command ${name} without a description`);
    }
    if (typeof rawArgumentHint !== "string") {
      throw new Error(`${provider} returned slash command ${name} without an argument hint`);
    }
    names.add(name);
    return { name, description, argumentHint: rawArgumentHint.trim() };
  });
}

export function flattenPluginSlashCommandGroups<Command>(input: {
  groups: readonly {
    staticCommands: readonly Command[];
    providerIndexes: readonly number[];
  }[];
  providerResults: readonly (readonly Command[] | undefined)[];
}): Command[] {
  return input.groups.flatMap((group) => [
    ...group.staticCommands,
    ...group.providerIndexes.flatMap((index) => input.providerResults[index] ?? []),
  ]);
}

export type AvailableSlashCommand<
  BuiltIn extends SlashCommandDescriptor,
  Plugin extends SlashCommandDescriptor,
  Provider extends SlashCommandDescriptor,
> =
  | { source: "built-in"; command: BuiltIn }
  | { source: "plugin"; command: Plugin }
  | { source: "provider"; command: Provider };

export function mergeSlashCommands<
  BuiltIn extends SlashCommandDescriptor,
  Plugin extends SlashCommandDescriptor,
  Provider extends SlashCommandDescriptor,
>(input: {
  builtIn: readonly BuiltIn[];
  plugins: readonly Plugin[];
  provider: readonly Provider[];
  onPluginCollision(command: Plugin, winner: "built-in" | "plugin"): void;
}): Array<AvailableSlashCommand<BuiltIn, Plugin, Provider>> {
  const commands: Array<AvailableSlashCommand<BuiltIn, Plugin, Provider>> = input.builtIn.map(
    (command) => ({ source: "built-in", command }),
  );
  const claimed = new Map<string, "built-in" | "plugin">();
  for (const command of input.builtIn) {
    claimed.set(command.name, "built-in");
    for (const alias of command.aliases ?? []) claimed.set(alias, "built-in");
  }
  for (const command of input.plugins) {
    const winner = claimed.get(command.name);
    if (winner) {
      input.onPluginCollision(command, winner);
      continue;
    }
    claimed.set(command.name, "plugin");
    commands.push({ source: "plugin", command });
  }
  for (const command of input.provider) {
    if (!claimed.has(command.name)) commands.push({ source: "provider", command });
  }
  return commands;
}

export function resolvePluginClientSlashCommand<Command extends SlashCommandDescriptor>(input: {
  text: string;
  hasAttachments: boolean;
  commands: readonly Command[];
}): { command: Command; args: string } | null {
  if (input.hasAttachments) return null;
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(input.text.trim());
  if (!match) return null;
  const command = input.commands.find((candidate) => candidate.name === match[1]);
  return command ? { command, args: (match[2] ?? "").trim() } : null;
}

export function executePluginClientSlashCommand(input: {
  command: { run(args: string): Promise<void> };
  args: string;
  onError(error: unknown): void;
}): void {
  try {
    void input.command.run(input.args).catch(input.onError);
  } catch (error) {
    input.onError(error);
  }
}
