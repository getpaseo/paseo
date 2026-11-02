import type { DesktopDialogBridge } from "@/desktop/host";
import { pickDirectory } from "@/desktop/pick-directory";
import type { DesktopSettings, DesktopSettingsPatch } from "@/desktop/settings/desktop-settings";
import { parentDirectory } from "./options";

/** The folder the user chose in settings wins; otherwise Browse reopens where it was last used. */
export function resolveBrowseStartDirectory(projects: DesktopSettings["projects"]): string | null {
  return projects.defaultBrowseDirectory ?? projects.lastBrowseDirectory;
}

/**
 * Browse for a project directory and remember the folder it was picked from. The parent is what
 * gets remembered: after picking `~/Developer/app`, the next Browse should open in `~/Developer`.
 */
export async function browseForProjectDirectory({
  projects,
  updateSettings,
  dialog,
}: {
  projects: DesktopSettings["projects"];
  updateSettings: (updates: DesktopSettingsPatch) => Promise<void>;
  dialog?: DesktopDialogBridge | null;
}): Promise<string | null> {
  const path = await pickDirectory({ defaultPath: resolveBrowseStartDirectory(projects), dialog });
  const parent = path ? parentDirectory(path) : null;
  if (parent && parent !== projects.lastBrowseDirectory) {
    void updateSettings({ projects: { lastBrowseDirectory: parent } }).catch(() => {
      // useDesktopSettings owns the user-visible IPC error.
    });
  }
  return path;
}
