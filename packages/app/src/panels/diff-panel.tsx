import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ActivityIndicator,
  FlatList,
  type FlatListProps,
  type LayoutChangeEvent,
  Text,
  type TextStyle,
  View,
} from "react-native";
import { SvgXml } from "react-native-svg";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import type { ParsedDiffFile } from "@getpaseo/protocol/messages";
import { GitCommitHorizontal } from "lucide-react-native";
import { DiffStat } from "@/components/diff-stat";
import { getFileIconSvg } from "@/components/material-file-icons";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isWeb } from "@/constants/platform";
import { DiffFileBody } from "@/git/diff-pane";
import type { DiffTarget } from "@/git/diff-target";
import { useDiffFiles } from "@/git/use-diff-files";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useAppSettings } from "@/hooks/use-settings";
import { usePaneContext } from "@/panels/pane-context";
import {
  buildDiffPanelSections,
  diffPanelBodyHeightKey,
  diffPanelItemKey,
  getUnifiedDiffLineCount,
  type DiffPanelItem,
} from "@/panels/diff-panel-sections";
import type { PanelDescriptor, PanelRegistration } from "@/panels/panel-registry";
import { useWorkspaceDirectory } from "@/stores/session-store-hooks";
import type { WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { BORDER_WIDTH, SPACING, type Theme } from "@/styles/theme";
import { buildSplitDiffRows } from "@/utils/diff-layout";

const ThemedActivityIndicator = withUnistyles(ActivityIndicator);
const ThemedGitCommitHorizontal = withUnistyles(GitCommitHorizontal);
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

// Estimated heights (in px) reused by getItemLayout so scroll-to-file lands close
// even before a section has measured itself. Mirrors GitDiffPane's estimation.
const DIFF_PANEL_DEFAULT_HEADER_HEIGHT = 44;
const DIFF_HEIGHT_CHANGE_EPSILON = 0.5;

const DiffSectionHeader = memo(function DiffSectionHeader({
  file,
  onHeaderHeightChange,
  testID,
}: {
  file: ParsedDiffFile;
  onHeaderHeightChange: (path: string, height: number) => void;
  testID?: string;
}) {
  const { t } = useTranslation();
  const fileName = file.path.split("/").pop() ?? file.path;
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onHeaderHeightChange(file.path, event.nativeEvent.layout.height);
    },
    [file.path, onHeaderHeightChange],
  );

  return (
    <View style={styles.fileHeader} onLayout={handleLayout} testID={testID}>
      <View style={styles.fileIcon}>
        <SvgXml xml={getFileIconSvg(file.path)} width={16} height={16} />
      </View>
      <Text style={styles.fileName} numberOfLines={1}>
        {fileName}
      </Text>
      {dir ? (
        <Text style={styles.fileDir} numberOfLines={1}>
          {` ${dir}`}
        </Text>
      ) : (
        <View style={styles.fileDirSpacer} />
      )}
      {file.isNew ? (
        <View style={styles.newBadge}>
          <Text style={styles.newBadgeText}>{t("workspace.git.diff.newFile")}</Text>
        </View>
      ) : null}
      {file.isDeleted ? (
        <View style={styles.deletedBadge}>
          <Text style={styles.deletedBadgeText}>{t("workspace.git.diff.deletedFile")}</Text>
        </View>
      ) : null}
      <DiffStat additions={file.additions} deletions={file.deletions} />
    </View>
  );
});

type DiffPanelItemLayoutGetter = NonNullable<FlatListProps<DiffPanelItem>["getItemLayout"]>;

/**
 * Renders the full diff for a {@link DiffTarget}: every changed file expanded,
 * each as a non-collapsible header + the shared {@link DiffFileBody}. Scrolls so
 * the section for `focusPath` is at the top on mount and whenever `focusPath`
 * changes (e.g. re-clicking a file in the sidebar retargets the same tab).
 *
 * Inline commenting (`reviewActions`) is intentionally not wired here yet; it is
 * relocated into the diff tab in a later slice. For now the tab is a read-only
 * full diff view that stays pixel-identical to the Changes panel via DiffFileBody.
 */
