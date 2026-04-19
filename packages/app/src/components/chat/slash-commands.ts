/**
 * Minimal slash-command framework. Handlers run on the client before the
 * message is sent — they may transform the content (e.g. /me → italic) or
 * suppress the send entirely and emit a side-effect.
 */

export interface SlashCommandContext {
  /** Raw arguments after the command word (everything trailing the first space). */
  args: string;
}

export type SlashCommandResult =
  | { kind: "replace"; content: string }
  | { kind: "suppress" };

export interface SlashCommand {
  name: string;
  description: string;
  handler: (ctx: SlashCommandContext) => SlashCommandResult;
}

const COMMANDS: SlashCommand[] = [
  {
    name: "me",
    description: "Share an action — renders in italics",
    handler: ({ args }) => ({ kind: "replace", content: `_${args.trim()}_` }),
  },
  {
    name: "shrug",
    description: "Append a ¯\\_(ツ)_/¯",
    handler: ({ args }) => ({
      kind: "replace",
      content: `${args.trim()} ¯\\_(ツ)_/¯`.trim(),
    }),
  },
  {
    name: "tableflip",
    description: "Flip a table",
    handler: ({ args }) => ({
      kind: "replace",
      content: `${args.trim()} (╯°□°）╯︵ ┻━┻`.trim(),
    }),
  },
  {
    name: "unflip",
    description: "Put the table back",
    handler: ({ args }) => ({
      kind: "replace",
      content: `${args.trim()} ┬─┬ノ( º_ºノ)`.trim(),
    }),
  },
];

export const slashCommands: readonly SlashCommand[] = COMMANDS;

export function findSlashCommand(content: string): {
  command: SlashCommand;
  args: string;
} | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = trimmed.match(/^\/([a-zA-Z_-]+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  const name = match[1]!.toLowerCase();
  const cmd = COMMANDS.find((c) => c.name === name);
  if (!cmd) return null;
  return { command: cmd, args: match[2] ?? "" };
}

/**
 * Apply a slash command if the input starts with one. Returns:
 *  - `content`: what to actually send (after transformation)
 *  - `suppressed`: true if the input should NOT be sent at all
 *  - `unknown`: true if the input looked like a slash command but wasn't found
 *    (caller may surface an error)
 */
export function applySlashCommand(content: string): {
  content: string;
  suppressed: boolean;
  unknown: boolean;
} {
  const parsed = findSlashCommand(content);
  if (!parsed) {
    // Starts with / but not a known command — still send raw.
    if (content.trimStart().startsWith("/")) {
      return { content, suppressed: false, unknown: true };
    }
    return { content, suppressed: false, unknown: false };
  }
  const result = parsed.command.handler({ args: parsed.args });
  if (result.kind === "suppress") {
    return { content: "", suppressed: true, unknown: false };
  }
  return { content: result.content, suppressed: false, unknown: false };
}
