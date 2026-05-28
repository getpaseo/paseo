import type { DesktopAppUpdateStatus } from "@/desktop/updates/use-desktop-app-updater";

export type UpdateCalloutBody =
  | { kind: "available"; versionLabel: string | null }
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
  availableUpdate: { latestVersion?: string | null } | null;
  errorMessage: string | null;
}

function formatVersionLabel(latestVersion: string | null | undefined): string | null {
  if (!latestVersion) return null;
  return `v${latestVersion.replace(/^v/i, "")}`;
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
  const isAvailable = !isInstalling && !isError;

  const latestVersion = input.availableUpdate?.latestVersion ?? null;
  const dismissalKey = `desktop-update:${input.status}:${latestVersion ?? "unknown"}`;

  let title: string;
  let body: UpdateCalloutBody;
  if (isInstalling) {
    title = "Installing update";
    body = { kind: "installing" };
  } else if (isError) {
    title = "Update failed";
    body = { kind: "error", message: input.errorMessage ?? "Something went wrong." };
  } else {
    title = "Update available";
    body = { kind: "available", versionLabel: formatVersionLabel(latestVersion) };
  }

  const actions: UpdateCalloutActionDescriptor[] = [{ role: "changelog", label: "What's new" }];
  if (isError) {
    actions.push({ role: "retry", label: "Retry", variant: "primary" });
  } else {
    actions.push({
      role: "install",
      label: isInstalling ? "Installing..." : "Install & restart",
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
