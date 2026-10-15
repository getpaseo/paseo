import { memo, useCallback, useMemo, useRef, useState } from "react";
import { Keyboard, Pressable, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { SquarePen, SquareTerminal } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { Button } from "@/components/ui/button";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { useIconButtonChromeStyle } from "@/components/ui/icon-button-chrome";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabOptionRow,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import { MobileTabTrailingAccessory } from "@/screens/workspace/workspace-tab-trailing-accessory";
import {
  buildWorkspaceTabMenuEntries,
  type WorkspaceTabMenuLabels,
} from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

// The trigger draws at 32pt beside its island neighbours, so only vertical slop is free.
const TAB_SWITCHER_TRIGGER_HIT_SLOP = { top: 8, bottom: 8 } as const;

function getFallbackTabOptionLabel(
  tab: WorkspaceTabDescriptor,
  labels: {
    newTab: string;
    newAgent: string;
    setup: string;
    terminal: string;
    browser: string;
    agent: string;
    changes: string;
    files: string;
    pullRequest: string;
  },
): string {
  if (tab.target.kind === "new_tab") {
    return labels.newTab;
  }
  if (tab.target.kind === "draft") {
    return labels.newAgent;
  }
  if (tab.target.kind === "setup") {
    return labels.setup;
  }
  if (tab.target.kind === "terminal") {
    return labels.terminal;
  }
  if (tab.target.kind === "browser") {
    return labels.browser;
  }
  if (tab.target.kind === "file") {
    return tab.target.path.split("/").findLast(Boolean) ?? tab.target.path;
  }
  if (tab.target.kind === "working_diff" || tab.target.kind === "changes_tree") {
    return labels.changes;
  }
  if (tab.target.kind === "files") {
    return labels.files;
  }
  if (tab.target.kind === "pull_request") {
    return labels.pullRequest;
  }
  if (tab.target.kind === "commit_diff") {
    return tab.target.sha.slice(0, 7);
  }
  return labels.agent;
}

function getFallbackTabOptionDescription(
  tab: WorkspaceTabDescriptor,
  labels: {
    newTab: string;
    newAgent: string;
    workspaceSetup: string;
    agent: string;
    terminal: string;
    browser: string;
    changes: string;
    files: string;
    pullRequest: string;
  },
): string {
  if (tab.target.kind === "new_tab") {
    return labels.newTab;
  }
  if (tab.target.kind === "draft") {
    return labels.newAgent;
  }
  if (tab.target.kind === "setup") {
    return labels.workspaceSetup;
  }
  if (tab.target.kind === "agent") {
    return labels.agent;
  }
  if (tab.target.kind === "terminal") {
    return labels.terminal;
  }
  if (tab.target.kind === "browser") {
    return labels.browser;
  }
  if (tab.target.kind === "provider_subagent") {
    return labels.agent;
  }
  if (tab.target.kind === "commit_diff") {
    return tab.target.sha.slice(0, 7);
  }
  if (tab.target.kind === "working_diff" || tab.target.kind === "changes_tree") {
    return labels.changes;
  }
  if (tab.target.kind === "files") {
    return labels.files;
  }
  if (tab.target.kind === "pull_request") {
    return labels.pullRequest;
  }
  if (tab.target.kind === "plugin") {
    return tab.target.panelId;
  }
  return tab.target.path;
}

interface MobileWorkspaceTabSwitcherProps {
  tabs: WorkspaceTabDescriptor[];
  activeTabKey: string;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  onSelectSwitcherTab: (key: string) => void;
  createTerminalDisabled: boolean;
  onCreateDraftTab: () => void;
  onCreateTerminal: () => void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCloseTabsAbove: (tabId: string) => Promise<void> | void;
  onCloseTabsBelow: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
}

function MobileWorkspaceTabOption({
  tab,
  tabIndex,
  tabCount,
  normalizedServerId,
  normalizedWorkspaceId,
  selected,
  active,
  onPress,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTab,
  onCloseTabsAbove,
  onCloseTabsBelow,
  onCloseOtherTabs,
}: {
  tab: WorkspaceTabDescriptor;
  tabIndex: number;
  tabCount: number;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  selected: boolean;
  active: boolean;
  onPress: () => void;
  onCopyResumeCommand: (agentId: string) => Promise<void> | void;
  onCopyAgentId: (agentId: string) => Promise<void> | void;
  onCopyTerminalId: (terminalId: string) => Promise<void> | void;
  onCopyFilePath: (path: string) => Promise<void> | void;
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onRenameTab: (tab: WorkspaceTabDescriptor) => void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCloseTabsAbove: (tabId: string) => Promise<void> | void;
  onCloseTabsBelow: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
}) {
  const { t } = useTranslation();
  const tabMenuLabels = useMemo<WorkspaceTabMenuLabels>(
    () => ({
      copyResumeCommand: t("workspace.tabs.menu.copyResumeCommand"),
      copyAgentId: t("workspace.tabs.menu.copyAgentId"),
      copyTerminalId: t("workspace.tabs.menu.copyTerminalId"),
      copyFilePath: t("workspace.tabs.menu.copyFilePath"),
      rename: t("workspace.tabs.menu.rename"),
      closeAbove: t("workspace.tabs.menu.closeAbove"),
      closeBelow: t("workspace.tabs.menu.closeBelow"),
      closeLeft: t("workspace.tabs.menu.closeLeft"),
      closeRight: t("workspace.tabs.menu.closeRight"),
      closeOthers: t("workspace.tabs.menu.closeOthers"),
      reloadAgent: t("workspace.tabs.menu.reloadAgent"),
      reloadAgentTooltip: t("workspace.tabs.menu.reloadAgentTooltip"),
      close: t("workspace.tabs.menu.close"),
    }),
    [t],
  );
  const menuTestIDBase = `workspace-tab-menu-${tab.tabId}`;
  const menuEntries = buildWorkspaceTabMenuEntries({
    surface: "mobile",
    tab,
    index: tabIndex,
    tabCount,
    menuTestIDBase,
    onCopyResumeCommand,
    onCopyAgentId,
    onCopyTerminalId,
    onCopyFilePath,
    onReloadAgent,
    onRenameTab,
    onCloseTab,
    onCloseTabsBefore: onCloseTabsAbove,
    onCloseTabsAfter: onCloseTabsBelow,
    onCloseOtherTabs,
    labels: tabMenuLabels,
  });

  const fallbackLabels = useMemo(
    () => ({
      newTab: t("workspace.tabs.actions.newTab"),
      newAgent: t("workspace.tabs.fallback.newAgent"),
      setup: t("workspace.tabs.fallback.setup"),
      terminal: t("workspace.tabs.fallback.terminal"),
      browser: t("workspace.tabs.fallback.browser"),
      agent: t("workspace.tabs.fallback.agent"),
      changes: t("panels.diff.changesLabel"),
      files: t("panels.files.label"),
      pullRequest: t("panels.pullRequest.label"),
    }),
    [t],
  );
  const fallbackLabel = getFallbackTabOptionLabel(tab, fallbackLabels);
  const trailingAccessory = useMemo(
    () => (
      <MobileTabTrailingAccessory
        menuTestIDBase={menuTestIDBase}
        presentationLabel={fallbackLabel}
        menuEntries={menuEntries}
      />
    ),
    [menuTestIDBase, fallbackLabel, menuEntries],
  );

  const renderPresentation = useCallback(
    (presentation: WorkspaceTabPresentation) => (
      <WorkspaceTabOptionRow
        presentation={presentation}
        selected={selected}
        active={active}
        onPress={onPress}
        trailingAccessory={trailingAccessory}
      />
    ),
    [selected, active, onPress, trailingAccessory],
  );

  return (
    <WorkspaceTabPresentationResolver
      tab={tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {renderPresentation}
    </WorkspaceTabPresentationResolver>
  );
}

export const MobileWorkspaceTabSwitcher = memo(function MobileWorkspaceTabSwitcher({
  tabs,
  activeTabKey,
  normalizedServerId,
  normalizedWorkspaceId,
  onSelectSwitcherTab,
  createTerminalDisabled,
  onCreateDraftTab,
  onCreateTerminal,
  onCopyResumeCommand,
  onCopyAgentId,
  onCopyTerminalId,
  onCopyFilePath,
  onReloadAgent,
  onRenameTab,
  onCloseTab,
  onCloseTabsAbove,
  onCloseTabsBelow,
  onCloseOtherTabs,
}: MobileWorkspaceTabSwitcherProps) {
  const { t } = useTranslation();
  const tabFallbackLabels = useMemo(
    () => ({
      newTab: t("workspace.tabs.actions.newTab"),
      newAgent: t("workspace.tabs.fallback.newAgent"),
      setup: t("workspace.tabs.fallback.setup"),
      workspaceSetup: t("workspace.tabs.fallback.workspaceSetup"),
      terminal: t("workspace.tabs.fallback.terminal"),
      browser: t("workspace.tabs.fallback.browser"),
      agent: t("workspace.tabs.fallback.agent"),
      changes: t("panels.diff.changesLabel"),
      files: t("panels.files.label"),
      pullRequest: t("panels.pullRequest.label"),
    }),
    [t],
  );

  const tabSwitcherOptions = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.key,
        label: getFallbackTabOptionLabel(tab, tabFallbackLabels),
        description: getFallbackTabOptionDescription(tab, tabFallbackLabels),
      })),
    [tabFallbackLabels, tabs],
  );

  const tabByKey = useMemo(() => new Map(tabs.map((tab) => [tab.key, tab])), [tabs]);
  const triggerStyle = useIconButtonChromeStyle({ size: "large" });
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);
  const tabIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    tabs.forEach((tab, index) => {
      map.set(tab.key, index);
    });
    return map;
  }, [tabs]);

  const handleOpenSwitcher = useCallback(() => {
    Keyboard.dismiss();
    setIsOpen(true);
  }, []);

  const handleNewAgent = useCallback(() => {
    setIsOpen(false);
    onCreateDraftTab();
  }, [onCreateDraftTab]);

  const handleNewTerminal = useCallback(() => {
    setIsOpen(false);
    onCreateTerminal();
  }, [onCreateTerminal]);

  const footer = useMemo(
    () => (
      <View style={styles.tabSwitcherFooter}>
        <Button
          testID="workspace-tab-switcher-new-agent"
          style={styles.tabSwitcherFooterButton}
          variant="secondary"
          leftIcon={SquarePen}
          onPress={handleNewAgent}
        >
          {t("workspace.header.actions.newAgent")}
        </Button>
        <Button
          testID="workspace-tab-switcher-new-terminal"
          style={styles.tabSwitcherFooterButton}
          variant="secondary"
          leftIcon={SquareTerminal}
          disabled={createTerminalDisabled}
          onPress={handleNewTerminal}
        >
          {t("workspace.header.actions.newTerminal")}
        </Button>
      </View>
    ),
    [createTerminalDisabled, handleNewAgent, handleNewTerminal, t],
  );

  const renderTabOption = useCallback(
    ({
      option,
      selected,
      active,
      onPress,
    }: {
      option: ComboboxOption;
      selected: boolean;
      active: boolean;
      onPress: () => void;
    }) => {
      const tab = tabByKey.get(option.id);
      if (!tab) {
        return <View />;
      }
      const tabIndex = tabIndexByKey.get(tab.key) ?? -1;
      if (tabIndex < 0) {
        return <View />;
      }
      return (
        <MobileWorkspaceTabOption
          tab={tab}
          tabIndex={tabIndex}
          tabCount={tabs.length}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          selected={selected}
          active={active}
          onPress={onPress}
          onCopyResumeCommand={onCopyResumeCommand}
          onCopyAgentId={onCopyAgentId}
          onCopyTerminalId={onCopyTerminalId}
          onCopyFilePath={onCopyFilePath}
          onReloadAgent={onReloadAgent}
          onRenameTab={onRenameTab}
          onCloseTab={onCloseTab}
          onCloseTabsAbove={onCloseTabsAbove}
          onCloseTabsBelow={onCloseTabsBelow}
          onCloseOtherTabs={onCloseOtherTabs}
        />
      );
    },
    [
      tabByKey,
      tabIndexByKey,
      tabs.length,
      normalizedServerId,
      normalizedWorkspaceId,
      onCopyResumeCommand,
      onCopyAgentId,
      onCopyTerminalId,
      onCopyFilePath,
      onReloadAgent,
      onRenameTab,
      onCloseTab,
      onCloseTabsAbove,
      onCloseTabsBelow,
      onCloseOtherTabs,
    ],
  );

  return (
    <>
      <Pressable
        ref={anchorRef}
        testID="workspace-tab-switcher-trigger"
        accessibilityRole="button"
        accessibilityLabel={t("workspace.tabs.switcher.trigger", { count: tabs.length })}
        hitSlop={TAB_SWITCHER_TRIGGER_HIT_SLOP}
        style={triggerStyle}
        onPress={handleOpenSwitcher}
      >
        <View style={styles.tabCountBadge}>
          <Text style={styles.tabCountText}>{tabs.length}</Text>
        </View>
      </Pressable>

      <Combobox
        options={tabSwitcherOptions}
        value={activeTabKey}
        onSelect={onSelectSwitcherTab}
        searchable={false}
        title={t("workspace.tabs.switcher.title")}
        searchPlaceholder={t("workspace.tabs.switcher.searchPlaceholder")}
        open={isOpen}
        onOpenChange={setIsOpen}
        anchorRef={anchorRef}
        renderOption={renderTabOption}
        footer={footer}
      />
    </>
  );
});

const styles = StyleSheet.create((theme) => ({
  tabSwitcherFooter: {
    flexDirection: "row",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
    paddingVertical: theme.spacing[3],
  },
  tabSwitcherFooterButton: {
    flex: 1,
  },
  // Sized and stroked like the 16px header glyphs beside it (1.5 stroke on a 24 viewbox = 1px).
  tabCountBadge: {
    minWidth: 16,
    height: 16,
    paddingHorizontal: 2,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.borderRadius.sm,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.foregroundMuted,
  },
  // Android pads text above the ascender by default, which pushes the digit below center.
  tabCountText: {
    fontSize: 10,
    lineHeight: 12,
    includeFontPadding: false,
    textAlign: "center",
    textAlignVertical: "center",
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foregroundMuted,
    fontVariant: ["tabular-nums"],
  },
}));
