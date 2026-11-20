import { extname } from "node:path";

export function isWindowsCommandScript(executablePath: string): boolean {
  const extension = extname(executablePath).toLowerCase();
  return process.platform === "win32" && (extension === ".cmd" || extension === ".bat");
}

function escapeWindowsCmdValue(value: string): string {
  if (process.platform !== "win32") return value;

  const isQuoted = value.startsWith('"') && value.endsWith('"');
  const unquoted = isQuoted ? value.slice(1, -1) : value;
  // Do NOT double `%` here. cmd.exe only collapses `%%` → `%` inside batch
  // files; on the command line / `cmd /c "..."` `%%` stays literal, which
  // breaks args like git's `--format=%(refname)` (git treats `%%` as the
  // escape for a literal `%`, so the format atoms become literals).
  const escaped = unquoted.replace(/([&|^<>()!])/g, "^$1");

  if (isQuoted || /[\s"]/u.test(unquoted)) {
    const quoted = escaped
      .replace(/(\\*)"/g, (_match, slashes: string) => `${slashes}${slashes}\\"`)
      .replace(/\\+$/u, (slashes) => `${slashes}${slashes}`);
    return `"${quoted}"`;
  }

  return escaped;
}

/**
 * When spawning with `shell: true` on Windows, the command is passed to
 * `cmd.exe /d /s /c "command args"`. The `/s` strips outer quotes, so a
 * command path with spaces (e.g. `C:\Program Files\...`) is split at the
 * space. Wrapping it in quotes produces the correct `"C:\Program Files\..." args`.
 */
export function quoteWindowsCommand(command: string): string {
  return escapeWindowsCmdValue(command);
}

/**
 * `spawn(..., { shell: true })` on Windows also passes argv through `cmd.exe`.
 * Any argument containing spaces must be quoted or it will be split before the
 * child process sees it.
 */
export function quoteWindowsArgument(argument: string): string {
  return escapeWindowsCmdValue(argument);
}
