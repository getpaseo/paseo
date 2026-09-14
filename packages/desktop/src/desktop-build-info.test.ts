import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readDesktopBuildInfo } from "./desktop-build-info";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createAppPackage(metadata: object): string {
  const appPath = mkdtempSync(path.join(os.tmpdir(), "paseo-build-info-"));
  tempDirs.push(appPath);
  writeFileSync(path.join(appPath, "package.json"), JSON.stringify(metadata));
  return appPath;
}

describe("desktop build info", () => {
  it("isolates a local build name and disables release updates", () => {
    const appPath = createAppPackage({ paseoLocalBuild: true });

    expect(readDesktopBuildInfo(appPath)).toEqual({
      appName: "Paseo Local",
      autoUpdateEnabled: false,
    });
  });

  it("keeps release behavior without the local marker", () => {
    const appPath = createAppPackage({});

    expect(readDesktopBuildInfo(appPath)).toEqual({
      appName: "Paseo",
      autoUpdateEnabled: true,
    });
  });
});
