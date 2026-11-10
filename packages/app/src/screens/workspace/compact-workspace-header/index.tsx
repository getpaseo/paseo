import { Fragment, useCallback, useLayoutEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CompactHeader, CompactHeaderTitle } from "@/components/headers/compact-header";
import { ScreenHeader } from "@/components/headers/screen-header";
import { SidebarMenuToggle } from "@/components/headers/sidebar-menu-toggle";
import { View, type LayoutChangeEvent } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useWindowChromeInlinePadding } from "@/utils/desktop-window";
import {
  EXPLORER_TOGGLE_KEYS,
  WorkspaceExplorerToggle,
} from "@/screens/workspace/workspace-explorer-toggle";
import { WorkspaceHeaderProjectRow } from "@/screens/workspace/workspace-header-project-row";
import {
  useWindowLayout,
  resolveWorkspaceActionPlacement,
  resolveWorkspaceBarActions,
  WindowLayoutActions,
} from "@/window-layout";
import { IconButtonChromeProvider } from "@/components/ui/icon-button-chrome";
import {
  resolveInlineWorkspaceTabPresentation,
  resolveInlineWorkspaceTabBudget,
  type WorkspaceInlineTabPresentation,
} from "@/screens/workspace/workspace-tab-layout";
import { WorkspaceActions } from "@/git/workspace-actions";
import {
  useWorkspaceHeaderWidth,
  type WorkspaceHeaderGeometry,
} from "@/screens/workspace/use-workspace-header-width";

export { MobileWorkspaceTabSwitcher } from "./tab-switcher";

interface CompactWorkspaceHeaderProps {
  serverId: string;
  workspaceDirectory?: string | null;
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  onToggleExplorer: () => void;
  explorerToggleLabel: string;
  explorerToggleAccessibilityState: { expanded: boolean };
  tabSwitcher: ReactNode;
  inlineTabRail?: ReactNode;
  inlineTabsNaturalWidth?: number | null;
  inlineHeaderGeometry: WorkspaceHeaderGeometry;
  /** Workspace overflow menu. */
  children: ReactNode;
  headerVariant: "compact" | "full" | "inline";
  actionsActive: boolean;
}

interface InlineWorkspaceHeaderProps {
  loading: boolean;
  title: string;
  projectRow: ReactNode;
  tabRail: ReactNode;
  tabSwitcher: ReactNode;
  naturalWidth: number | null;
  geometry: WorkspaceHeaderGeometry;
  horizontalPadding: number;
  tabGap: number;
}

function InlineHeaderLeading({
  loading,
  title,
  projectRow,
  expanded = false,
  measuring = false,
  children,
}: Pick<InlineWorkspaceHeaderProps, "loading" | "title" | "projectRow"> & {
  expanded?: boolean;
  measuring?: boolean;
  children?: ReactNode;
}) {
  return (
    <>
      <SidebarMenuToggle
        testID={measuring ? "workspace-header-sidebar-measurement" : undefined}
        nativeID={measuring ? "workspace-header-sidebar-measurement" : undefined}
      />
      <View style={measuring ? styles.measuringTitleText : styles.inlineContent}>
        <View style={expanded ? styles.expandedTitleText : styles.inlineTitleText}>
          <CompactHeaderTitle
            loading={loading}
            title={title}
            titleTestID={measuring ? undefined : "workspace-header-title"}
            subtitle={projectRow}
            fadeOverflow
            workspaceRow
          />
        </View>
        {children}
      </View>
    </>
  );
}

function InlineWorkspaceHeaderBase({
  loading,
  title,
  projectRow,
  tabRail,
  tabSwitcher,
  naturalWidth,
  geometry,
  horizontalPadding,
  tabGap,
}: InlineWorkspaceHeaderProps) {
  const targetWidth = useWorkspaceHeaderWidth(geometry);
  const headerWidth = targetWidth;
  const chrome = useWindowChromeInlinePadding();
  const horizontalInset = chrome.paddingLeft + chrome.paddingRight + horizontalPadding * 2;
  const [leadingWidth, setLeadingWidth] = useState(0);
  const [lastPresentation, setLastPresentation] = useState<WorkspaceInlineTabPresentation>("tabs");
  const measureLeading = useCallback((event: LayoutChangeEvent) => {
    setLeadingWidth(event.nativeEvent.layout.width);
  }, []);
  const width = resolveInlineWorkspaceTabBudget({
    width: headerWidth,
    horizontalInset,
    leadingWidth,
    gap: tabGap,
  });
  const presentation =
    leadingWidth > 0 && headerWidth > 0
      ? resolveInlineWorkspaceTabPresentation(width, naturalWidth, lastPresentation)
      : lastPresentation;
  useLayoutEffect(() => {
    setLastPresentation(presentation);
  }, [presentation]);
  const picker = presentation === "switcher";
  const measuredLeading = useMemo(
    () => (
      <View style={styles.measuringLeading} onLayout={measureLeading}>
        <InlineHeaderLeading loading={loading} title={title} projectRow={projectRow} measuring />
      </View>
    ),
    [loading, title, projectRow, measureLeading],
  );
  const railWidthStyle = useMemo(
    () => ({
      width: Math.min(naturalWidth ?? width, width),
    }),
    [naturalWidth, width],
  );
  const railStyle = useMemo(
    () => [styles.inlineRail, railWidthStyle, picker && styles.measuringRail],
    [railWidthStyle, picker],
  );
  const visibleLeading = useMemo(
    () => (
      <InlineHeaderLeading
        loading={loading}
        title={title}
        projectRow={projectRow}
        expanded={picker}
      >
        <View
          style={railStyle}
          pointerEvents={picker ? "none" : "box-none"}
          accessibilityElementsHidden={picker}
          importantForAccessibility={picker ? "no-hide-descendants" : "auto"}
        >
          {tabRail}
        </View>
      </InlineHeaderLeading>
    ),
    [loading, title, projectRow, picker, railStyle, tabRail],
  );
  const measuredRail = useMemo(() => <View style={styles.inlineTabViewport} />, []);
  const visibleSwitcher = picker ? tabSwitcher : undefined;
  const switcherStyle = picker ? styles.switcherAction : undefined;
  return (
    <View style={styles.inlineHeaderContent}>
      {/* Measure stable title chrome, not the collapsing viewport. The target allocation
          chooses the presentation in the same render that opens or closes Explorer. */}
      <View
        style={styles.measuringHeader}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
      >
        <ScreenHeader
          left={measuredLeading}
          leftStyle={styles.measuringTitle}
          right={measuredRail}
          rightStyle={styles.inlineTabs}
          borderless
        />
      </View>
      <View style={styles.visibleHeader}>
        <ScreenHeader
          left={visibleLeading}
          right={visibleSwitcher}
          rightStyle={switcherStyle}
          borderless
        />
      </View>
    </View>
  );
}

