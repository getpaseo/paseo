import { i18n } from "@/i18n/i18next";

export type DaemonOutdatedUpdateState =
  | { status: "idle" }
  | { status: "updating"; phase: string }
  | { status: "failed"; message: string };

export interface ResolveDaemonOutdatedCalloutInput {
  serverId: string;
  hostLabel: string;
  appVersion: string | null;
  daemonVersion: string | null;
  supportsSelfUpdate: boolean;
  desktopManaged: boolean;
  terminalsSurviveRestart: boolean;
  isConnected: boolean;
  update: DaemonOutdatedUpdateState;
}

export interface DaemonOutdatedUpdateAction {
  label: string;
  disabled: boolean;
}

export interface DaemonOutdatedCalloutDescriptor {
  id: "daemon-outdated";
  dismissalKey: string;
  priority: number;
  title: string;
  description: string[];
  variant: "default" | "error";
  updateAction: DaemonOutdatedUpdateAction | null;
  testID: "daemon-outdated-callout";
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

const VERSION_PATTERN =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/i;
const NUMERIC_IDENTIFIER = /^\d+$/;

function parseVersion(value: string | null): ParsedVersion | null {
  const match = value?.trim().match(VERSION_PATTERN);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(left: string, right: string): number {
  const isLeftNumeric = NUMERIC_IDENTIFIER.test(left);
  const isRightNumeric = NUMERIC_IDENTIFIER.test(right);
  if (isLeftNumeric && isRightNumeric) return Number(left) - Number(right);
  if (isLeftNumeric) return -1;
  if (isRightNumeric) return 1;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

// Semver precedence: a prerelease sorts before its release (0.12.0-beta.1 < 0.12.0).
function compareVersions(left: ParsedVersion, right: ParsedVersion): number {
  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0) return difference;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return right.prerelease.length - left.prerelease.length;
  }
  const sharedLength = Math.min(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const difference = compareIdentifiers(left.prerelease[index], right.prerelease[index]);
    if (difference !== 0) return difference;
  }
  return left.prerelease.length - right.prerelease.length;
}

function resolveUpdateAction(input: ResolveDaemonOutdatedCalloutInput): DaemonOutdatedUpdateAction {
  if (input.update.status === "updating") {
    return { label: input.update.phase, disabled: true };
  }
  return { label: i18n.t("daemonOutdated.update"), disabled: !input.isConnected };
}

function formatVersion(version: ParsedVersion): string {
  const core = version.core.join(".");
  return version.prerelease.length > 0 ? `${core}-${version.prerelease.join(".")}` : core;
}

// A daemon that keeps terminals across restarts does not keep them across a Paseo Desktop update
// on Windows, which closes them. server_info does not name the host's platform, so the line says
// both.
function resolveTerminalsLine(input: ResolveDaemonOutdatedCalloutInput): string {
  if (!input.terminalsSurviveRestart) return i18n.t("daemonOutdated.terminalsClose");
  if (input.desktopManaged) return i18n.t("daemonOutdated.desktopUpdateTerminals");
  return i18n.t("daemonOutdated.terminalsStayOpen");
}

function resolveDescription(
  input: ResolveDaemonOutdatedCalloutInput,
  versions: { daemon: ParsedVersion; app: ParsedVersion },
): string[] {
  if (input.update.status === "failed") return [input.update.message];

  const lines = [
    i18n.t("daemonOutdated.versions", {
      host: input.hostLabel,
      daemonVersion: `v${formatVersion(versions.daemon)}`,
      appVersion: `v${formatVersion(versions.app)}`,
    }),
  ];
  if (input.desktopManaged) {
    lines.push(i18n.t("daemonOutdated.desktopManaged"));
  } else if (!input.supportsSelfUpdate) {
    lines.push(i18n.t("daemonOutdated.selfUpdateUnsupported"));
  }
  lines.push(resolveTerminalsLine(input));
  return lines;
}

export function resolveDaemonOutdatedCallout(
  input: ResolveDaemonOutdatedCalloutInput,
): DaemonOutdatedCalloutDescriptor | null {
  const app = parseVersion(input.appVersion);
  const daemon = parseVersion(input.daemonVersion);
  if (!app || !daemon) return null;
  if (compareVersions(daemon, app) >= 0) return null;

  // The update RPC refuses desktop-managed daemons; those update with Paseo Desktop on that computer.
  const canSelfUpdate = input.supportsSelfUpdate && !input.desktopManaged;
  const isFailed = input.update.status === "failed";

  return {
    id: "daemon-outdated",
    dismissalKey: `daemon-outdated:${input.serverId}:${formatVersion(daemon)}`,
    priority: 250,
    title: isFailed ? i18n.t("daemonOutdated.updateFailedTitle") : i18n.t("daemonOutdated.title"),
    description: resolveDescription(input, { daemon, app }),
    variant: isFailed ? "error" : "default",
    updateAction: canSelfUpdate ? resolveUpdateAction(input) : null,
    testID: "daemon-outdated-callout",
  };
}
