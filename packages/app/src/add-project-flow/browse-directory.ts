import type { DesktopDialogBridge } from "@/desktop/host";
import { pickDirectory } from "@/desktop/pick-directory";
import type { DesktopSettings, DesktopSettingsPatch } from "@/desktop/settings/desktop-settings";

const WINDOWS_ROOT = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+[\\/]?)/;

/** The folder the user chose in settings wins; otherwise Browse reopens where it was last used. */
export function resolveBrowseStartDirectory(projects: DesktopSettings["projects"]): string | null {
  return projects.defaultBrowseDirectory ?? projects.lastBrowseDirectory;
}

/**
 * The folder holding a directory from the native picker. Picked paths are always absolute and
 * local, so the root shows which separators apply: a backslash is legal in a POSIX name.
 */
function pickedDirectoryParent(path: string): string | null {
  const isPosix = path.startsWith("/");
  const root = isPosix ? "/" : WINDOWS_ROOT.exec(path)?.[0];
  if (!root) return null;
  const segments = path
    .slice(root.length)
    .split(isPosix ? "/" : /[\\/]/)
    .filter(Boolean);
  return root + segments.slice(0, -1).join(isPosix ? "/" : "\\");
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
  const parent = path ? pickedDirectoryParent(path) : null;
  if (parent && parent !== projects.lastBrowseDirectory) {
    void updateSettings({ projects: { lastBrowseDirectory: parent } }).catch(() => {
      // useDesktopSettings owns the user-visible IPC error.
    });
  }
  return path;
}
