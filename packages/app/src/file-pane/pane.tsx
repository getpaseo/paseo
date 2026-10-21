import { useEffect, useMemo, useState } from "react";
import type { PluginFile, PluginFileTab } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useFileHandle, useFileHandleSnapshot } from "@/file-panels/file";
import { FilePanelLoading } from "@/file-panels/loading";
import { FilePanelPicker, FilePanelView, useFilePanelChoice, type FilePanel } from "@/file-panels";
import { resolveFilePreviewReadTarget } from "@/file-explorer/preview-target";
import { useAppActivelyVisible } from "@/hooks/use-app-visible";
import { usePublishPanelInstanceAttributes } from "@/panels/panel-instance-attributes";
import { useSessionStore } from "@/stores/session-store";
import { buildAbsoluteExplorerPath } from "@/utils/explorer-paths";
import { formatFileSize } from "@/utils/format-file-size";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import { FilePanelBar } from "./bar";

/**
 * The file tab: stats the file, picks its panel and mounts it. The panel reads, saves and shows
 * its own loading; the tab only knows the file exists, its kind, and whether the panel has
 * unsaved changes.
 */
export function FilePane({
  serverId,
  workspaceRoot,
  location,
  navigationRevision,
}: {
  serverId: string;
  workspaceRoot: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
}) {
  const { t } = useTranslation();
  const connected = useSessionStore((state) => Boolean(state.sessions[serverId]?.client));
  const root = workspaceRoot.trim();
  const path = location.path.trim();
  const target = useMemo(
    () => (path ? resolveFilePreviewReadTarget({ path, workspaceRoot: root }) : null),
    [path, root],
  );
  const absolutePath = useMemo(
    () => buildAbsoluteExplorerPath({ workspaceRoot: root, entryPath: path }),
    [path, root],
  );
  // A hidden tab or a backgrounded app stops observing; observing again reports what changed.
  const isActive = useRetainedPanelActive();
  const isAppVisible = useAppActivelyVisible();
  const handle = useFileHandle({
    serverId,
    target,
    absolutePath,
    observing: isActive && isAppVisible,
  });
  const snapshot = useFileHandleSnapshot(handle);
  const targetKey = target ? `${target.cwd}:${target.path}` : null;
  const { panel, choice } = useFilePanelChoice({
    serverId,
    targetKey,
    path,
    fileKind: snapshot.status === "ready" ? snapshot.kind : null,
    presentable: isActive,
    lineNavigation: location.lineStart ? navigationRevision : null,
  });
  const [modified, setModified] = useState(false);
  usePublishPanelInstanceAttributes({ modified, suspendPendingSave: handle?.holdWrites });
  const panelLocation = useMemo(
    () => ({
      lineStart: location.lineStart,
      lineEnd: location.lineEnd,
      revision: navigationRevision,
    }),
    [location.lineEnd, location.lineStart, navigationRevision],
  );
  const panelTarget = useMemo(
    () => ({ serverId, workspaceRoot: root, path }),
    [path, root, serverId],
  );

  let body;
  if (!connected && target) {
    body = <Text style={styles.errorText}>{t("workspace.terminal.hostDisconnected")}</Text>;
  } else if (!handle || snapshot.status === "loading") {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelLoading />
      </View>
    );
  } else if (snapshot.status === "missing" || snapshot.status === "error") {
    body = (
      <>
        <Text style={styles.errorText}>
          {snapshot.status === "error" ? snapshot.error : t("panels.file.notFound")}
        </Text>
        <Button variant="outline" size="sm" onPress={handle.retry}>
          {t("common.actions.retry")}
        </Button>
      </>
    );
  } else if (!panel) {
    body = (
      <>
        <Text style={styles.mutedText}>{t("panels.file.binaryPreviewUnavailable")}</Text>
        <Text style={styles.mutedText}>{formatFileSize(snapshot.size)}</Text>
      </>
    );
  } else {
    return (
      <View style={styles.container} testID="workspace-file-pane">
        <FilePanelPicker choice={choice} />
        <FilePanelBar choice={choice} modified={modified} />
        <MountedFilePanel
          key={`${panel.id}:${targetKey}`}
          panel={panel}
          file={handle.file}
          location={panelLocation}
          target={panelTarget}
          onModifiedChange={setModified}
        />
      </View>
    );
  }
  return (
    <View style={styles.container} testID="workspace-file-pane">
      <View style={styles.centerState}>{body}</View>
    </View>
  );
}

/** One panel mount. Its tab reports unsaved changes until the panel unmounts. */
function MountedFilePanel({
  panel,
  file,
  location,
  target,
  onModifiedChange,
}: {
  panel: FilePanel;
  file: PluginFile;
  location: { lineStart?: number; lineEnd?: number; revision: number };
  target: { serverId: string; workspaceRoot: string; path: string };
  onModifiedChange: (modified: boolean) => void;
}) {
  const [tab] = useState<PluginFileTab>(() => ({
    setModified: (modified) => onModifiedChange(modified),
  }));
  useEffect(() => () => onModifiedChange(false), [onModifiedChange]);
  return <FilePanelView panel={panel} file={file} tab={tab} location={location} target={target} />;
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[4],
  },
  errorText: {
    color: theme.colors.destructive,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
  mutedText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
