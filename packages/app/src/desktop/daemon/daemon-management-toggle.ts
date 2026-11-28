/**
 * Toggles the persisted "start the built-in daemon at launch" preference only.
 * It never starts or stops the daemon immediately — manual lifecycle control
 * lives in the daemon status card and the host picker.
 */
export interface DaemonManagementToggleDeps {
  persistSettings: (next: { manageBuiltInDaemon: boolean }) => Promise<void>;
}

export type DaemonManagementToggleResult = "enabled" | "disabled";

export async function executeDaemonManagementToggle(
  currentlyManaging: boolean,
  deps: DaemonManagementToggleDeps,
): Promise<DaemonManagementToggleResult> {
  await deps.persistSettings({ manageBuiltInDaemon: !currentlyManaging });
  return currentlyManaging ? "disabled" : "enabled";
}
