import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";
import { tailFile } from "./tail-file.js";

const SHIPIT_DIRECTORY_NAME = "sh.paseo.desktop.ShipIt";
const SHIPIT_LOG_TAIL_LINES = 100;

export interface DesktopUpdaterDiagnosticFile {
  path: string;
  exists: boolean;
  modifiedAt: string | null;
  contents: string;
  error: string | null;
}

export interface DesktopUpdaterDiagnostics {
  platform: NodeJS.Platform;
  currentVersion: string;
  targetVersion: string | null;
  targetVersionError: string | null;
  shipItDirectory: string | null;
  state: DesktopUpdaterDiagnosticFile | null;
  stdout: DesktopUpdaterDiagnosticFile | null;
  stderr: DesktopUpdaterDiagnosticFile | null;
}

interface DesktopUpdaterDiagnosticEnvironment {
  platform: NodeJS.Platform;
  currentVersion: string;
  cachePath: string;
  readBundleVersion(bundlePath: string): string | null;
}

export function collectDesktopUpdaterDiagnostics(
  environment: DesktopUpdaterDiagnosticEnvironment,
): DesktopUpdaterDiagnostics {
  const { platform, currentVersion, cachePath, readBundleVersion } = environment;
  if (platform !== "darwin") {
    return {
      platform,
      currentVersion,
      targetVersion: null,
      targetVersionError: null,
      shipItDirectory: null,
      state: null,
      stdout: null,
      stderr: null,
    };
  }

  const shipItDirectory = path.join(cachePath, SHIPIT_DIRECTORY_NAME);
  const state = readDiagnosticFile(path.join(shipItDirectory, "ShipItState.plist"));
  const targetVersion = diagnoseTargetVersion(state.contents, readBundleVersion);
  return {
    platform,
    currentVersion,
    ...targetVersion,
    shipItDirectory,
    state,
    stdout: readDiagnosticFile(path.join(shipItDirectory, "ShipIt_stdout.log"), true),
    stderr: readDiagnosticFile(path.join(shipItDirectory, "ShipIt_stderr.log"), true),
  };
}

export function getDesktopUpdaterDiagnostics(): DesktopUpdaterDiagnostics {
  return collectDesktopUpdaterDiagnostics({
    platform: process.platform,
    currentVersion: app.getVersion(),
    cachePath: path.join(app.getPath("home"), "Library", "Caches"),
    readBundleVersion: readMacBundleVersion,
  });
}

function readDiagnosticFile(filePath: string, tail = false): DesktopUpdaterDiagnosticFile {
  let exists = false;
  let modifiedAt: string | null = null;
  try {
    modifiedAt = statSync(filePath).mtime.toISOString();
    exists = true;
    const contents = tail
      ? tailFile(filePath, SHIPIT_LOG_TAIL_LINES, { throwOnReadError: true })
      : readFileSync(filePath, "utf8");
    return { path: filePath, exists, modifiedAt, contents, error: null };
  } catch (error) {
    if (isMissingFileError(error)) {
      return { path: filePath, exists: false, modifiedAt: null, contents: "", error: null };
    }
    return {
      path: filePath,
      exists,
      modifiedAt,
      contents: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function diagnoseTargetVersion(
  stateContents: string,
  readBundleVersion: (bundlePath: string) => string | null,
): Pick<DesktopUpdaterDiagnostics, "targetVersion" | "targetVersionError"> {
  try {
    return {
      targetVersion: readTargetVersion(stateContents, readBundleVersion),
      targetVersionError: null,
    };
  } catch (error) {
    return {
      targetVersion: null,
      targetVersionError: error instanceof Error ? error.message : String(error),
    };
  }
}

function readTargetVersion(
  stateContents: string,
  readBundleVersion: (bundlePath: string) => string | null,
): string | null {
  if (!stateContents) return null;

  const state = JSON.parse(stateContents) as unknown;
  if (!isRecord(state) || typeof state.updateBundleURL !== "string") return null;
  return readBundleVersion(fileURLToPath(state.updateBundleURL));
}

function readMacBundleVersion(bundlePath: string): string | null {
  return execFileSync(
    "/usr/bin/plutil",
    [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      path.join(bundlePath, "Contents", "Info.plist"),
    ],
    { encoding: "utf8" },
  ).trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
