import { describe, expect, it } from "vitest";
import { resolveCliInstallSourcePath } from "./cli-install-path";

describe("cli-install-path", () => {
  it("uses the packaged executable on supported unix platforms", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        shimPath: "/Applications/Paseo.app/Contents/Resources/bin/paseo",
      }),
    ).toBe("/Applications/Paseo.app/Contents/MacOS/Paseo");
  });

  it("falls back to the shim in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: false,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        shimPath: "/Applications/Paseo.app/Contents/Resources/bin/paseo",
      }),
    ).toBe("/Applications/Paseo.app/Contents/Resources/bin/paseo");
  });
});
