import type { DesktopDaemonStatus } from "./desktop-daemon";

export interface DaemonManagementToggleDeps {
  confirm: () => Promise<boolean>;
  persistSettings: (next: { manageBuiltInDaemon: boolean }) => Promise<void>;
  startDaemon: () => Promise<DesktopDaemonStatus>;
  stopDaemon: () => Promise<DesktopDaemonStatus>;
}

export type DaemonManagementToggleResult =
  | { kind: "cancelled" }
  | { kind: "enabled"; newStatus: DesktopDaemonStatus }
  | { kind: "disabled"; newStatus: DesktopDaemonStatus | null };

export async function executeDaemonManagementToggle(
  currentlyManaging: boolean,
  daemonStatus: Pick<DesktopDaemonStatus, "status" | "ownedByDesktop"> | null,
  deps: DaemonManagementToggleDeps,
): Promise<DaemonManagementToggleResult> {
  if (!currentlyManaging) {
    await deps.persistSettings({ manageBuiltInDaemon: true });
    let newStatus: DesktopDaemonStatus;
    try {
      newStatus = await deps.startDaemon();
    } catch (error) {
      // Failed opt-in must not turn the next launch into another startup error.
      await deps.persistSettings({ manageBuiltInDaemon: false });
      throw error;
    }
    return { kind: "enabled", newStatus };
  }

  const confirmed = await deps.confirm();
  if (!confirmed) {
    return { kind: "cancelled" };
  }

  // Settings must persist before the daemon is stopped so the persisted
  // state reflects what was actually applied if the stop fails.
  await deps.persistSettings({ manageBuiltInDaemon: false });

  if (daemonStatus?.ownedByDesktop && ["running", "starting"].includes(daemonStatus.status)) {
    const newStatus = await deps.stopDaemon();
    return { kind: "disabled", newStatus };
  }

  return { kind: "disabled", newStatus: null };
}
