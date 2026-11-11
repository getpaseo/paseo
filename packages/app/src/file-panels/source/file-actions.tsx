import { useWorkspace } from "@getpaseo/plugin/client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { copyText } from "@/plugins/react-native/clipboard";
import { Copy } from "lucide-react-native";
import { Text, View } from "react-native";
import { Button } from "@/components/ui/button";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { FileActionsContextMenuContent } from "@/components/file-actions-menu";
import { DropdownMenu } from "@/components/ui/dropdown-menu";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ToolbarButton, paneContentToolbarIconSize } from "@/components/ui/pane-content-toolbar";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useToast } from "@/contexts/toast-context";
import { FilePathCopyModel, type FilePathClipboard } from "./copy-model";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { Theme } from "@/styles/theme";
import { resolveWorkspaceFilePaths } from "@/workspace/file-open";

const clipboard: FilePathClipboard = { writeText: copyText };

const ThemedCopy = withUnistyles(Copy);
const ThemedSpinner = withUnistyles(LoadingSpinner);
const mutedIconMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The same path actions as Explorer, directly accessible from the file viewer. */
export function FilePathActions({ path, workspaceId }: { path: string; workspaceId: string }) {
  return (
    <FilePathActionsForTarget
      key={`${workspaceId}:${path}`}
      path={path}
      workspaceId={workspaceId}
    />
  );
}

function FilePathActionsForTarget({ path, workspaceId }: { path: string; workspaceId: string }) {
  const { t } = useTranslation();
  const toast = useToast();
  const compact = useIsCompactFormFactor();
  const workspaceRoot = useWorkspace(workspaceId, (workspace) => workspace.directory);
  const paths = workspaceRoot ? resolveWorkspaceFilePaths({ path, workspaceRoot }) : null;
  const relativePath = paths?.relativePath;
  const [model] = useState(() => new FilePathCopyModel(clipboard));
  const status = useSyncExternalStore(model.subscribe, model.getSnapshot, model.getSnapshot);
  const pending = status === "pending";

  useEffect(() => {
    if (status === "copied") {
      toast.copied(t("workspace.tabs.toasts.filePathCopiedLabel"));
    } else if (status === "error") {
      return toast.show(
        <View style={styles.error}>
          <Text style={styles.message}>{t("workspace.tabs.toasts.copyFailed")}</Text>
          <Button variant="ghost" size="sm" onPress={model.dismissError}>
            {t("common.actions.dismiss")}
          </Button>
        </View>,
        { variant: "error", durationMs: null },
      );
    }
  }, [model, status, t, toast]);
  const copyPath = useStableEvent(() => {
    void model.copy(paths?.absolutePath ?? path);
  });
  const copyRelativePath = useStableEvent(() => {
    if (relativePath) void model.copy(relativePath);
  });
  const iconSize = paneContentToolbarIconSize(compact);

  return (
    <DropdownMenu compactMode="sheet">
      <ToolbarButton
        kind="menu"
        compact={compact}
        hitSlop={8}
        label={t("workspace.fileActions.moreActions")}
        disabled={pending}
        testID="file-path-actions-trigger"
      >
        {pending ? (
          <ThemedSpinner size={iconSize} uniProps={mutedIconMapping} />
        ) : (
          <ThemedCopy size={iconSize} uniProps={mutedIconMapping} />
        )}
      </ToolbarButton>
      <FileActionsContextMenuContent
        fileKind="file"
        onCopyPath={copyPath}
        onCopyRelativePath={relativePath ? copyRelativePath : undefined}
        testIDPrefix="file-path-actions"
      />
    </DropdownMenu>
  );
}

const styles = StyleSheet.create((theme) => ({
  error: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  message: { color: theme.colors.foreground, fontSize: theme.fontSize.sm, flexShrink: 1 },
}));
