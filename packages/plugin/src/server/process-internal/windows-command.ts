import { extname } from "node:path";

export function isWindowsCommandScript(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const extension = extname(executablePath).toLowerCase();
  return platform === "win32" && (extension === ".cmd" || extension === ".bat");
}

// cmd.exe reads these as syntax outside a quoted region. A `^` before each one makes it literal.
const CMD_METACHARACTERS = /([()%!^"<>&|])/g;

function escapeCmdMetacharacters(value: string): string {
  return value.replace(CMD_METACHARACTERS, "^$1");
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

/**
 * Quote one argument for the `cmd.exe /d /s /c "..."` line that `spawn(..., { shell: true })`
 * builds on Windows, so the program receives it unchanged.
 *
 * The argument is quoted the way programs split their command line (backslashes before a quote
 * doubled, the quote escaped), then every cmd.exe metacharacter is escaped with `^`, including
 * those quotes. cmd.exe then sees no quoted region and keeps `&`, `%` and the others as text.
 * A `.cmd` or `.bat` script reads its arguments a second time when it forwards them with `%*`,
 * so `commandScript` escapes them twice. See https://qntm.org/cmd.
 *
 * cmd.exe has no escape for a line break, so a CR or LF still ends the command.
 */
export function quoteWindowsArgument(
  argument: string,
  { platform = process.platform, commandScript = false } = {},
): string {
  if (platform !== "win32") return argument;
  const quoted = `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const escaped = escapeCmdMetacharacters(quoted);
  return commandScript ? escapeCmdMetacharacters(escaped) : escaped;
}