const InlineWorkspaceHeader = withUnistyles(InlineWorkspaceHeaderBase, (theme) => ({
  horizontalPadding: theme.spacing[3],
  tabGap: theme.spacing[4],
}));

/** The compact header with the workspace's project row and controls. */
export function CompactWorkspaceHeader({
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  onToggleExplorer,
  explorerToggleLabel,
  explorerToggleAccessibilityState,
  children,
  tabSwitcher,
  inlineTabRail,
  inlineTabsNaturalWidth = null,
  inlineHeaderGeometry,
  serverId,
  workspaceDirectory,
  headerVariant,
  actionsActive,
}: CompactWorkspaceHeaderProps) {
  const { t } = useTranslation();
  const actionsInBar = resolveWorkspaceActionPlacement(useWindowLayout()) === "vertical-bar";
  const projectRow = useMemo(
    () => (
      <WorkspaceHeaderProjectRow
        subtitle={subtitle}
        isSubtitleDistinct={isSubtitleDistinct}
        serverId={serverId}
        size={headerVariant === "inline" ? "sm" : "md"}
      />
    ),
    [subtitle, isSubtitleDistinct, serverId, headerVariant],
  );
  const symbols = {
    "tab-count": tabSwitcher,
    git: workspaceDirectory ? (
      <WorkspaceActions serverId={serverId} cwd={workspaceDirectory} menuOnly />
    ) : null,
    overflow: children,
    explorer: (
      <WorkspaceExplorerToggle
        onPress={onToggleExplorer}
        label={explorerToggleLabel}
        tooltipLabel={t("workspace.tabs.explorerSidebar.toggle")}
        tooltipKeys={EXPLORER_TOGGLE_KEYS}
        accessibilityState={explorerToggleAccessibilityState}
        mobile
      />
    ),
  };
  const actions = (
    <>
      {resolveWorkspaceBarActions(headerVariant).map((symbol) => (
        <Fragment key={symbol}>{symbols[symbol]}</Fragment>
      ))}
    </>
  );

  return (
    <IconButtonChromeProvider value="header-island">
      {headerVariant === "compact" ? (
        <CompactHeader
          navigation="menu"
          title={title}
          titleTestID="workspace-header-title"
          subtitle={projectRow}
          loading={isLoading}
          actions={actionsInBar ? undefined : actions}
        />
      ) : null}
      {headerVariant === "inline" ? (
        <InlineWorkspaceHeader
          loading={isLoading}
          title={title}
          projectRow={projectRow}
          tabRail={inlineTabRail}
          tabSwitcher={tabSwitcher}
          naturalWidth={inlineTabsNaturalWidth}
          geometry={inlineHeaderGeometry}
        />
      ) : null}
      <WindowLayoutActions active={actionsActive}>{actions}</WindowLayoutActions>
    </IconButtonChromeProvider>
  );
}

const styles = StyleSheet.create((theme) => ({
  inlineHeaderContent: { position: "relative" },
  measuringHeader: { opacity: 0 },
  visibleHeader: { position: "absolute", top: 0, right: 0, bottom: 0, left: 0 },
  expandedTitleText: { flex: 1, minWidth: 0 },
  switcherAction: { marginLeft: theme.spacing[4] },
  measuringTitle: {
    flex: 0,
    flexBasis: "auto",
    flexShrink: 0,
    minWidth: 0,
  },
  measuringLeading: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  measuringTitleText: { flexShrink: 1, minWidth: 0, maxWidth: 240 },
  inlineContent: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[4],
  },
  inlineTitleText: { flexShrink: 1, minWidth: 0 },
  inlineRail: { flexShrink: 0, maxWidth: "100%" },
  measuringRail: { position: "absolute", opacity: 0 },
  inlineTabs: { flex: 1, minWidth: 0, marginLeft: theme.spacing[4] },
  inlineTabViewport: { flex: 1, minWidth: 0 },
}));
