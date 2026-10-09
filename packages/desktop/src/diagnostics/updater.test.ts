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
    expect(diagnostics.targetVersionError).toBeNull();
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

  it("reports malformed ShipIt state without hiding other evidence", () => {
    testDirectory = mkdtempSync(path.join(tmpdir(), "paseo-updater-diagnostics-"));
    const shipItDirectory = path.join(testDirectory, "sh.paseo.desktop.ShipIt");
    mkdirSync(shipItDirectory, { recursive: true });
    writeFileSync(path.join(shipItDirectory, "ShipItState.plist"), "not JSON");
    writeFileSync(path.join(shipItDirectory, "ShipIt_stderr.log"), "installer evidence\n");

    const diagnostics = collectDesktopUpdaterDiagnostics({
      platform: "darwin",
      currentVersion: "0.7.0",
      cachePath: testDirectory,
      readBundleVersion: () => "unused",
    });

    expect(diagnostics.targetVersion).toBeNull();
    expect(diagnostics.targetVersionError).toMatch(/JSON|Unexpected token/);
    expect(diagnostics.stderr?.contents).toBe("installer evidence");
  });

  it("reports bundle version lookup failures", () => {
    testDirectory = mkdtempSync(path.join(tmpdir(), "paseo-updater-diagnostics-"));
    const shipItDirectory = path.join(testDirectory, "sh.paseo.desktop.ShipIt");
    mkdirSync(shipItDirectory, { recursive: true });
    writeFileSync(
      path.join(shipItDirectory, "ShipItState.plist"),
      JSON.stringify({ updateBundleURL: pathToFileURL(path.join(shipItDirectory, "Paseo.app")) }),
    );

    const diagnostics = collectDesktopUpdaterDiagnostics({
      platform: "darwin",
      currentVersion: "0.7.0",
      cachePath: testDirectory,
      readBundleVersion: () => {
        throw new Error("plutil failed");
      },
    });

    expect(diagnostics.targetVersion).toBeNull();
    expect(diagnostics.targetVersionError).toBe("plutil failed");
  });

  it("keeps readable ShipIt evidence when another file cannot be read", () => {
    testDirectory = mkdtempSync(path.join(tmpdir(), "paseo-updater-diagnostics-"));
    const shipItDirectory = path.join(testDirectory, "sh.paseo.desktop.ShipIt");
    mkdirSync(path.join(shipItDirectory, "ShipIt_stdout.log"), { recursive: true });
    writeFileSync(path.join(shipItDirectory, "ShipIt_stderr.log"), "installer evidence\n");

    const diagnostics = collectDesktopUpdaterDiagnostics({
      platform: "darwin",
      currentVersion: "0.7.0",
      cachePath: testDirectory,
      readBundleVersion: () => null,
    });

    expect(diagnostics.stdout).toMatchObject({
      exists: true,
      contents: "",
      error: expect.any(String),
    });
    expect(diagnostics.stderr).toMatchObject({
      exists: true,
      contents: "installer evidence",
      error: null,
    });
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
      targetVersionError: null,
      shipItDirectory: null,
      state: null,
      stdout: null,
      stderr: null,
    });
  });
});
