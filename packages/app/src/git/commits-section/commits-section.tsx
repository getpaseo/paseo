import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type PointerEvent as RNPointerEvent,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { isWeb } from "@/constants/platform";
import { useIsCompactFormFactor } from "@/constants/layout";
import { useChangesPreferences } from "@/hooks/use-changes-preferences";
import { useCheckoutCommitsQuery } from "@/git/use-commits-query";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";
import { inlineUnistylesStyle } from "@/styles/unistyles-inline-style";
import { CommitRow } from "./commit-row";
import { type FilePressHandler, dotStyles } from "./shared";
import { clampCommitsSectionHeight, commitsSectionHeightBounds } from "./resize";

interface CommitsSectionProps {
  serverId: string;
  cwd: string;
  onFilePress?: FilePressHandler;
}

export function CommitsSection({ serverId, cwd, onFilePress }: CommitsSectionProps) {
  const { t } = useTranslation();
  const { commits, capabilityMissing, isLoading, error } = useCheckoutCommitsQuery({
    serverId,
    cwd,
  });
  const { preferences, updatePreferences } = useChangesPreferences();
  const collapsed = preferences.commitsCollapsed;
  const isCompact = useIsCompactFormFactor();
  // The resizable, height-constrained layout is desktop-web only; native and
  // compact form factors keep the original content-sized behavior.
  const resizable = isWeb && !isCompact;
  // Reuse the global Changes list/tree preference (toggled by the Changes panel
  // toolbar) so an expanded commit's file list mirrors that view; no separate
  // toggle lives here.
  const fileView = preferences.fileView;
  const [expandedShas, setExpandedShas] = useState<ReadonlySet<string>>(() => new Set());

  // Live drag height (null while idle = use the persisted preference).
  const [draftHeight, setDraftHeight] = useState<number | null>(null);
  const draftHeightRef = useRef<number | null>(null);
  // Tears down an in-flight drag (listeners + pointer capture + cursor) if the
  // component unmounts mid-drag, preventing stale setState on a dead component.
  const cleanupRef = useRef<(() => void) | null>(null);

  const persistedHeight = preferences.commitsSectionHeight;
  const effectiveHeight = draftHeight ?? persistedHeight;
  const showResizableLayout = resizable && !collapsed;

  // Snapshot the current height in a ref so handleResizeStart can read the
  // start value at pointerdown without depending on effectiveHeight (which
  // changes every drag frame and would recreate the callback each frame).
  const effectiveHeightRef = useRef(effectiveHeight);
  effectiveHeightRef.current = effectiveHeight;

  useEffect(
    () => () => {
      cleanupRef.current?.();
    },
    [],
  );

  const handleToggleSection = useCallback(() => {
    void updatePreferences({ commitsCollapsed: !collapsed });
  }, [collapsed, updatePreferences]);

  const handleToggleCommit = useCallback((sha: string) => {
    setExpandedShas((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) {
        next.delete(sha);
      } else {
        next.add(sha);
      }
      return next;
    });
  }, []);

  const handleResizeStart = useCallback(
    (event: RNPointerEvent) => {
      if (!isWeb) {
        return;
      }
      const handleElement = event.currentTarget as unknown as HTMLElement | null;
      if (!handleElement) {
        return;
      }
      // The commits-section container is the handle's parent; its grandparent is
      // the diff-pane container whose height bounds how far we can drag.
      const sectionElement = handleElement.parentElement;
      const containerElement = sectionElement?.parentElement ?? null;
      const containerHeight = containerElement?.getBoundingClientRect().height ?? 0;
      const bounds = commitsSectionHeightBounds(containerHeight);

      const pointerId = event.nativeEvent.pointerId;
      const startY = event.nativeEvent.clientY;
      const startHeight = clampCommitsSectionHeight(effectiveHeightRef.current, bounds);

      setDraftHeight(startHeight);
      draftHeightRef.current = startHeight;
      handleElement.setPointerCapture?.(pointerId);
      event.preventDefault();
      event.stopPropagation();

      const previousCursor = document.body.style.cursor;
      document.body.style.cursor = "row-resize";

      function handlePointerMove(moveEvent: PointerEvent) {
        if (moveEvent.pointerId !== pointerId) {
          return;
        }
        // Handle sits at the TOP of the bottom drawer: dragging up (clientY
        // decreasing) grows the drawer, dragging down shrinks it.
        const next = clampCommitsSectionHeight(startHeight - (moveEvent.clientY - startY), bounds);
        draftHeightRef.current = next;
        setDraftHeight(next);
      }

      function cleanup() {
        cleanupRef.current = null;
        document.body.style.cursor = previousCursor;
        if (handleElement?.hasPointerCapture?.(pointerId)) {
          handleElement.releasePointerCapture(pointerId);
        }
        window.removeEventListener("pointermove", handlePointerMove);
        window.removeEventListener("pointerup", handlePointerUp);
        window.removeEventListener("pointercancel", handlePointerUp);
        const finalHeight = draftHeightRef.current;
        draftHeightRef.current = null;
        setDraftHeight(null);
        if (finalHeight !== null) {
          void updatePreferences({ commitsSectionHeight: finalHeight });
        }
      }

      function handlePointerUp(upEvent: PointerEvent) {
        if (upEvent.pointerId !== pointerId) {
          return;
        }
        cleanup();
      }

      cleanupRef.current = cleanup;
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
    },
    [updatePreferences],
  );

  const headerChevronStyle = useMemo(
    () => [styles.headerChevron, !collapsed && styles.headerChevronExpanded],
    [collapsed],
  );

  const sectionStyle = useMemo(
    () =>
      showResizableLayout
        ? // The resize handle's bar (at the top of the drawer) is the visible
          // divider in this mode, so the container drops its own top border to
          // avoid a doubled line.
          [
            styles.container,
            styles.containerResizable,
            inlineUnistylesStyle({ height: effectiveHeight }),
          ]
        : styles.container,
    [showResizableLayout, effectiveHeight],
  );

  if (capabilityMissing) {
    return null;
  }

  if (commits.length === 0) {
    if (error) {
      return (
        <View style={styles.container}>
          <Text style={styles.errorRow} testID="commits-section-error">
            {t("workspace.git.diff.commits.loadError")}
          </Text>
        </View>
      );
    }
    if (isLoading) {
      return (
        <View style={styles.container}>
          <Text style={styles.loadingRow} testID="commits-section-loading">
            {t("workspace.git.diff.commits.loading")}
          </Text>
        </View>
      );
    }
    return null;
  }

  const commitRows = commits.map((commit) => (
    <CommitRow
      key={commit.sha}
      commit={commit}
      expanded={expandedShas.has(commit.sha)}
      serverId={serverId}
      cwd={cwd}
      fileView={fileView}
      onToggle={handleToggleCommit}
      onFilePress={onFilePress}
    />
  ));

  let listContent = null;
  if (!collapsed) {
    listContent = showResizableLayout ? (
      <ScrollView style={styles.scrollList} contentContainerStyle={styles.list}>
        {commitRows}
      </ScrollView>
    ) : (
      <View style={styles.list}>{commitRows}</View>
    );
  }

  return (
    <View style={sectionStyle}>
      {showResizableLayout ? (
        <View
          role="separator"
          aria-orientation="horizontal"
          aria-label={t("workspace.git.diff.commits.resizeHandle")}
          testID="commits-section-resize-handle"
          style={RESIZE_HANDLE_STYLE}
          onPointerDown={handleResizeStart}
        >
          <View pointerEvents="none" style={styles.resizeHandleBar} />
        </View>
      ) : null}
      <Pressable
        accessibilityRole="button"
        testID="commits-section-header"
        onPress={handleToggleSection}
        style={styles.header}
      >
        <View style={headerChevronStyle}>
          <ThemedChevron size={14} uniProps={chevronColorMapping} />
        </View>
        <Text style={styles.title}>{t("workspace.git.diff.commits.title")}</Text>
        <Text
          style={styles.count}
          accessibilityLabel={t("workspace.git.diff.commits.countLabel", {
            count: commits.length,
          })}
        >
          {commits.length}
        </Text>
        <View style={styles.legend}>
          <View style={dotStyles.dotLocal} />
          <Text style={styles.legendText}>{t("workspace.git.diff.commits.legendLocal")}</Text>
          <View style={dotStyles.legendDotRemote} />
          <Text style={styles.legendText}>{t("workspace.git.diff.commits.legendRemote")}</Text>
        </View>
      </Pressable>
      {listContent}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
  },
  containerResizable: {
    borderTopWidth: 0,
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    flexShrink: 0,
  },
  headerChevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  headerChevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  title: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
  count: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    flex: 1,
  },
  legend: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flexShrink: 0,
  },
  legendText: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
  },
  scrollList: {
    flex: 1,
    minHeight: 0,
  },
  list: {
    paddingBottom: theme.spacing[1],
  },
  resizeHandle: {
    height: 9,
    justifyContent: "center",
    alignItems: "stretch",
    flexShrink: 0,
  },
  resizeHandleBar: {
    height: theme.borderWidth[1],
    backgroundColor: theme.colors.border,
  },
  loadingRow: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.foregroundMuted,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  errorRow: {
    fontSize: theme.fontSize.xs,
    color: theme.colors.statusDanger,
    paddingLeft: theme.spacing[2],
    paddingRight: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
}));

const RESIZE_HANDLE_STYLE = [
  styles.resizeHandle,
  isWeb ? ({ cursor: "row-resize", touchAction: "none" } as object) : null,
];
