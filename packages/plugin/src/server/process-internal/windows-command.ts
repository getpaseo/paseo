import { extname } from "node:path";

export function isWindowsCommandScript(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const extension = extname(executablePath).toLowerCase();
  return platform === "win32" && (extension === ".cmd" || extension === ".bat");
}

/**
 * When spawning with `shell: true` on Windows, the command is passed to
 * `cmd.exe /d /s /c "command args"`. The `/s` strips outer quotes, so a
 * command path with spaces (e.g. `C:\Program Files\...`) is split at the
 * space. Wrapping it in quotes produces the correct `"C:\Program Files\..." args`.
 * Inside the quotes cmd.exe reads `&`, `(` and `)` as text, so a path such as
 * `C:\Program Files (x86)\...` needs no `^`.
 */
export function quoteWindowsCommand(
  command: string,
  platform: NodeJS.Platform = process.platform,
): string {
  if (platform !== "win32") return command;
  if (command.startsWith('"') && command.endsWith('"')) return command;
  if (command === "" || /[\s()!^"<>&|]/u.test(command)) return `"${command}"`;
  return command;
}

// A `^` makes the next character literal outside a quoted region. `%` and `!` expand only once,
// because cmd.exe does not expand the text a script's `%*` produces; the others are read again.
const EXPANDED_ONCE = /[%!]/u;
const READ_AS_SYNTAX = /[&|<>()^"]/u;
// A script splits its arguments at `=`, `,` and `;` outside quotes, and reads the syntax again.
const SPLIT_BY_SCRIPT = /[&|<>()^=,;]/u;

function escapeOutsideQuotes(character: string, commandScript: boolean): string {
  if (EXPANDED_ONCE.test(character)) return `^${character}`;
  if (READ_AS_SYNTAX.test(character)) return commandScript ? `^^^${character}` : `^${character}`;
  return character;
}

/** Quote the argument the way programs split their command line. */
function quoteForProgram(argument: string): string {
  return `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
}

/**
 * Escape a quoted argument for cmd.exe. Each `"` switches cmd.exe in or out of a quoted region,
 * where everything is text, so only the parts outside a region are escaped. A closing quote that
 * would open a region is escaped instead, so the next argument starts outside one.
 */
function escapeQuotedForCmd(quoted: string, commandScript: boolean): string {
  const characters = [...quoted];
  let inside = false;
  let escaped = "";
  for (const [index, character] of characters.entries()) {
    const closing = index === characters.length - 1;
    if (character === '"' && (inside || !closing)) {
      inside = !inside;
      escaped += character;
    } else {
      escaped += inside ? character : escapeOutsideQuotes(character, commandScript);
    }
  }
  return escaped;
}

/**
 * Quote one argument for the `cmd.exe /d /s /c "..."` line that `spawn(..., { shell: true })`
 * builds on Windows, so the program receives it unchanged.
 *
 * A plain argument stays as it is, so cmd.exe builtins and scripts that read `%1` get it as
 * given. An argument with whitespace or a quote, or an empty one, is quoted for the program;
 * cmd.exe keeps the text inside the quotes and `%~1` removes them. A `.cmd` or `.bat` script
 * splits its arguments at `=`, `,` and `;` as well, and reads them a second time when it forwards
 * them with `%*`. So for `commandScript` an argument with one of those or with cmd.exe syntax is
 * quoted too, and syntax outside quotes is escaped for both reads. A script then gets each one as
 * a single `%~1`, and `%*` forwards it unchanged.
 *
 * Inside quotes cmd.exe still expands a `%NAME%` that names a set variable.
 */
export function quoteWindowsArgument(
  argument: string,
  { platform = process.platform, commandScript = false } = {},
): string {
  if (platform !== "win32") return argument;
  const quote =
    argument === "" || /[\s"]/u.test(argument) || (commandScript && SPLIT_BY_SCRIPT.test(argument));
  if (!quote) {
    return [...argument].map((character) => escapeOutsideQuotes(character, false)).join("");
  }
  return escapeQuotedForCmd(quoteForProgram(argument), commandScript);
}
