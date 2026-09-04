import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { collectDesktopUpdaterDiagnostics } from "./updater";

let testDirectory = "";

afterEach(() => {
  if (testDirectory) {
    rmSync(testDirectory, { recursive: true, force: true });
    testDirectory = "";
  }
});

describe("desktop updater diagnostics", () => {
  it("collects the staged version and existing ShipIt evidence", () => {
    testDirectory = mkdtempSync(path.join(tmpdir(), "paseo-updater-diagnostics-"));
    const shipItDirectory = path.join(testDirectory, "sh.paseo.desktop.ShipIt");
    const updateBundlePath = path.join(shipItDirectory, "update.test", "Paseo.app");
    mkdirSync(shipItDirectory, { recursive: true });
    writeFileSync(
      path.join(shipItDirectory, "ShipItState.plist"),
      JSON.stringify({
        launchAfterInstallation: true,
        updateBundleURL: pathToFileURL(updateBundlePath).href,
      }),
    );
    writeFileSync(path.join(shipItDirectory, "ShipIt_stdout.log"), "stdout evidence\n");
    writeFileSync(path.join(shipItDirectory, "ShipIt_stderr.log"), "stderr evidence\n");

    const diagnostics = collectDesktopUpdaterDiagnostics({
      platform: "darwin",
      currentVersion: "0.7.0",
      cachePath: testDirectory,
      readBundleVersion: (bundlePath) => (bundlePath === updateBundlePath ? "0.7.2" : null),
    });

    expect(diagnostics.currentVersion).toBe("0.7.0");
    expect(diagnostics.targetVersion).toBe("0.7.2");
    expect(diagnostics.shipItDirectory).toBe(shipItDirectory);
    expect(diagnostics.state).toMatchObject({ exists: true });
    expect(diagnostics.stdout).toMatchObject({
      exists: true,
      contents: "stdout evidence",
    });
    expect(diagnostics.stderr).toMatchObject({
      exists: true,
      contents: "stderr evidence",
    });
    expect(diagnostics.state?.modifiedAt).not.toBeNull();
  });

  it("does not look for ShipIt files outside macOS", () => {
    const diagnostics = collectDesktopUpdaterDiagnostics({
      platform: "linux",
      currentVersion: "0.7.2",
      cachePath: "/unused",
      readBundleVersion: () => null,
    });

    expect(diagnostics).toEqual({
      platform: "linux",
      currentVersion: "0.7.2",
      targetVersion: null,
      shipItDirectory: null,
      state: null,
      stdout: null,
      stderr: null,
    });
  });
});
