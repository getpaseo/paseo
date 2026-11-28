import { statSync } from "node:fs";
import { extname, join } from "node:path";

/**
 * How Paseo starts a program through cmd.exe on Windows: `cmd.exe /d /s /c "<line>"`, with the line
 * passed verbatim. The SDK process functions and the daemon's terminals share this one dialect.
 */

export function isWindowsCommandScript(
  executablePath: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const extension = extname(executablePath).toLowerCase();
  return platform === "win32" && (extension === ".cmd" || extension === ".bat");
}

/**
 * Find a bare command name the way cmd.exe would on `PATH`, trying each `PATHEXT` extension. The
 * current directory is not searched. Returns undefined for a name with a path or an extension, and
 * for a name that is not on `PATH`, such as a cmd.exe builtin.
 */
export function findWindowsCommand(name: string, env: NodeJS.ProcessEnv): string | undefined {
  if (name.includes("/") || name.includes("\\") || extname(name)) return undefined;
  const extensions = (readEnv(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const directory of (readEnv(env, "PATH") ?? "").split(";").filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, name + extension);
      if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
    }
  }
  return undefined;
}

/** The cmd.exe that runs a command line: the child's `ComSpec`, else the daemon's. */
export function windowsCommandShell(env: NodeJS.ProcessEnv): string {
  return readEnv(env, "ComSpec") ?? readEnv(process.env, "ComSpec") ?? "cmd.exe";
}

// Windows environment names ignore case, and a copied env object keeps whatever case it had.
function readEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key] || undefined;
}

// The cmd.exe metacharacters, as cross-spawn's `lib/util/escape.js` lists them.
const CMD_METACHARACTERS = /([()\][%!^"`<>&|;, *?])/g;
// A batch script also splits its arguments at `=` and tab.
const NEEDS_ESCAPE = /[()\][%!^"`<>&|;, *?=\t]/u;

/**
 * Escape one argument for a `cmd.exe /c` line by the qntm algorithm (https://qntm.org/cmd), the
 * one cross-spawn's `lib/util/escape.js` implements: quote it for the program's own argv parser,
 * then put a `^` before every cmd.exe metacharacter, the added quotes included. cmd.exe then sees
 * no quoted region, so a `%NAME%` never expands, and the program gets the argument unchanged.
 * `twice` escapes again for a batch script that reads the argument a second time.
 */
function escapeCmdArgument(argument: string, twice: boolean): string {
  const quoted = `"${argument.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  const escaped = quoted.replace(CMD_METACHARACTERS, "^$1");
  return twice ? escaped.replace(CMD_METACHARACTERS, "^$1") : escaped;
}

/**
 * Quote the program path for the start of a cmd.exe line. Inside the quotes cmd.exe reads `&`, `(`
 * and `)` as text, so a path such as `C:\Program Files (x86)\...` starts.
 */
export function quoteWindowsCommand(command: string): string {
  if (command.startsWith('"') && command.endsWith('"')) return command;
  if (command === "" || /[\s()!^"<>&|%;,=]/u.test(command)) return `"${command}"`;
  return command;
}

/**
 * The quoted line for `cmd.exe /d /s /c <line>` that starts `command` with `args`.
 *
 * - An argument without a metacharacter needs no escape and stays as given, so cmd.exe builtins
 *   and batch scripts that read `%1` get it unchanged.
 * - Any other argument is escaped once. A batch script that reads it as `%~1` gets it without the
 *   quotes, and one that forwards it with `%*` hands the program the quoted argument, where cmd.exe
 *   reads every metacharacter as text.
 * - For a batch script (`commandScript`), an argument with a `"` is escaped twice. Its quotes
 *   would otherwise open and close regions when the script reads it again, and leave the
 *   arguments after it outside the quotes.
 *
 * cmd.exe ends a command at a line break whatever the quoting, so an argument with one throws.
 */
export function windowsCommandLine(
  command: string,
  args: readonly string[],
  { commandScript }: { commandScript: boolean },
): string {
  const escaped = args.map((argument) => {
    if (/[\r\n]/u.test(argument)) {
      throw new Error(`cmd.exe cannot pass an argument with a line break to ${command}`);
    }
    if (argument !== "" && !NEEDS_ESCAPE.test(argument)) return argument;
    return escapeCmdArgument(argument, commandScript && argument.includes('"'));
  });
  return `"${[quoteWindowsCommand(command), ...escaped].join(" ")}"`;
}
