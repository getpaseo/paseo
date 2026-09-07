export interface SlashCommandDescriptor {
  name: string;
  aliases?: readonly string[];
}

export type AvailableSlashCommand<
  BuiltIn extends SlashCommandDescriptor,
  Plugin extends SlashCommandDescriptor,
  Provider extends SlashCommandDescriptor,
> =
  | { source: "built-in"; command: BuiltIn }
  | { source: "plugin"; command: Plugin }
  | { source: "provider"; command: Provider };

export function mergeSlashCommandSources<
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
