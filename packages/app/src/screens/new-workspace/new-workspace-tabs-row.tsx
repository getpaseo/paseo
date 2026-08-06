import React, { useCallback, useMemo, type ReactElement } from "react";
import {
  Pressable,
  ScrollView,
  Text,
  View,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { ChevronDown, Globe, Plus, SquarePen, SquareTerminal, X } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import type { Theme } from "@/styles/theme";

export interface NewWorkspaceTabsRowPanel {
  panelId: string;
  kind: "terminal" | "browser";
}

export interface NewWorkspaceTabsRowProps {
  panels: NewWorkspaceTabsRowPanel[];
  /** null means the composer (chat) view is active. */
  activePanelId: string | null;
  onCreateAgentTab: () => void;
  onCreateTerminal: () => void;
  onCreateBrowser: () => void;
  onActivatePanel: (panelId: string) => void;
  onClosePanel: (panelId: string) => void;
  onCloseComposer?: () => void;
  terminalDisabled: boolean;
  showCreateBrowser: boolean;
}

const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedGlobe = withUnistyles(Globe);
const ThemedPlus = withUnistyles(Plus);
const ThemedSquarePen = withUnistyles(SquarePen);
const ThemedSquareTerminal = withUnistyles(SquareTerminal);
const ThemedX = withUnistyles(X);
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

const COMPOSER_ICON = <ThemedSquarePen size={14} uniProps={mutedColorMapping} />;
const TERMINAL_ICON = <ThemedSquareTerminal size={14} uniProps={mutedColorMapping} />;
const BROWSER_ICON = <ThemedGlobe size={14} uniProps={mutedColorMapping} />;

function newTabActionButtonStyle({ hovered, pressed }: PressableStateCallbackType) {
  return [styles.newTabActionButton, (hovered || pressed) && styles.newTabActionButtonHovered];
}

function inlineAddActionButtonStyle({ hovered, pressed }: PressableStateCallbackType) {
  return [styles.inlineAddActionButton, (hovered || pressed) && styles.newTabActionButtonHovered];
}

function resolvePanelLabel(
  panel: NewWorkspaceTabsRowPanel,
  sameKindIndex: number,
  sameKindCount: number,
  terminalLabel: string,
  browserLabel: string,
): string {
  const base = panel.kind === "terminal" ? terminalLabel : browserLabel;
  if (sameKindCount <= 1) {
    return base;
  }
  return `${base} ${sameKindIndex + 1}`;
}

function stopEvent(event: GestureResponderEvent): void {
  event.stopPropagation();
}

interface TabChipProps {
  label: string;
  icon: ReactElement;
  active: boolean;
  onPress: () => void;
  onClose?: () => void;
  tabTestID: string;
  closeTestID?: string;
}

function TabChip({
  label,
  icon,
  active,
  onPress,
  onClose,
  tabTestID,
  closeTestID,
}: TabChipProps): ReactElement {
  const accessibilityState = useMemo(() => ({ selected: active }), [active]);
  const chipStyle = useCallback(
    ({ hovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.tab,
      (Boolean(hovered) || pressed || active) && styles.tabActive,
    ],
    [active],
  );
  const closeButtonStyle = useCallback(
    ({ hovered: isHovered, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.tabCloseButton,
      (Boolean(isHovered) || pressed) && styles.tabCloseButtonActive,
    ],
    [],
  );
  const handleClosePress = useCallback(
    (event: GestureResponderEvent) => {
      stopEvent(event);
      onClose?.();
    },
    [onClose],
  );
  const handleClosePressIn = useCallback((event: GestureResponderEvent) => {
    stopEvent(event);
  }, []);

  return (
    <Pressable
      testID={tabTestID}
      onPress={onPress}
      style={chipStyle}
      accessibilityRole="button"
      accessibilityState={accessibilityState}
    >
      {active ? <View style={styles.tabFocusIndicator} /> : null}
      <View style={styles.tabIcon}>{icon}</View>
      <Text
        style={[styles.tabLabel, active && styles.tabLabelActive]}
        numberOfLines={1}
        selectable={false}
      >
        {label}
      </Text>
      {onClose && closeTestID ? (
        <Pressable
          testID={closeTestID}
          onPressIn={handleClosePressIn}
          onPress={handleClosePress}
          style={closeButtonStyle}
          accessibilityRole="button"
          accessibilityLabel={label}
        >
          <ThemedX size={12} uniProps={mutedColorMapping} />
        </Pressable>
      ) : null}
    </Pressable>
  );
}

function WorkspacePanelChip({
  panel,
  label,
  active,
  onActivatePanel,
  onClosePanel,
}: {
  panel: NewWorkspaceTabsRowPanel;
  label: string;
  active: boolean;
  onActivatePanel: (panelId: string) => void;
  onClosePanel: (panelId: string) => void;
}): ReactElement {
  const handlePress = useCallback(
    () => onActivatePanel(panel.panelId),
    [onActivatePanel, panel.panelId],
  );
  const handleClose = useCallback(() => onClosePanel(panel.panelId), [onClosePanel, panel.panelId]);

  return (
    <TabChip
      label={label}
      icon={panel.kind === "terminal" ? TERMINAL_ICON : BROWSER_ICON}
      active={active}
      onPress={handlePress}
      onClose={handleClose}
      tabTestID={`new-workspace-panel-tab-${panel.panelId}`}
      closeTestID={`new-workspace-panel-close-${panel.panelId}`}
    />
  );
}

export function NewWorkspaceTabsRow({
  panels,
  activePanelId,
  onCreateAgentTab,
  onCreateTerminal,
  onCreateBrowser,
  onActivatePanel,
  onClosePanel,
  onCloseComposer,
  terminalDisabled,
  showCreateBrowser,
}: NewWorkspaceTabsRowProps): ReactElement {
  const { t } = useTranslation();
  const terminalLabel = t("workspace.tabs.fallback.terminal");
  const browserLabel = t("workspace.tabs.fallback.browser");

  const panelLabels = useMemo(() => {
    const counts = { terminal: 0, browser: 0 };
    for (const panel of panels) {
      counts[panel.kind] += 1;
    }
    const seen = { terminal: 0, browser: 0 };
    const labels = new Map<string, string>();
    for (const panel of panels) {
      const index = seen[panel.kind];
      seen[panel.kind] += 1;
      labels.set(
        panel.panelId,
        resolvePanelLabel(panel, index, counts[panel.kind], terminalLabel, browserLabel),
      );
    }
    return labels;
  }, [browserLabel, panels, terminalLabel]);

  return (
    <View style={styles.tabsContainer} testID="new-workspace-tabs-row">
      <ScrollView
        horizontal
        style={styles.tabsScroll}
        contentContainerStyle={styles.tabsContent}
        showsHorizontalScrollIndicator={false}
      >
        <TabChip
          label={t("workspace.tabs.actions.newAgent")}
          icon={COMPOSER_ICON}
          active={activePanelId === null}
          onPress={onCreateAgentTab}
          onClose={onCloseComposer}
          tabTestID="new-workspace-composer-tab"
          closeTestID="new-workspace-composer-close"
        />
        {panels.map((panel) => (
          <WorkspacePanelChip
            key={panel.panelId}
            panel={panel}
            label={
              panelLabels.get(panel.panelId) ??
              (panel.kind === "terminal" ? terminalLabel : browserLabel)
            }
            active={activePanelId === panel.panelId}
            onActivatePanel={onActivatePanel}
            onClosePanel={onClosePanel}
          />
        ))}
        <View style={styles.inlineAddButton}>
          <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
            <TooltipTrigger
              testID="new-workspace-add-tab-button"
              onPress={onCreateAgentTab}
              accessibilityRole="button"
              accessibilityLabel={t("workspace.tabs.actions.newAgent")}
              style={inlineAddActionButtonStyle}
            >
              <ThemedPlus size={14} uniProps={mutedColorMapping} />
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <Text style={styles.tooltipText}>{t("workspace.tabs.actions.newAgent")}</Text>
            </TooltipContent>
          </Tooltip>
        </View>
      </ScrollView>
      <View style={styles.tabsActions}>
        <DropdownMenu>
          <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
            <TooltipTrigger asChild triggerRefProp="triggerRef">
              <DropdownMenuTrigger
                testID="new-workspace-new-tab-menu-trigger"
                accessibilityRole="button"
                accessibilityLabel={t("workspace.tabs.actions.moreActions")}
                style={newTabActionButtonStyle}
              >
                <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
              </DropdownMenuTrigger>
            </TooltipTrigger>
            <TooltipContent side="bottom" align="center" offset={8}>
              <Text style={styles.tooltipText}>{t("workspace.tabs.actions.moreActions")}</Text>
            </TooltipContent>
          </Tooltip>
          <DropdownMenuContent side="bottom" align="end" offset={4} minWidth={200}>
            <DropdownMenuItem testID="new-workspace-new-tab-menu-agent" onSelect={onCreateAgentTab}>
              {t("workspace.tabs.actions.newAgent")}
            </DropdownMenuItem>
            <DropdownMenuItem
              testID="new-workspace-new-tab-menu-terminal"
              disabled={terminalDisabled}
              onSelect={terminalDisabled ? undefined : onCreateTerminal}
            >
              {t("workspace.tabs.actions.newTerminal")}
            </DropdownMenuItem>
            {showCreateBrowser ? (
              <DropdownMenuItem
                testID="new-workspace-new-tab-menu-browser"
                onSelect={onCreateBrowser}
              >
                {t("workspace.tabs.actions.newBrowser")}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  tabsContainer: {
    height: WORKSPACE_SECONDARY_HEADER_HEIGHT,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
  },
  tabsScroll: {
    minWidth: 0,
    flex: 1,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "stretch",
  },
  tabsActions: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[2],
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRightWidth: 1,
    borderRightColor: theme.colors.border,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    userSelect: "none",
  },
  tabActive: {
    backgroundColor: theme.colors.surface1,
  },
  tabFocusIndicator: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: 2,
    backgroundColor: theme.colors.accent,
  },
  tabIcon: {
    flexShrink: 0,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
    userSelect: "none",
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabCloseButton: {
    width: 18,
    height: 18,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  newTabActionButton: {
    width: 22,
    height: 22,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineAddActionButton: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  inlineAddButton: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