function DiffPanelBody({
  serverId,
  workspaceId,
  cwd,
  target,
  focusPath,
}: {
  serverId: string;
  workspaceId: string;
  cwd: string;
  target: DiffTarget;
  focusPath?: string;
}) {
  const { t } = useTranslation();
  const { settings } = useAppSettings();
  const { preferences } = useChangesPreferences();
  const isCompact = useIsCompactFormFactor();

  const { files, isLoading, error, capabilityMissing } = useDiffFiles(target, {
    serverId,
    workspaceId,
    cwd,
  });

  // Layout/typography resolved identically to GitDiffPane + CommitFileDiffView so
  // the diff tab is pixel-identical: split only on non-compact web, else unified.
  const wrapLines = preferences.wrapLines;
  const layout = isWeb && !isCompact ? preferences.layout : "unified";
  const codeFontSize = settings.codeFontSize;
  const diffBodyLineHeight = Math.round(codeFontSize * 1.5);
  const typographyKey = [settings.monoFontFamily, codeFontSize, diffBodyLineHeight].join(":");
  const textMetricsStyle = useMemo<TextStyle>(() => {
    const monoFontFamily = settings.monoFontFamily.trim();
    return {
      fontSize: codeFontSize,
      lineHeight: diffBodyLineHeight,
      ...(monoFontFamily ? { fontFamily: monoFontFamily } : null),
    };
  }, [settings.monoFontFamily, codeFontSize, diffBodyLineHeight]);
  const sections = useMemo(
    () => buildDiffPanelSections(files, new Set(files.map((file) => file.path))),
    [files],
  );

  // Measured heights drive both getItemLayout (so FlatList virtualization +
  // scroll-to-file are accurate) and the offset computation for focusPath.
  const listRef = useRef<FlatList<DiffPanelItem>>(null);
  const headerHeightByPathRef = useRef<Record<string, number>>({});
  const bodyHeightByKeyRef = useRef<Record<string, number>>({});
  const [heightVersion, setHeightVersion] = useState(0);

  const diffBodyChromeHeight = BORDER_WIDTH[1] * 2;
  const statusBodyHeightEstimate = diffBodyChromeHeight + SPACING[4] * 2 + diffBodyLineHeight;

  const bodyHeightKey = useCallback(
    (file: ParsedDiffFile) => diffPanelBodyHeightKey(file, { layout, wrapLines, typographyKey }),
    [layout, typographyKey, wrapLines],
  );

  const estimateBodyHeight = useCallback(
    (file: ParsedDiffFile): number => {
      if (file.status === "too_large" || file.status === "binary") {
        return statusBodyHeightEstimate;
      }
      const lineCount =
        layout === "split" ? buildSplitDiffRows(file).length : getUnifiedDiffLineCount(file);
      return diffBodyChromeHeight + lineCount * diffBodyLineHeight;
    },
    [diffBodyChromeHeight, diffBodyLineHeight, layout, statusBodyHeightEstimate],
  );

  const handleHeaderHeightChange = useCallback((path: string, height: number) => {
    if (!Number.isFinite(height) || height <= 0) {
      return;
    }
    const previous = headerHeightByPathRef.current[path];
    if (previous !== undefined && Math.abs(previous - height) <= DIFF_HEIGHT_CHANGE_EPSILON) {
      return;
    }
    headerHeightByPathRef.current[path] = height;
    setHeightVersion((version) => version + 1);
  }, []);

  const handleBodyHeightChange = useCallback(
    (file: ParsedDiffFile, height: number) => {
      if (!Number.isFinite(height) || height < 0) {
        return;
      }
      const key = bodyHeightKey(file);
      const previous = bodyHeightByKeyRef.current[key];
      if (previous !== undefined && Math.abs(previous - height) <= DIFF_HEIGHT_CHANGE_EPSILON) {
        return;
      }
      bodyHeightByKeyRef.current[key] = height;
      setHeightVersion((version) => version + 1);
    },
    [bodyHeightKey],
  );

  const itemHeight = useCallback(
    (item: DiffPanelItem): number => {
      if (item.type === "header") {
        return headerHeightByPathRef.current[item.file.path] ?? DIFF_PANEL_DEFAULT_HEADER_HEIGHT;
      }
      return bodyHeightByKeyRef.current[bodyHeightKey(item.file)] ?? estimateBodyHeight(item.file);
    },
    [bodyHeightKey, estimateBodyHeight],
  );

  const getItemLayout = useCallback<DiffPanelItemLayoutGetter>(
    (_data, index) => {
      let offset = 0;
      for (let i = 0; i < index; i += 1) {
        const item = sections[i];
        if (item) {
          offset += itemHeight(item);
        }
      }
      const item = sections[index];
      return { length: item ? itemHeight(item) : 0, offset, index };
    },
    [itemHeight, sections],
  );

  // Offset of a file's header from the top of the list, summing every preceding
  // section's header + body height. Drives scroll-to-file for `focusPath`.
  const computeHeaderOffset = useCallback(
    (path: string): number => {
      let offset = 0;
      for (const file of files) {
        if (file.path === path) {
          break;
        }
        offset += headerHeightByPathRef.current[file.path] ?? DIFF_PANEL_DEFAULT_HEADER_HEIGHT;
        offset += bodyHeightByKeyRef.current[bodyHeightKey(file)] ?? estimateBodyHeight(file);
      }
      return Math.max(0, offset);
    },
    [bodyHeightKey, estimateBodyHeight, files],
  );

  // Scroll the focused file's section to the top on mount and whenever focusPath
  // changes. heightVersion re-runs this once sections measure, so the landing is
  // accurate even when initial heights were estimates. Mirrors how a file tab
  // scrolls to its lineStart.
  useEffect(() => {
    if (!focusPath) {
      return;
    }
    if (!files.some((file) => file.path === focusPath)) {
      return;
    }
    listRef.current?.scrollToOffset({ offset: computeHeaderOffset(focusPath), animated: false });
  }, [computeHeaderOffset, files, focusPath, heightVersion]);

  const renderItem = useCallback(
    ({ item }: { item: DiffPanelItem }) => {
      if (item.type === "header") {
        return (
          <DiffSectionHeader
            file={item.file}
            onHeaderHeightChange={handleHeaderHeightChange}
            testID={`diff-panel-file-${item.fileIndex}`}
          />
        );
      }
      return (
        <DiffFileBody
          file={item.file}
          layout={layout}
          wrapLines={wrapLines}
          codeFontSize={codeFontSize}
          textMetricsStyle={textMetricsStyle}
          onBodyHeightChange={handleBodyHeightChange}
          testID={`diff-panel-file-${item.fileIndex}-body`}
        />
      );
    },
    [
      codeFontSize,
      handleBodyHeightChange,
      handleHeaderHeightChange,
      layout,
      textMetricsStyle,
      wrapLines,
    ],
  );

  const extraData = useMemo(
    () => ({ heightVersion, layout, wrapLines, typographyKey }),
    [heightVersion, layout, typographyKey, wrapLines],
  );

  if (capabilityMissing) {
    return (
      <View style={styles.centerState} testID="diff-panel-capability-missing">
        <Text style={styles.mutedText}>{t("panels.diff.capabilityMissing")}</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centerState} testID="diff-panel-error">
        <Text style={styles.errorText}>{error.message || t("panels.diff.loadError")}</Text>
      </View>
    );
  }
  if (isLoading && files.length === 0) {
    return (
      <View style={styles.centerState} testID="diff-panel-loading">
        <ThemedActivityIndicator size="large" uniProps={foregroundMutedColorMapping} />
      </View>
    );
  }
  if (files.length === 0) {
    return (
      <View style={styles.centerState} testID="diff-panel-empty">
        <Text style={styles.mutedText}>{t("panels.diff.empty")}</Text>
      </View>
    );
  }

  return (
    <FlatList
      ref={listRef}
      data={sections}
      renderItem={renderItem}
      keyExtractor={diffPanelItemKey}
      getItemLayout={getItemLayout}
      extraData={extraData}
      style={styles.container}
      testID="diff-panel-scroll"
      removeClippedSubviews={false}
      initialNumToRender={12}
      maxToRenderPerBatch={12}
      windowSize={10}
    />
  );
}

