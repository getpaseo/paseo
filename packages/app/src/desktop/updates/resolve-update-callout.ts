import type { DesktopAppUpdateStatus } from "@/desktop/updates/use-desktop-app-updater";
import type { DesktopAppUpdateDownloadProgress } from "@/desktop/updates/desktop-updates";
import { i18n } from "@/i18n/i18next";

export type UpdateCalloutBody =
  | { kind: "available"; versionLabel: string | null; readyToInstall?: boolean }
  | { kind: "downloading"; versionLabel: string | null; percent: number }
  | { kind: "installing" }
  | { kind: "error"; message: string };

export type UpdateCalloutActionRole = "changelog" | "install" | "retry";

export interface UpdateCalloutActionDescriptor {
  role: UpdateCalloutActionRole;
  label: string;
  variant?: "primary" | "secondary";
  disabled?: boolean;
}

export interface UpdateCalloutDescriptor {
  id: "desktop-update";
  dismissalKey: string;
  priority: number;
  title: string;
  body: UpdateCalloutBody;
  showGiftIcon: boolean;
  variant: "default" | "error";
  actions: UpdateCalloutActionDescriptor[];
  testID: "update-callout";
}

export interface ResolveUpdateCalloutInput {
  isDesktopApp: boolean;
  status: DesktopAppUpdateStatus;
  isInstalling: boolean;
  availableUpdate: { latestVersion?: string | null; readyToInstall?: boolean } | null;
  downloadProgress?: DesktopAppUpdateDownloadProgress | null;
  errorMessage: string | null;
}

function formatVersionLabel(latestVersion: string | null | undefined): string | null {
  if (!latestVersion) return null;
  return `v${latestVersion.replace(/^v/i, "")}`;
}

function resolveCalloutPresentation(input: {
  isError: boolean;
  isInstalling: boolean;
  readyToInstall: boolean;
  latestVersion: string | null;
  downloadProgress: DesktopAppUpdateDownloadProgress | null | undefined;
  errorMessage: string | null;
}): { title: string; body: UpdateCalloutBody } {
  if (input.isInstalling && input.downloadProgress != null) {
    return {
      title: i18n.t("desktop.updates.callout.downloadingTitle"),
      body: {
        kind: "downloading",
        versionLabel: formatVersionLabel(input.latestVersion),
        percent: Math.round(input.downloadProgress.percent),
      },
    };
  }
  if (input.isInstalling) {
    return {
      title: i18n.t("desktop.updates.callout.installingTitle"),
      body: { kind: "installing" },
    };
  }
  if (input.isError) {
    return {
      title: i18n.t("desktop.updates.callout.failedTitle"),
      body: {
        kind: "error",
        message: input.errorMessage ?? i18n.t("desktop.updates.callout.genericError"),
      },
    };
  }
  const versionLabel = formatVersionLabel(input.latestVersion);
  return {
    title: i18n.t("desktop.updates.callout.availableTitle"),
    body: input.readyToInstall
      ? { kind: "available", versionLabel }
      : { kind: "available", versionLabel, readyToInstall: false },
  };
}

function resolveInstallActionLabel(input: {
  isDownloading: boolean;
  isInstalling: boolean;
  readyToInstall: boolean;
}): string {
  if (input.isDownloading) return i18n.t("desktop.updates.callout.downloadingAction");
  if (input.isInstalling) return i18n.t("desktop.updates.callout.installingAction");
  if (input.readyToInstall) return i18n.t("desktop.updates.callout.installAndRestart");
  return i18n.t("desktop.updates.callout.downloadAndRestart");
}

export function resolveUpdateCalloutDescriptor(
  input: ResolveUpdateCalloutInput,
): UpdateCalloutDescriptor | null {
  if (!input.isDesktopApp) return null;
  if (input.status !== "available" && input.status !== "installing" && input.status !== "error") {
    return null;
  }

  const isError = input.status === "error";
  const isInstalling = input.isInstalling;
  const isDownloading = isInstalling && input.downloadProgress != null;
  const isAvailable = !isInstalling && !isError;
  const readyToInstall = input.availableUpdate?.readyToInstall !== false;

  const latestVersion =
    input.availableUpdate?.latestVersion ?? input.downloadProgress?.version ?? null;
  const dismissalKey = `desktop-update:${input.status}:${latestVersion ?? "unknown"}`;

  const { title, body } = resolveCalloutPresentation({
    isError,
    isInstalling,
    readyToInstall,
    latestVersion,
    downloadProgress: input.downloadProgress,
    errorMessage: input.errorMessage,
  });

  const actions: UpdateCalloutActionDescriptor[] = [
    { role: "changelog", label: i18n.t("desktop.updates.callout.whatsNew") },
  ];
  if (isError) {
    actions.push({ role: "retry", label: i18n.t("common.actions.retry"), variant: "primary" });
  } else {
    actions.push({
      role: "install",
      label: resolveInstallActionLabel({ isDownloading, isInstalling, readyToInstall }),
      variant: "primary",
      disabled: isInstalling,
    });
  }

  return {
    id: "desktop-update",
    dismissalKey,
    priority: 200,
    title,
    body,
    showGiftIcon: isAvailable,
    variant: isError ? "error" : "default",
    actions,
    testID: "update-callout",
  };
}
