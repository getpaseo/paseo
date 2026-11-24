import { isElectronRuntime } from "@/desktop/host";
import { invokeDesktopCommand } from "@/desktop/electron/invoke";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

export interface DesktopAppUpdateCheckResult {
  hasUpdate: boolean;
  readyToInstall: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  body: string | null;
  date: string | null;
  errorMessage: string | null;
}

export interface DesktopAppUpdateInstallResult {
  installed: boolean;
  version: string | null;
  message: string;
}

export interface DesktopRuntimeInfo {
  appVersion: string | null;
  runningUnderARM64Translation: boolean;
  displacedBundle: boolean;
  onDiskAppVersion: string | null;
}

export type DesktopReleaseChannel = "stable" | "beta";
export type DesktopAppUpdateCheckIntent = "automatic" | "manual";

export interface LocalDaemonUpdateResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LocalDaemonVersionResult {
  version: string | null;
  error: string | null;
}

const RELEASE_DOWNLOAD_BASE_URL = "https://github.com/getpaseo/paseo/releases/download";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function toStringOrNull(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toStringOrEmpty(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toNumberOr(defaultValue: number, value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : defaultValue;
}

export function shouldShowDesktopUpdateSection(): boolean {
  return isWeb && isElectronRuntime();
}

export function parseLocalDaemonVersionResult(raw: unknown): LocalDaemonVersionResult {
  if (!isRecord(raw)) {
    return { version: null, error: "Unexpected response from version check." };
  }

  return {
    version: toStringOrNull(raw.version),
    error: toStringOrNull(raw.error),
  };
}

export async function getLocalDaemonVersion(): Promise<LocalDaemonVersionResult> {
  const result = await invokeDesktopCommand<unknown>("get_local_daemon_version");
  return parseLocalDaemonVersionResult(result);
}

export function parseDesktopRuntimeInfo(raw: unknown): DesktopRuntimeInfo {
  if (!isRecord(raw)) {
    return {
      appVersion: null,
      runningUnderARM64Translation: false,
      displacedBundle: false,
      onDiskAppVersion: null,
    };
  }

  return {
    appVersion: toStringOrNull(raw.appVersion),
    runningUnderARM64Translation: raw.runningUnderARM64Translation === true,
    displacedBundle: raw.displacedBundle === true,
    onDiskAppVersion: toStringOrNull(raw.onDiskAppVersion),
  };
}

export async function getDesktopRuntimeInfo(): Promise<DesktopRuntimeInfo> {
  const result = await invokeDesktopCommand<unknown>("desktop_get_runtime_info");
  return parseDesktopRuntimeInfo(result);
}

export async function relaunchDesktopApp(): Promise<void> {
  await invokeDesktopCommand("relaunch_desktop_app");
}

export async function checkDesktopAppUpdate({
  releaseChannel,
  intent,
}: {
  releaseChannel: DesktopReleaseChannel;
  intent: DesktopAppUpdateCheckIntent;
}): Promise<DesktopAppUpdateCheckResult> {
  const result = await invokeDesktopCommand<unknown>("check_app_update", {
    releaseChannel,
    intent,
  });
  if (!isRecord(result)) {
    throw new Error("Unexpected response while checking desktop updates.");
  }

  return {
    hasUpdate: result.hasUpdate === true,
    readyToInstall: result.readyToInstall === true,
    currentVersion: toStringOrNull(result.currentVersion),
    latestVersion: toStringOrNull(result.latestVersion),
    body: toStringOrNull(result.body),
    date: toStringOrNull(result.date),
    errorMessage: toStringOrNull(result.errorMessage),
  };
}

export async function installDesktopAppUpdate({
  releaseChannel,
}: {
  releaseChannel: DesktopReleaseChannel;
}): Promise<DesktopAppUpdateInstallResult> {
  const result = await invokeDesktopCommand<unknown>("install_app_update", { releaseChannel });
  if (!isRecord(result)) {
    throw new Error("Unexpected response while installing desktop update.");
  }

  return {
    installed: result.installed === true,
    version: toStringOrNull(result.version),
    message: toStringOrNull(result.message) ?? i18n.t("desktop.updates.status.installed"),
  };
}

export async function runLocalDaemonUpdate(): Promise<LocalDaemonUpdateResult> {
  const result = await invokeDesktopCommand<unknown>("run_local_daemon_update");
  if (!isRecord(result)) {
    throw new Error("Unexpected response while updating local daemon.");
  }

  return {
    exitCode: toNumberOr(1, result.exitCode),
    stdout: toStringOrEmpty(result.stdout),
    stderr: toStringOrEmpty(result.stderr),
  };
}

export function normalizeVersionForComparison(version: string | null | undefined): string | null {
  const value = version?.trim();
  if (!value) {
    return null;
  }

  return value.replace(/^v/i, "");
}

export function isVersionMismatch(
  appVersion: string | null | undefined,
  daemonVersion: string | null | undefined,
): boolean {
  const app = normalizeVersionForComparison(appVersion);
  const daemon = normalizeVersionForComparison(daemonVersion);

  if (!app || !daemon) {
    return false;
  }

  return app !== daemon;
}

interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

function parseSemver(version: string | null | undefined): ParsedSemver | null {
  const normalized = normalizeVersionForComparison(version);
  if (!normalized) {
    return null;
  }

  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/);
  if (!match) {
    return null;
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ?? null,
  };
}

function comparePrerelease(a: string | null, b: string | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;

  const aParts = a.split(".");
  const bParts = b.split(".");
  const length = Math.max(aParts.length, bParts.length);

  for (let i = 0; i < length; i++) {
    const aPart = aParts[i];
    const bPart = bParts[i];
    if (aPart === undefined) return -1;
    if (bPart === undefined) return 1;

    const aNum = /^\d+$/.test(aPart) ? Number(aPart) : null;
    const bNum = /^\d+$/.test(bPart) ? Number(bPart) : null;
    if (aNum !== null && bNum !== null) {
      if (aNum !== bNum) return aNum - bNum;
    } else if (aNum !== null) {
      return -1;
    } else if (bNum !== null) {
      return 1;
    } else if (aPart !== bPart) {
      return aPart < bPart ? -1 : 1;
    }
  }
  return 0;
}

export function isVersionAhead(
  candidateVersion: string | null | undefined,
  currentVersion: string | null | undefined,
): boolean {
  const candidate = parseSemver(candidateVersion);
  const current = parseSemver(currentVersion);
  if (!candidate || !current) {
    return false;
  }

  if (candidate.major !== current.major) return candidate.major > current.major;
  if (candidate.minor !== current.minor) return candidate.minor > current.minor;
  if (candidate.patch !== current.patch) return candidate.patch > current.patch;
  return comparePrerelease(candidate.prerelease, current.prerelease) > 0;
}

export function formatVersionWithPrefix(version: string | null | undefined): string {
  const value = version?.trim();
  if (!value) {
    return "\u2014";
  }

  return value.startsWith("v") ? value : `v${value}`;
}

export function buildMacAppleSiliconDownloadUrl(version: string | null | undefined): string | null {
  const normalizedVersion = normalizeVersionForComparison(version);
  if (!normalizedVersion) {
    return null;
  }

  return `${RELEASE_DOWNLOAD_BASE_URL}/v${normalizedVersion}/Paseo-${normalizedVersion}-arm64.dmg`;
}

export function buildDaemonUpdateDiagnostics(result: LocalDaemonUpdateResult): string {
  const stdout = result.stdout.length > 0 ? result.stdout : "(empty)";
  const stderr = result.stderr.length > 0 ? result.stderr : "(empty)";

  return [`Exit code: ${result.exitCode}`, "", "STDOUT:", stdout, "", "STDERR:", stderr].join("\n");
}
