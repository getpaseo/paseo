import {
  formatVersionWithPrefix,
  isVersionAhead,
  normalizeVersionForComparison,
} from "@/desktop/updates/desktop-updates";
import { i18n } from "@/i18n/i18next";

export interface ResolveDesktopSyncCalloutInput {
  isDesktopApp: boolean;
  appVersion: string | null;
  daemonVersion: string | null;
  displacedBundle: boolean;
  onDiskAppVersion: string | null;
  keepRunningAfterQuit: boolean;
  isRelaunching: boolean;
}

export interface DesktopSyncCalloutDescriptor {
  id: "desktop-sync";
  dismissalKey: string;
  priority: number;
  title: string;
  descriptionLines: string[];
  actionLabel: string;
  actionDisabled: boolean;
  testID: "desktop-sync-callout";
}

export function resolveDesktopSyncCalloutDescriptor(
  input: ResolveDesktopSyncCalloutInput,
): DesktopSyncCalloutDescriptor | null {
  if (!input.isDesktopApp || !input.appVersion) {
    return null;
  }

  const normalizedApp = normalizeVersionForComparison(input.appVersion);
  if (!normalizedApp) {
    return null;
  }

  const daemonAhead = isVersionAhead(input.daemonVersion, normalizedApp);
  const diskAhead = isVersionAhead(input.onDiskAppVersion, normalizedApp);
  const displaced = input.displacedBundle;

  if (!daemonAhead && !diskAhead && !displaced) {
    return null;
  }

  const normalizedDaemon = normalizeVersionForComparison(input.daemonVersion);
  const normalizedDisk = normalizeVersionForComparison(input.onDiskAppVersion);
  let targetVersion: string | null = null;
  if (daemonAhead && diskAhead) {
    targetVersion = isVersionAhead(normalizedDisk, normalizedDaemon)
      ? normalizedDisk
      : normalizedDaemon;
  } else if (daemonAhead) {
    targetVersion = normalizedDaemon;
  } else if (diskAhead) {
    targetVersion = normalizedDisk;
  }

  const dismissalKey = `desktop-sync:${normalizedApp}:${targetVersion ?? "displaced"}`;

  const descriptionLines: string[] = [];
  if (daemonAhead && normalizedDaemon) {
    descriptionLines.push(
      i18n.t("desktop.updates.syncCallout.behindDaemon", {
        appVersion: formatVersionWithPrefix(normalizedApp),
        daemonVersion: formatVersionWithPrefix(normalizedDaemon),
      }),
    );
  } else if (diskAhead && normalizedDisk) {
    descriptionLines.push(
      i18n.t("desktop.updates.syncCallout.behindOnDisk", {
        appVersion: formatVersionWithPrefix(normalizedApp),
        diskVersion: formatVersionWithPrefix(normalizedDisk),
      }),
    );
  } else {
    descriptionLines.push(i18n.t("desktop.updates.syncCallout.displacedBundle"));
  }

  if (input.keepRunningAfterQuit) {
    descriptionLines.push(i18n.t("desktop.updates.syncCallout.agentsPreserved"));
  }

  return {
    id: "desktop-sync",
    dismissalKey,
    priority: 250,
    title: i18n.t("desktop.updates.syncCallout.title"),
    descriptionLines,
    actionLabel: input.isRelaunching
      ? i18n.t("desktop.updates.syncCallout.relaunchingAction")
      : i18n.t("desktop.updates.syncCallout.relaunchAction"),
    actionDisabled: input.isRelaunching,
    testID: "desktop-sync-callout",
  };
}
