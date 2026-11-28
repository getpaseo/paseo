import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import { cliTargetFileName, resolveCliInstallSourcePath, resolveCliShimPath } from "./path";
import {
  canReplaceWindowsCliExecutable,
  isLegacyWindowsCliTrampoline,
  isWindowsCliForwardTarget,
  legacyWindowsCmdTrampoline,
  windowsCliForwardTargetContents,
} from "./windows-cli-install";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        shimPath: "/Applications/Paseo.app/Contents/Resources/bin/paseo",
      }),
    ).toBe("/Applications/Paseo.app/Contents/Resources/bin/paseo");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_paseo123/paseo",
        shimPath: "/tmp/.mount_paseo123/resources/bin/paseo",
        appImagePath: "/home/user/Applications/Paseo.AppImage",
      }),
    ).toBe("/home/user/Applications/Paseo.AppImage");
  });

  it("uses the bundled shim for packaged linux installs outside an AppImage", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Paseo/Paseo",
        shimPath: "/opt/Paseo/resources/bin/paseo",
      }),
    ).toBe("/opt/Paseo/resources/bin/paseo");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.exe",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.exe");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Paseo/paseo",
        shimPath: "/opt/Paseo/resources/bin/paseo",
      }),
    ).toBe("/opt/Paseo/resources/bin/paseo");
  });
});

describe("CLI executable selection", () => {
  const resolveWorkspaceCli = () =>
    createRequire(import.meta.url).resolve("@getpaseo/cli/bin/paseo");

  it("uses the workspace CLI for an unpackaged Electron launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/nix/store/electron/bin/electron",
        resolveWorkspaceCli,
      }),
    ).toBe(resolveWorkspaceCli());
  });

  it("uses the packaged Windows exe so PowerShell does not rewrite CLI arguments", () => {
    expect(
      resolveCliShimPath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
        resolveWorkspaceCli,
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.exe");
    expect(cliTargetFileName("win32", true)).toBe("paseo.exe");
    expect(cliTargetFileName("win32", false)).toBe("paseo.cmd");
  });

  it("recognizes the legacy Windows cmd trampoline that points at the bundled cmd", () => {
    const bundledExe =
      "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.exe";
    const legacyCmd = "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd";
    const trampoline = legacyWindowsCmdTrampoline(legacyCmd);

    expect(isLegacyWindowsCliTrampoline(trampoline, bundledExe)).toBe(true);
    expect(isWindowsCliForwardTarget(windowsCliForwardTargetContents(bundledExe), bundledExe)).toBe(
      true,
    );
    expect(isLegacyWindowsCliTrampoline(trampoline, "C:\\other\\paseo.exe")).toBe(false);
    expect(canReplaceWindowsCliExecutable(false, false)).toBe(true);
    expect(canReplaceWindowsCliExecutable(true, true)).toBe(true);
    expect(canReplaceWindowsCliExecutable(true, false)).toBe(false);
  });

  it("uses the application shim for a packaged launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Paseo/paseo",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/opt/Paseo", "resources", "bin", "paseo"));
    expect(
      resolveCliShimPath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/Applications/Paseo.app", "Contents", "Resources", "bin", "paseo"));
  });
});
