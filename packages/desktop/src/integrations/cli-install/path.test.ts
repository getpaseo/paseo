import { basename } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveCliInstallSourcePath } from "./path";
import { getBundledCliShimPath, getCliTargetPath } from "./paths";

vi.mock("electron", () => ({
  app: { getPath: () => "/Applications/PandaOS.app/Contents/MacOS/PandaOS" },
}));

describe("cli-install-path", () => {
  it("installs the bundled pandaos command", () => {
    const filename = process.platform === "win32" ? "pandaos.cmd" : "pandaos";
    expect(basename(getCliTargetPath())).toBe(filename);
    expect(basename(getBundledCliShimPath())).toBe(filename);
  });

  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        shimPath: "/Applications/Paseo.app/Contents/Resources/bin/pandaos",
      }),
    ).toBe("/Applications/Paseo.app/Contents/Resources/bin/pandaos");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_paseo123/paseo",
        shimPath: "/tmp/.mount_paseo123/resources/bin/pandaos",
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
        shimPath: "/opt/Paseo/resources/bin/pandaos",
      }),
    ).toBe("/opt/Paseo/resources/bin/pandaos");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\pandaos.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\pandaos.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Paseo/paseo",
        shimPath: "/opt/Paseo/resources/bin/pandaos",
      }),
    ).toBe("/opt/Paseo/resources/bin/pandaos");
  });
});
