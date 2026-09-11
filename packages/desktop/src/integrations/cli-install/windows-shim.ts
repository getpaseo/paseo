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
 *
 * A custom install directory outside every known root can still carry
 * non-ASCII characters. cmd.exe decodes each batch line in the code page that
 * is active when it reads that line, so for that case the literal path is
 * written as UTF-8 and the console is switched to code page 65001 for that
 * one line; the value is held as UTF-16 in memory afterwards and the previous
 * code page is put back before anything else runs.
 */

// Ordered longest-first so the most specific root wins when several nest
// (%LOCALAPPDATA% and %APPDATA% both live under %USERPROFILE%).
const ROOT_VARIABLES = [
  "LOCALAPPDATA",
  "APPDATA",
  "PROGRAMFILES(X86)",
  "PROGRAMFILES",
  "USERPROFILE",
] as const;

function normalizeWindowsPath(value: string): string {
  return value.replace(/\//g, "\\").replace(/\\+$/, "").toLowerCase();
}

/** Rewrites the leading root of `shimPath` as `%VARIABLE%` when it lies under one. */
export function windowsShimPathExpression(shimPath: string, env: NodeJS.ProcessEnv): string {
  const normalizedShim = normalizeWindowsPath(shimPath);
  const candidates: Array<{ name: string; value: string; normalized: string }> = [];
  for (const name of ROOT_VARIABLES) {
    const value = env[name];
    if (typeof value === "string" && value.length > 0) {
      candidates.push({ name, value, normalized: normalizeWindowsPath(value) });
    }
  }
  candidates.sort((a, b) => b.normalized.length - a.normalized.length);
  for (const candidate of candidates) {
    if (
      normalizedShim === candidate.normalized ||
      normalizedShim.startsWith(`${candidate.normalized}\\`)
    ) {
      const rest = shimPath
        .slice(candidate.value.replace(/[\\/]+$/, "").length)
        .replace(/^[\\/]+/, "");
      return `%${candidate.name}%\\${rest.replace(/\//g, "\\")}`;
    }
  }
  return shimPath;
}

const NON_ASCII = /[\u0080-\uffff]/;

/** The complete `paseo.cmd` content, CRLF-terminated; ASCII only unless the path forces the UTF-8 fallback. */
export function renderWindowsCliShim(
  shimPath: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const bundled = windowsShimPathExpression(shimPath, env);
  const setBundled = `set "BUNDLED_CLI=${bundled}"`;
  return [
    "@echo off",
    ...(NON_ASCII.test(bundled)
      ? [
          `for /f "tokens=2 delims=:." %%c in ('chcp') do set "PASEO_CODEPAGE=%%c"`,
          ">nul chcp 65001",
          setBundled,
          ">nul chcp %PASEO_CODEPAGE%",
          `set "PASEO_CODEPAGE="`,
        ]
      : [setBundled]),
    `if not exist "%BUNDLED_CLI%" (`,
    `  echo Paseo CLI not found at %BUNDLED_CLI% - is Paseo installed? 1>&2`,
    `  exit /b 1`,
    `)`,
    `call "%BUNDLED_CLI%" %*`,
    `exit /b %errorlevel%`,
  ].join("\r\n");
}
