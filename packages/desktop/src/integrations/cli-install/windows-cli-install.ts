import path from "node:path";

export const WINDOWS_CLI_FORWARD_TARGET = "paseo.target";

export function legacyWindowsCmdTrampoline(shimPath: string): string {
  return [
    "@echo off",
    `set "BUNDLED_CLI=${shimPath}"`,
    `if not exist "%BUNDLED_CLI%" (`,
    `  echo Paseo CLI not found at %BUNDLED_CLI% — is Paseo installed? 1>&2`,
    `  exit /b 1`,
    `)`,
    `call "%BUNDLED_CLI%" %*`,
    `exit /b %errorlevel%`,
  ].join("\r\n");
}

export function windowsCliForwardTargetContents(shimPath: string): string {
  return `${shimPath}\r\n`;
}

export function isWindowsCliForwardTarget(contents: string, shimPath: string): boolean {
  return contents.replace(/^\uFEFF/, "").trim() === shimPath;
}

export function canReplaceWindowsCliExecutable(
  targetExists: boolean,
  ownInstall: boolean,
): boolean {
  return !targetExists || ownInstall;
}

export function isLegacyWindowsCliTrampoline(contents: string, bundledExePath: string): boolean {
  const legacyShim = path.win32.join(path.win32.dirname(bundledExePath), "paseo.cmd");
  return contents.replace(/^\uFEFF/, "") === legacyWindowsCmdTrampoline(legacyShim);
}
