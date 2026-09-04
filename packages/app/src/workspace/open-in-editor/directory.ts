import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { resolvePreferredEditorId, usePreferredEditor } from "@/hooks/use-preferred-editor";
import { openDesktopTarget, useDesktopOpenTargets } from "@/workspace/desktop-open-targets";
import { planWorkspaceOpenTargets } from "@/workspace/open-in-editor/planner";
import { useDesktopOpenExecution } from "@/workspace/open-in-editor/remote-destination";

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
  const desktopOpenExecution = useDesktopOpenExecution(serverId);
  // Opening a folder is a plain action with no room for a setup affordance, so an
  // unconfigured remote host hides it exactly as it did before remote opens existed.
  const execution =
    desktopOpenExecution?.kind === "remote-unconfigured" ? null : desktopOpenExecution;
  const { preferredEditorId } = usePreferredEditor();
  const { targets, isAvailable } = useDesktopOpenTargets({ execution });
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
        execution,
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
    [execution, isAvailable, preferredTarget, t, toast, workspaceDirectory],
  );

  return useMemo(
    () => (preferredTarget ? { targetName: preferredTarget.label, open } : null),
    [open, preferredTarget],
  );
}
