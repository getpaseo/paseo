import { useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { AppWindow, Copy, Download, FolderOpen, FolderTree } from "lucide-react-native";
import { MenuItem } from "@/components/ui/menu";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import type { WorkspaceFileAction, WorkspaceFileActionId } from "./internal/commands";

const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const ICONS = {
  "reveal-in-files": withUnistyles(FolderTree),
  "reveal-in-file-manager": withUnistyles(FolderOpen),
  "open-in-default-app": withUnistyles(AppWindow),
  download: withUnistyles(Download),
  "copy-path": withUnistyles(Copy),
  "copy-relative-path": withUnistyles(Copy),
} satisfies Record<WorkspaceFileActionId, unknown>;

/** Rows for a menu surface that already holds the file's actions. */
export function WorkspaceFileActionItems({
  actions,
  revealTargetName,
  testIDBase,
}: {
  actions: readonly WorkspaceFileAction[];
  revealTargetName: string | null;
  testIDBase: string;
}): ReactElement {
  const { t } = useTranslation();
  const labels: Record<WorkspaceFileActionId, string> = {
    "reveal-in-files": t("workspace.fileActions.revealInFiles"),
    "reveal-in-file-manager": t("workspace.fileActions.revealIn", { target: revealTargetName }),
    "open-in-default-app": t("workspace.fileActions.openInDefaultApp"),
    download: t("workspace.fileActions.download"),
    "copy-path": t("workspace.fileActions.copyPath"),
    "copy-relative-path": t("workspace.fileActions.copyRelativePath"),
  };
  return (
    <>
      {actions.map((action) => (
        <WorkspaceFileActionItem
          key={action.id}
          action={action}
          label={labels[action.id]}
          testID={`${testIDBase}-${action.id}`}
        />
      ))}
    </>
  );
}

function WorkspaceFileActionItem({
  action,
  label,
  testID,
}: {
  action: WorkspaceFileAction;
  label: string;
  testID: string;
}): ReactElement {
  const leading = useMemo(() => {
    const Icon = ICONS[action.id];
    return <Icon size={ICON_SIZE.sm} uniProps={mutedIconMapping} />;
  }, [action.id]);
  return (
    <MenuItem leading={leading} onSelect={action.run} testID={testID}>
      {label}
    </MenuItem>
  );
}
