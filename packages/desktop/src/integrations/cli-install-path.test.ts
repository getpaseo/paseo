import { describe, expect, it } from "vitest";
import { resolveCliInstallSourcePath } from "./cli-install-path";

describe("cli-install-path", () => {
  it("uses the packaged executable on supported unix platforms", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Hubcode.app/Contents/MacOS/Hubcode",
        shimPath: "/Applications/Hubcode.app/Contents/Resources/bin/hubcode",
      }),
    ).toBe("/Applications/Hubcode.app/Contents/MacOS/Hubcode");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_hubcode123/hubcode",
        shimPath: "/tmp/.mount_hubcode123/resources/bin/hubcode",
        appImagePath: "/home/user/Applications/Hubcode.AppImage",
      }),
    ).toBe("/home/user/Applications/Hubcode.AppImage");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Hubcode\\Hubcode.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Hubcode\\resources\\bin\\hubcode.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Hubcode\\resources\\bin\\hubcode.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Hubcode/hubcode",
        shimPath: "/opt/Hubcode/resources/bin/hubcode",
      }),
    ).toBe("/opt/Hubcode/resources/bin/hubcode");
  });
});
