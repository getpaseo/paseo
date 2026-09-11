/**
 * Renders the `paseo.cmd` trampoline the desktop app installs into
 * `%USERPROFILE%\.local\bin` on Windows.
 *
 * cmd.exe reads batch files in the console's OEM code page, not UTF-8, so a
 * non-ASCII character in the baked-in install path (a user name such as
 * `C:\Users\卢泓锦\...`) is decoded as mojibake and the shim never finds the
 * bundled CLI. The path is therefore expressed through the environment
 * variable it lives under (`%LOCALAPPDATA%`, `%APPDATA%`, `%USERPROFILE%`,
 * `%PROGRAMFILES%`, ...): cmd.exe expands the variable in memory, so its
 * bytes on disk stay ASCII. Everything else in the file is ASCII as well.
 */

// Ordered longest-first so the most specific root wins when several nest
// (%LOCALAPPDATA% and %APPDATA% both live under %USERPROFILE%).
const ROOT_VARIABLES = ["LOCALAPPDATA", "APPDATA", "PROGRAMFILES(X86)", "PROGRAMFILES", "USERPROFILE"] as const;

function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** Rewrites the leading root of `shimPath` as `%VARIABLE%` when it lies under one. */
export function windowsShimPathExpression(shimPath: string, env: NodeJS.ProcessEnv): string {
  const normalizedShim = normalizeWindowsPath(shimPath);
  const candidates = ROOT_VARIABLES.map((name) => ({ name, value: env[name] }))
    .filter((entry): entry is { name: string; value: string } => typeof entry.value === "string" && entry.value.length > 0)
    .map((entry) => ({ ...entry, normalized: normalizeWindowsPath(entry.value) }))
    .sort((a, b) => b.normalized.length - a.normalized.length);
  for (const candidate of candidates) {
    if (normalizedShim === candidate.normalized || normalizedShim.startsWith(`${candidate.normalized}\\`)) {
      const rest = shimPath.slice(candidate.value.replace(/[\\/]+$/, "").length).replace(/^[\\/]+/, "");
      return `%${candidate.name}%\\${rest.replace(/\//g, "\\")}`;
    }
  }
  return shimPath;
}

/** The complete `paseo.cmd` content, CRLF-terminated and ASCII only. */
export function renderWindowsCliShim(shimPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const bundled = windowsShimPathExpression(shimPath, env);
  return [
    "@echo off",
    `set "BUNDLED_CLI=${bundled}"`,
    `if not exist "%BUNDLED_CLI%" (`,
    `  echo Paseo CLI not found at %BUNDLED_CLI% - is Paseo installed? 1>&2`,
    `  exit /b 1`,
    `)`,
    `call "%BUNDLED_CLI%" %*`,
    `exit /b %errorlevel%`,
  ].join("\r\n");
}