function DiffPanel() {
  const { t } = useTranslation();
  const { serverId, workspaceId, target } = usePaneContext();
  const cwd = useWorkspaceDirectory(serverId, workspaceId);
  invariant(target.kind === "diff", "DiffPanel requires diff target");

  if (!cwd) {
    return (
      <View style={styles.centerState}>
        <Text style={styles.mutedText}>{t("panels.diff.directoryMissing")}</Text>
      </View>
    );
  }

  return (
    <DiffPanelBody
      serverId={serverId}
      workspaceId={workspaceId}
      cwd={cwd}
      target={target.diffTarget}
      focusPath={target.focusPath}
    />
  );
}

function useDiffPanelDescriptor(
  target: Extract<WorkspaceTabTarget, { kind: "diff" }>,
): PanelDescriptor {
  const { t } = useTranslation();
  const diffTarget = target.diffTarget;
  const isCommit = diffTarget.kind === "commit";
  return {
    label:
      diffTarget.kind === "commit" ? diffTarget.sha.slice(0, 7) : t("panels.diff.changesLabel"),
    subtitle: isCommit ? t("panels.diff.commitSubtitle") : t("panels.diff.changesSubtitle"),
    titleState: "ready",
    icon: ThemedGitCommitHorizontal,
    statusBucket: null,
  };
}

export const diffPanelRegistration: PanelRegistration<"diff"> = {
  kind: "diff",
  component: DiffPanel,
  useDescriptor: useDiffPanelDescriptor,
};

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  centerState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.spacing[6],
    paddingTop: theme.spacing[16],
  },
  mutedText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
  errorText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.destructive,
    textAlign: "center",
  },
  fileHeader: {
    flexDirection: "row",
    alignItems: "center",
    paddingLeft: theme.spacing[3],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[1],
    minWidth: 0,
    backgroundColor: theme.colors.surface1,
  },
  fileIcon: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  fileName: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foreground,
    flexShrink: 1,
    minWidth: 0,
  },
  fileDir: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.foregroundMuted,
    flex: 1,
    minWidth: 0,
  },
  fileDirSpacer: {
    flex: 1,
  },
  newBadge: {
    backgroundColor: "rgba(46, 160, 67, 0.2)",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  newBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffAddition,
  },
  deletedBadge: {
    backgroundColor: "rgba(248, 81, 73, 0.2)",
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 0,
  },
  deletedBadgeText: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffDeletion,
  },
}));
