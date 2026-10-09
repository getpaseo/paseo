import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { planWorkspaceOpenTargets } from "@/workspace/open-in-editor/planner";

interface UseOpenDirectoryInEditorInput {
  serverId: string;
  workspaceDirectory: string;
}

interface OpenDirectoryInEditorAction {
  targetName: string;
  open: (directoryPath: string) => void;
}

export function useOpenDirectoryInEditor({
  serverId,
  workspaceDirectory,
}: UseOpenDirectoryInEditorInput): OpenDirectoryInEditorAction | null {
  const { t } = useTranslation();
  const toast = useToast();
  const isLocalExecution = useIsLocalDaemon(serverId);
  const { preferredEditorId } = usePreferredEditor();
  const { targets, isAvailable } = useDesktopOpenTargets({ isLocalExecution });
  const editorTargets = useMemo(
    () => targets.filter((target) => target.kind === "editor"),
    [targets],
  );
  const preferredTarget = useMemo(() => {
    const preferredId = resolvePreferredEditorId(
      editorTargets.map((target) => target.id),
      preferredEditorId,
    );
    return editorTargets.find((target) => target.id === preferredId) ?? null;
  }, [editorTargets, preferredEditorId]);

  const open = useCallback(
    (directoryPath: string) => {
      if (!preferredTarget) {
        return;
      }
      const target = planWorkspaceOpenTargets({
        workspaceDirectory,
        directoryPath,
        desktopTargets: [preferredTarget],
        canUseDesktopBridge: isAvailable,
        isLocalExecution,
      }).find((candidate) => candidate.source === "desktop");
      if (!target) {
        return;
      }
      void openDesktopTarget(target.openInput).catch((cause: unknown) => {
        toast.error(
          cause instanceof Error ? cause.message : t("sidebar.project.actions.openFolderFailed"),
        );
      });
    },
    [isAvailable, isLocalExecution, preferredTarget, t, toast, workspaceDirectory],
  );

  return useMemo(
    () => (preferredTarget ? { targetName: preferredTarget.label, open } : null),
    [open, preferredTarget],
  );
}
