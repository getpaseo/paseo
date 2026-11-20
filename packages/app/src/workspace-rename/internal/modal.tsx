import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { AdaptiveRenameModal } from "@/components/rename-modal";
import {
  type RenamableWorkspace,
  useSetWorkspaceTitle,
  workspaceRenameInitialValue,
} from "./set-workspace-title";

export interface WorkspaceRenameModalProps {
  visible: boolean;
  workspace: RenamableWorkspace;
  onClose: () => void;
  /**
   * Prefix for the modal's testIDs. Sidebar rows use
   * `sidebar-workspace-rename-modal-${workspaceKey}` — the browser and native-wide e2e flows build
   * their locators from exactly that prefix.
   */
  testID?: string;
}

/**
 * Owns every rename string, so a caller only tracks its own open/closed boolean. Errors surface
 * inline inside AdaptiveRenameModal; the dialog stays open.
 */
export function WorkspaceRenameModal({
  visible,
  workspace,
  onClose,
  testID,
}: WorkspaceRenameModalProps) {
  const { t } = useTranslation();
  const setWorkspaceTitle = useSetWorkspaceTitle(workspace);
  const submit = useCallback(
    async (title: string) => {
      await setWorkspaceTitle(title);
    },
    [setWorkspaceTitle],
  );

  return (
    <AdaptiveRenameModal
      visible={visible}
      title={t("sidebar.workspace.rename.title")}
      initialValue={workspaceRenameInitialValue(workspace)}
      placeholder={workspace.name}
      submitLabel={t("sidebar.workspace.rename.submit")}
      onClose={onClose}
      onSubmit={submit}
      testID={testID}
    />
  );
}
