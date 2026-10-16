import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import type { WorkspaceTabFileActions } from "@/screens/workspace/workspace-tab-menu";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

interface UseWorkspaceTabFileActionsInput {
  serverId: string;
  workspaceId: string;
}

export function parentDirectory(absolutePath: string): string {
  const separator = absolutePath.lastIndexOf("/");
  if (separator < 0) return absolutePath;
  if (separator === 0) return "/";
  const parent = absolutePath.slice(0, separator);
  // A file directly under a Windows drive root ("C:/file") has no separator
  // before the drive letter; "C:" alone is not a directory.
  return /^[A-Za-z]:$/.test(parent) ? `${parent}/` : parent;
}

/**
 * File actions for a file tab's context menu: open the file with the OS default
 * application, or reveal it in the platform file manager.
 *
 * Both go through the desktop editor bridge's `file-manager` target (Finder /
 * Explorer / Files). Supplying `filePath` makes that target reveal the file;
 * omitting it makes the target open `workspacePath` with the system default
 * handler, which is what "open with the default app" needs. Nothing here works
 * for a remote daemon: the path only exists on the machine running the client.
 */
export function useWorkspaceTabFileActions(
  input: UseWorkspaceTabFileActionsInput,
): WorkspaceTabFileActions | null {
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalDaemon(input.serverId);
  const workspaceDirectory = useWorkspaceDirectory(input.serverId, input.workspaceId);
  const { targets } = useDesktopOpenTargets({ isLocalExecution });
  const fileManagerTarget = useMemo(
    () => targets.find((target) => target.kind === "file-manager") ?? null,
    [targets],
  );

  const run = useCallback(
    (action: (absolutePath: string) => Promise<void>, filePath: string) => {
      const resolved = workspaceDirectory
        ? resolveWorkspaceFilePaths({ path: filePath, workspaceRoot: workspaceDirectory })
        : null;
      if (!resolved) {
        // A missing workspace directory (or a home-relative path) leaves nothing
        // to hand to the OS; say so instead of failing silently.
        toast.error(t("workspace.fileExplorer.errors.revealFailed"));
        return;
      }
      void action(resolved.absolutePath).catch((cause: unknown) => {
        toast.error(
          cause instanceof Error ? cause.message : t("workspace.fileExplorer.errors.revealFailed"),
        );
      });
    },
    [t, toast, workspaceDirectory],
  );

  return useMemo(() => {
    if (!fileManagerTarget) {
      return null;
    }
    return {
      openWithDefaultApp: {
        label: t("workspace.tabs.menu.openWithDefaultApp"),
        onSelect: (filePath) => {
          run(
            (absolutePath) =>
              openDesktopTarget({ editorId: fileManagerTarget.id, workspacePath: absolutePath }),
            filePath,
          );
        },
      },
      revealInFileManager: {
        label: t("workspace.fileActions.revealIn", { target: fileManagerTarget.label }),
        onSelect: (filePath) => {
          run(
            (absolutePath) =>
              openDesktopTarget({
                editorId: fileManagerTarget.id,
                workspacePath: parentDirectory(absolutePath),
                filePath: absolutePath,
              }),
            filePath,
          );
        },
      },
    };
  }, [fileManagerTarget, run, t]);
}
