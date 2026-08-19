import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { getOpenAgentTabLabel } from "@getpaseo/protocol/agent-labels";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ComponentProps,
  type ReactNode,
} from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useIsFocused } from "@react-navigation/native";
import { BackHandler, Keyboard, Pressable, Text, View } from "react-native";
import { useQueryClient } from "@tanstack/react-query";
import { useRouter, type Href } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useTranslation } from "react-i18next";
import { ChevronDown, PanelRight } from "lucide-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { Theme } from "@/styles/theme";
import invariant from "tiny-invariant";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { buttonControlHeight } from "@/components/ui/control-geometry";
import { ScreenHeader } from "@/components/headers/screen-header";
import { ScreenTitle } from "@/components/headers/screen-title";
import { HostBadge } from "@/hosts/host-badge";
import { useHostBadges } from "@/hosts/use-host-badges";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import type { ShortcutKey } from "@/utils/format-shortcut";
import {
  FloatingPanelPortalHost,
  FloatingPanelPortalHostNameProvider,
} from "@/components/ui/floating-panel-portal";
import { ExplorerSidebar } from "@/components/explorer-sidebar";
import { SplitContainer } from "@/components/split-container";
import { RetainedPanel } from "@/components/retained-panel";
import { WindowChromeRegion } from "@/utils/desktop-window";
import { WorkspaceActions } from "@/git/workspace-actions";
import { WorkspaceOpenInEditorButton } from "@/screens/workspace/workspace-open-in-editor-button";
import { WorkspaceScriptsButton } from "@/screens/workspace/workspace-scripts-button";
import { ImportSessionSheet } from "@/components/import-session-sheet";
import { useToast } from "@/contexts/toast-context";
import { getOrCreateClientId } from "@/utils/client-id";
import { selectIsFileExplorerOpen, usePanelStore } from "@/stores/panel-store";
import { type ExplorerCheckoutContext } from "@/stores/explorer-checkout-context";
import { traceInstant } from "@/performance/native-trace";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import {
  collectAllTabs,
  createWorkspaceLayoutWithExplorer,
  findPaneById,
  getFocusedBrowserId,
  resolveExplorerPaneId,
  type WorkspaceLayout,
  type WorkspaceTabOpenOptions,
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import {
  buildWorkspaceTabPersistenceKey,
  type WorkspaceTab,
  type WorkspaceTabTarget,
} from "@/workspace-tabs/model";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { buildWorkspaceKeyboardHandlerId } from "@/keyboard/handler-id";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import {
  buildDeterministicWorkspaceTabId,
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/workspace-tabs/identity";
import { selectVisibleAgentIds } from "./visible-agent-ids";
import {
  getHostRuntimeStore,
  useHostRuntimeClient,
  useHostRuntimeIsConnected,
  useHostRuntimeSnapshot,
  useHosts,
} from "@/runtime/host-runtime";
import { prefetchProvidersSnapshot } from "@/hooks/use-providers-snapshot";
import { shouldShowWorkspaceSetup, useWorkspaceSetupStore } from "@/stores/workspace-setup-store";
import { useWorkspace } from "@/stores/session-store-hooks";
import { useWorkspaceTerminalSessionRetention } from "@/terminal/hooks/use-workspace-terminal-session-retention";
import type { CheckoutStatusPayload } from "@/git/use-status-query";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useStableEvent } from "@/hooks/use-stable-event";
import { removeResidentBrowserWebview } from "@/desktop/browser/resident-webviews";
import { createWorkspaceBrowser, useBrowserStore } from "@/desktop/browser/store";
import { getDesktopHost } from "@/desktop/host";
import { buildProviderCommand } from "@/utils/provider-command-templates";
import { generateDraftId } from "@/stores/draft-keys";
import { resolveWorkspaceRouteId } from "@/utils/workspace-identity";
import { useOpenAgentTabLabels } from "@/subagents/use-open-agent-tab-labels";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
  WorkspaceTabOptionRow,
  type WorkspaceTabPresentation,
} from "@/screens/workspace/workspace-tab-presentation";
import {
  useWorkspaceTabRename,
  WorkspaceTabRenameModal,
} from "@/screens/workspace/use-workspace-tab-rename";
import { MobileTabTrailingAccessory } from "@/screens/workspace/workspace-tab-trailing-accessory";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import {
  buildWorkspaceTabMenuEntries,
  type WorkspaceTabMenuLabels,
} from "@/screens/workspace/workspace-tab-menu";
import { useDesktopBrowserNewTabRequests } from "@/desktop/browser/new-tab-requests";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  resolveWorkspaceHeaderRenderState,
  type WorkspaceHeaderCheckoutState,
} from "@/screens/workspace/workspace-header-source";
import {
  resolveWorkspaceRouteState,
  type WorkspaceRouteState,
} from "@/screens/workspace/workspace-route-state";
import { renderWorkspaceRouteGate } from "@/screens/workspace/workspace-route-state-views";
import { useWorkspaceRecovery } from "@/workspace-recovery/use-workspace-recovery";
import type { WorkspaceRecoveryModel } from "@/workspace-recovery/model";
import {
  buildWorkspaceTabSnapshot,
  deriveWorkspaceAgentVisibility,
  workspaceAgentVisibilityEqual,
} from "@/workspace-tabs/agent-visibility";
import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import { WorkspaceFocusProvider } from "@/workspace/focus";
import { shouldSeedEmptyWorkspaceDraft } from "@/screens/workspace/workspace-empty-draft-seed";
import {
  buildBulkCloseConfirmationMessage,
  type BulkCloseConfirmationLabels,
  classifyBulkClosableTabs,
  closeBulkWorkspaceTabs,
} from "@/screens/workspace/workspace-bulk-close";
import { resolveCloseAgentTabPolicy } from "@/subagents";
import {
  getPanelInstanceAttributes,
  useModifiedPanelTabIds,
} from "@/panels/panel-instance-attributes";
import { findAdjacentPane } from "@/utils/split-navigation";
import { supportsDesktopPaneSplits, useIsCompactFormFactor } from "@/constants/layout";
import { getIsElectron, isNative, isWeb } from "@/constants/platform";
import type { SurfaceBackdrop } from "@/styles/surface-backdrop";
import { buildHostRootRoute, buildSettingsHostRoute } from "@/utils/host-routes";
import { useWorkspaceTerminals } from "@/screens/workspace/terminals/use-workspace-terminals";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  WorkspaceHeaderMenuDesktop,
  WorkspaceHeaderMenuMobile,
} from "@/screens/workspace/workspace-header-menu";
import {
  createWorkspaceFileTabTarget,
  normalizeWorkspaceFileLocation,
  type WorkspaceFileLocation,
  type WorkspaceFileOpenRequest,
} from "@/workspace/file-open";
import { RenderProfile } from "@/utils/render-profiler";
import { useWorkspaceCheckoutStatus } from "@/screens/workspace/use-workspace-checkout-status";
import { usePullRequestAutoAdd } from "@/panels/pull-request";

const WORKSPACE_SETUP_AUTO_OPEN_WINDOW_MS = 30_000;
const WORKSPACE_FLOATING_PANEL_PORTAL_HOST_PREFIX = "workspace-floating-panels";
const EMPTY_UI_TABS: WorkspaceTab[] = [];
const EMPTY_WORKSPACE_SCRIPTS: WorkspaceDescriptor["scripts"] = [];
const EMPTY_PINNED_AGENT_IDS = new Set<string>();
const EMPTY_SET = new Set<string>();

function getWorkspaceScripts(
  workspaceDescriptor: WorkspaceDescriptor | null | undefined,
): WorkspaceDescriptor["scripts"] {
  return workspaceDescriptor?.scripts ?? EMPTY_WORKSPACE_SCRIPTS;
}

interface WorkspaceFileLocationFields {
  path: string | null;
  lineStart?: number;
  lineEnd?: number;
}

function getWorkspaceFileLocationFields(
  tab: WorkspaceTabDescriptor | null,
): WorkspaceFileLocationFields {
  const target = tab?.target;
  if (target?.kind !== "file") {
    return { path: null };
  }
  return { path: target.path, lineStart: target.lineStart, lineEnd: target.lineEnd };
}

function buildWorkspaceFileLocation(
  fields: WorkspaceFileLocationFields,
): WorkspaceFileLocation | null {
  if (fields.path === null) {
    return null;
  }
  return { path: fields.path, lineStart: fields.lineStart, lineEnd: fields.lineEnd };
}

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const ThemedChevronDown = withUnistyles(ChevronDown);
const ThemedPanelRight = withUnistyles(PanelRight);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const extraMutedColorMapping = (theme: Theme) => ({
  color: theme.colors.foregroundExtraMuted,
});

const GATED_WORKSPACE_HEADER_LEFT = <SidebarMenuToggle />;

interface WorkspaceScreenProps {
  serverId: string;
  workspaceId: string;
  isRouteFocused?: boolean;
  recoveryRequested?: boolean;
  recoveryAgentId?: string | null;
}

type WorkspaceScreenContentProps = WorkspaceScreenProps & {
  isRouteFocused: boolean;
  recoveryRequested: boolean;
  recoveryAgentId: string | null;
};

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function decodeSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function useSyncWorkspaceActiveBrowser(input: {
  workspaceLayout: WorkspaceLayout | null;
  isRouteFocused: boolean;
  workspaceId: string;
}) {
  const focusedBrowserId = useMemo(
    () => getFocusedBrowserId(input.workspaceLayout),
    [input.workspaceLayout],
  );

  useEffect(() => {
    if (!getIsElectron()) {
      return;
    }
    void getDesktopHost()?.browser?.setWorkspaceActiveBrowser?.({
      workspaceId: input.workspaceId,
      browserId: focusedBrowserId,
    });
  }, [focusedBrowserId, input.workspaceId]);
}

function getFallbackTabOptionLabel(
  tab: WorkspaceTabDescriptor,
  labels: {
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
  if (tab.target.kind === "working_diff") {
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
  if (tab.target.kind === "working_diff") {
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
  activeTab: WorkspaceTabDescriptor | null;
  tabSwitcherOptions: ComboboxOption[];
  tabByKey: Map<string, WorkspaceTabDescriptor>;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  onSelectSwitcherTab: (key: string) => void;
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

function MobileActiveTabTrigger({
  activeTab,
  normalizedServerId,
  normalizedWorkspaceId,
  backdrop,
}: {
  activeTab: WorkspaceTabDescriptor | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  backdrop: SurfaceBackdrop;
}) {
  if (!activeTab) {
    return null;
  }

  return (
    <ResolvedMobileActiveTabTrigger
      activeTab={activeTab}
      normalizedServerId={normalizedServerId}
      normalizedWorkspaceId={normalizedWorkspaceId}
      backdrop={backdrop}
    />
  );
}

function ResolvedMobileActiveTabTrigger({
  activeTab,
  normalizedServerId,
  normalizedWorkspaceId,
  backdrop,
}: {
  activeTab: WorkspaceTabDescriptor;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  backdrop: SurfaceBackdrop;
}) {
  const { t } = useTranslation();
  return (
    <WorkspaceTabPresentationResolver
      tab={activeTab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => (
        <>
          <View style={styles.switcherTriggerIcon} testID="workspace-active-tab-icon">
            <WorkspaceTabIcon presentation={presentation} active backdrop={backdrop} />
          </View>

          <Text style={styles.switcherTriggerText} numberOfLines={1}>
            {presentation.titleState === "loading"
              ? t("workspace.tabs.loading")
              : presentation.label}
          </Text>
        </>
      )}
    </WorkspaceTabPresentationResolver>
  );
}

function WorkspaceDocumentTitleEffect({
  label,
  titleState,
}: {
  label: string;
  titleState: "ready" | "loading";
}) {
  const { t } = useTranslation();
  useEffect(() => {
    if (isNative || typeof document === "undefined") {
      return;
    }
    const resolvedLabel = label.trim();
    document.title =
      titleState === "loading"
        ? t("workspace.tabs.loading")
        : resolvedLabel || t("workspace.tabs.fallback.workspace");
  }, [label, titleState, t]);

  return null;
}

function switcherTriggerStyle({ pressed }: { pressed?: boolean }) {
  return [styles.switcherTrigger, Boolean(pressed) && styles.switcherTriggerPressed];
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
  const menuTestIDBase = `workspace-tab-menu-${buildDeterministicWorkspaceTabId(tab.target)}`;
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

const MobileWorkspaceTabSwitcher = memo(function MobileWorkspaceTabSwitcher({
  tabs,
  activeTabKey,
  activeTab,
  tabSwitcherOptions,
  tabByKey,
  normalizedServerId,
  normalizedWorkspaceId,
  onSelectSwitcherTab,
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
    <View style={styles.mobileTabsRow} testID="workspace-tabs-row">
      <Pressable
        ref={anchorRef}
        testID="workspace-tab-switcher-trigger"
        accessibilityRole="button"
        accessibilityLabel={t("workspace.tabs.switcher.trigger", { count: tabs.length })}
        style={switcherTriggerStyle}
        onPress={handleOpenSwitcher}
      >
        {({ pressed }) => (
          <>
            <View style={styles.switcherTriggerLeft}>
              <MobileActiveTabTrigger
                activeTab={activeTab}
                normalizedServerId={normalizedServerId}
                normalizedWorkspaceId={normalizedWorkspaceId}
                backdrop={pressed ? "surface1" : "surface0"}
              />
            </View>
            <ThemedChevronDown size={14} uniProps={mutedColorMapping} />
          </>
        )}
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
      />
    </View>
  );
});

interface MobileMountedTabSlotProps {
  tabDescriptor: WorkspaceTabDescriptor;
  isVisible: boolean;
  isWorkspaceFocused: boolean;
  isPaneFocused: boolean;
  paneId: string | null;
  buildPaneContentModel: (input: {
    paneId: string | null;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
}

const MobileMountedTabSlot = memo(function MobileMountedTabSlot({
  tabDescriptor,
  isVisible,
  isWorkspaceFocused,
  isPaneFocused,
  paneId,
  buildPaneContentModel,
}: MobileMountedTabSlotProps) {
  const content = useMemo(
    () =>
      buildPaneContentModel({
        paneId,
        tab: tabDescriptor,
      }),
    [buildPaneContentModel, paneId, tabDescriptor],
  );

  return (
    <RenderProfile id={`MobileMountedTabSlot:${tabDescriptor.kind}:${tabDescriptor.tabId}`}>
      <RetainedPanel active={isVisible} style={styles.mobileMountedTabSlot}>
        <WorkspacePaneContent
          content={content}
          isWorkspaceFocused={isWorkspaceFocused}
          isPaneFocused={isPaneFocused}
        />
      </RetainedPanel>
    </RenderProfile>
  );
});

function useStableTabDescriptorMap(tabDescriptors: WorkspaceTabDescriptor[]) {
  const cacheRef = useRef(new Map<string, WorkspaceTabDescriptor>());
  const tabDescriptorMap = useMemo(() => {
    const next = new Map<string, WorkspaceTabDescriptor>();
    for (const tabDescriptor of tabDescriptors) {
      const cachedDescriptor = cacheRef.current.get(tabDescriptor.tabId);
      if (
        cachedDescriptor &&
        cachedDescriptor.key === tabDescriptor.key &&
        cachedDescriptor.kind === tabDescriptor.kind &&
        workspaceTabTargetsEqual(cachedDescriptor.target, tabDescriptor.target)
      ) {
        next.set(tabDescriptor.tabId, cachedDescriptor);
        continue;
      }
      next.set(tabDescriptor.tabId, tabDescriptor);
    }
    return next;
  }, [tabDescriptors]);
  useEffect(() => {
    cacheRef.current = tabDescriptorMap;
  }, [tabDescriptorMap]);

  return tabDescriptorMap;
}

export const WorkspaceScreen = memo(function WorkspaceScreen({
  serverId,
  workspaceId,
  isRouteFocused,
  recoveryRequested,
  recoveryAgentId,
}: WorkspaceScreenProps) {
  const navigationFocused = useIsFocused();
  useEffect(() => {
    traceInstant("paseo.workspace.mount", { serverId, workspaceId });
    return () => {
      traceInstant("paseo.workspace.unmount", { serverId, workspaceId });
    };
  }, [serverId, workspaceId]);
  return (
    <WorkspaceScreenContent
      serverId={serverId}
      workspaceId={workspaceId}
      isRouteFocused={isRouteFocused ?? navigationFocused}
      recoveryRequested={recoveryRequested ?? false}
      recoveryAgentId={recoveryAgentId ?? null}
    />
  );
});

interface UseCloseTabsResult {
  closingTabIds: Set<string>;
  closeTab: (tabId: string, action: () => Promise<void>) => Promise<void>;
}

function useCloseTabs(): UseCloseTabsResult {
  const pendingRef = useRef(new Set<string>());
  const [closingTabIds, setClosingTabIds] = useState<Set<string>>(EMPTY_SET);

  const closeTab = useCallback(async (tabId: string, action: () => Promise<void>) => {
    const normalized = tabId.trim();
    if (!normalized || pendingRef.current.has(normalized)) {
      return;
    }
    pendingRef.current.add(normalized);
    setClosingTabIds(new Set(pendingRef.current));
    try {
      await action();
    } finally {
      pendingRef.current.delete(normalized);
      setClosingTabIds(new Set(pendingRef.current));
    }
  }, []);

  return { closingTabIds, closeTab };
}

/**
 * Which project the workspace belongs to, and which machine it runs on.
 *
 * Compact gets both, on their own line under the workspace name: this header is the only thing on
 * screen that says where the workspace lives, because the sidebar that normally carries the host
 * badge is closed. It still follows the host's own badge setting, so a purely local setup stays
 * quiet. A project name that only repeats the workspace name is dropped on wide, where the two sit
 * side by side, and kept on compact, where the line exists for the host anyway.
 */
function WorkspaceHeaderProjectRow({
  subtitle,
  isSubtitleDistinct,
  serverId,
}: {
  subtitle: string;
  isSubtitleDistinct: boolean;
  serverId: string;
}) {
  const isCompact = useIsCompactFormFactor();
  const hostBadge = useHostBadges({ enabled: isCompact }).get(serverId) ?? null;
  const showProject = isSubtitleDistinct || isCompact;
  if (!showProject && !hostBadge) {
    return null;
  }
  return (
    <View style={styles.headerProjectRow}>
      {showProject ? (
        <Text
          testID="workspace-header-subtitle"
          style={styles.headerProjectTitle}
          numberOfLines={1}
        >
          {subtitle}
        </Text>
      ) : null}
      {showProject && hostBadge ? <Text style={styles.headerProjectSeparator}>·</Text> : null}
      {hostBadge ? <HostBadge badge={hostBadge} /> : null}
    </View>
  );
}

interface WorkspaceHeaderTitleBarProps {
  isLoading: boolean;
  title: string;
  subtitle: string;
  isSubtitleDistinct: boolean;
  currentBranchName: string | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
  workspaceScripts: WorkspaceDescriptor["scripts"];
  liveTerminalIds: string[];
  showWorkspaceSetup: boolean;
  showCreateBrowserTab: boolean;
  isMobile: boolean;
  createTerminalDisabled: boolean;
  importAgentDisabled: boolean;
  copyPathDisabled: boolean;
  onCreateDraftTab: () => void;
  onCreateTerminal: () => void;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
  onCreateBrowser: () => void;
  onOpenImportSheet: () => void;
  onCopyWorkspacePath: () => void;
  onCopyBranchName: () => void;
  onOpenSetupTab: () => void;
  onScriptTerminalStarted: (terminalId: string) => void;
  onViewScriptTerminal: (terminalId: string) => void;
  onOpenUrlInBrowserTab: (url: string) => void;
}

function WorkspaceHeaderTitleBar({
  isLoading,
  title,
  subtitle,
  isSubtitleDistinct,
  currentBranchName,
  normalizedServerId,
  normalizedWorkspaceId,
  workspaceScripts,
  liveTerminalIds,
  showWorkspaceSetup,
  showCreateBrowserTab,
  isMobile,
  createTerminalDisabled,
  importAgentDisabled,
  copyPathDisabled,
  onCreateDraftTab,
  onCreateTerminal,
  onCreateTerminalWithProfile,
  onCreateBrowser,
  onOpenImportSheet,
  onCopyWorkspacePath,
  onCopyBranchName,
  onOpenSetupTab,
  onScriptTerminalStarted,
  onViewScriptTerminal,
  onOpenUrlInBrowserTab,
}: WorkspaceHeaderTitleBarProps) {
  return (
    <View style={styles.headerTitleContainer}>
      {isLoading ? (
        <View style={styles.headerTitleTextGroup}>
          <View style={styles.headerTitleSkeleton} />
        </View>
      ) : (
        <View style={styles.headerTitleTextGroup}>
          <ScreenTitle testID="workspace-header-title">{title}</ScreenTitle>
          <WorkspaceHeaderProjectRow
            subtitle={subtitle}
            isSubtitleDistinct={isSubtitleDistinct}
            serverId={normalizedServerId}
          />
        </View>
      )}
      <View style={styles.compactHeaderMenuCluster}>
        {isMobile ? (
          <WorkspaceHeaderMenuMobile
            normalizedServerId={normalizedServerId}
            currentBranchName={currentBranchName}
            showWorkspaceSetup={showWorkspaceSetup}
            showCreateBrowserTab={showCreateBrowserTab}
            createTerminalDisabled={createTerminalDisabled}
            importAgentDisabled={importAgentDisabled}
            copyPathDisabled={copyPathDisabled}
            onCreateDraftTab={onCreateDraftTab}
            onCreateTerminal={onCreateTerminal}
            onCreateTerminalWithProfile={onCreateTerminalWithProfile}
            onCreateBrowser={onCreateBrowser}
            onOpenImportSheet={onOpenImportSheet}
            onCopyWorkspacePath={onCopyWorkspacePath}
            onCopyBranchName={onCopyBranchName}
            onOpenSetupTab={onOpenSetupTab}
          />
        ) : (
          <WorkspaceHeaderMenuDesktop
            currentBranchName={currentBranchName}
            showWorkspaceSetup={showWorkspaceSetup}
            importAgentDisabled={importAgentDisabled}
            copyPathDisabled={copyPathDisabled}
            onOpenImportSheet={onOpenImportSheet}
            onCopyWorkspacePath={onCopyWorkspacePath}
            onCopyBranchName={onCopyBranchName}
            onOpenSetupTab={onOpenSetupTab}
          />
        )}
        {isMobile && workspaceScripts.length > 0 ? (
          <WorkspaceScriptsButton
            serverId={normalizedServerId}
            workspaceId={normalizedWorkspaceId}
            scripts={workspaceScripts}
            liveTerminalIds={liveTerminalIds}
            onScriptTerminalStarted={onScriptTerminalStarted}
            onViewTerminal={onViewScriptTerminal}
            onOpenUrlInBrowserTab={onOpenUrlInBrowserTab}
            hideLabels
            presentation="ghost"
          />
        ) : null}
      </View>
    </View>
  );
}

type PaneDirection = "left" | "right" | "up" | "down";

function parsePaneDirection(actionId: string): PaneDirection | null {
  const direction = actionId.split(".").pop();
  if (direction === "left" || direction === "right" || direction === "up" || direction === "down") {
    return direction;
  }
  return null;
}

interface RenderWorkspaceContentInput {
  isMissingWorkspaceDirectory: boolean;
  activeTabDescriptor: WorkspaceTabDescriptor | null;
  hasHydratedAgents: boolean;
  mountedFocusedPaneTabIds: string[];
  focusedPaneTabDescriptorMap: Map<string, WorkspaceTabDescriptor>;
  isRouteFocused: boolean;
  focusedPaneId: string | null;
  buildMobilePaneContentModel: (input: {
    paneId: string | null;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
}

function renderWorkspaceContent(input: RenderWorkspaceContentInput): React.ReactNode {
  const {
    isMissingWorkspaceDirectory,
    activeTabDescriptor,
    hasHydratedAgents,
    mountedFocusedPaneTabIds,
    focusedPaneTabDescriptorMap,
    isRouteFocused,
    focusedPaneId,
    buildMobilePaneContentModel,
  } = input;

  if (isMissingWorkspaceDirectory) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyStateText}>
          Workspace directory is missing. Reload workspace data before opening tabs.
        </Text>
      </View>
    );
  }
  if (!activeTabDescriptor && !hasHydratedAgents) {
    return (
      <View style={styles.emptyState}>
        <ThemedLoadingSpinner uniProps={mutedColorMapping} />
      </View>
    );
  }
  if (!activeTabDescriptor) {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyStateText}>
          No tabs are available yet. Use New tab to create an agent or terminal.
        </Text>
      </View>
    );
  }
  return mountedFocusedPaneTabIds.map((tabId) => {
    const tabDescriptor = focusedPaneTabDescriptorMap.get(tabId);
    if (!tabDescriptor) {
      return null;
    }
    return (
      <MobileMountedTabSlot
        key={tabId}
        tabDescriptor={tabDescriptor}
        isVisible={isRouteFocused && tabId === activeTabDescriptor.tabId}
        isWorkspaceFocused={isRouteFocused}
        isPaneFocused={tabId === activeTabDescriptor.tabId}
        paneId={focusedPaneId}
        buildPaneContentModel={buildMobilePaneContentModel}
      />
    );
  });
}

interface WorkspaceHeaderFields {
  isWorkspaceHeaderLoading: boolean;
  workspaceHeaderTitle: string;
  workspaceHeaderSubtitle: string;
  isWorkspaceHeaderSubtitleDistinct: boolean;
  isGitCheckout: boolean;
  currentBranchName: string | null;
}

function buildWorkspaceHeaderCheckoutState(input: {
  isCheckoutStatusLoading: boolean;
  isError: boolean;
  data: CheckoutStatusPayload | undefined;
}): WorkspaceHeaderCheckoutState {
  if (input.isCheckoutStatusLoading) {
    return { kind: "pending" };
  }
  if (input.isError || !input.data) {
    return { kind: "error" };
  }
  return {
    kind: "ready",
    checkout: {
      isGit: input.data.isGit,
      currentBranch: input.data.currentBranch,
    },
  };
}

function deriveWorkspaceHeaderFields(input: {
  workspace: WorkspaceDescriptor | null;
  checkoutState: WorkspaceHeaderCheckoutState;
}): WorkspaceHeaderFields {
  const renderState = resolveWorkspaceHeaderRenderState(input);
  if (renderState.kind !== "ready") {
    return {
      isWorkspaceHeaderLoading: true,
      workspaceHeaderTitle: "",
      workspaceHeaderSubtitle: "",
      isWorkspaceHeaderSubtitleDistinct: false,
      isGitCheckout: false,
      currentBranchName: null,
    };
  }
  return {
    isWorkspaceHeaderLoading: false,
    workspaceHeaderTitle: renderState.title,
    workspaceHeaderSubtitle: renderState.subtitle,
    isWorkspaceHeaderSubtitleDistinct: renderState.isSubtitleDistinct,
    isGitCheckout: renderState.isGitCheckout,
    currentBranchName: renderState.currentBranchName,
  };
}

function getHostDisplayName(host: { label?: string | null } | null, fallback: string): string {
  const trimmed = host?.label?.trim();
  return trimmed ? trimmed : fallback;
}

function useWorkspaceRouteActions(normalizedServerId: string): {
  handleRetryHost: () => void;
  handleManageHost: () => void;
  handleDismissMissingWorkspace: () => void;
} {
  const router = useRouter();
  const handleRetryHost = useCallback(() => {
    if (!normalizedServerId) {
      return;
    }
    void getHostRuntimeStore().runProbeCycleNow(normalizedServerId);
  }, [normalizedServerId]);
  const handleManageHost = useCallback(() => {
    if (!normalizedServerId) {
      return;
    }
    router.push(buildSettingsHostRoute(normalizedServerId) as Href);
  }, [normalizedServerId, router]);
  const handleDismissMissingWorkspace = useCallback(() => {
    if (router.canGoBack()) {
      router.back();
      return;
    }
    if (normalizedServerId) {
      router.replace(buildHostRootRoute(normalizedServerId) as Href);
      return;
    }
    router.replace("/" as Href);
  }, [normalizedServerId, router]);

  return {
    handleRetryHost,
    handleManageHost,
    handleDismissMissingWorkspace,
  };
}

function useResolvedWorkspaceRouteState(input: {
  serverId: string;
  workspace: WorkspaceDescriptor | null;
  hasHydratedWorkspaces: boolean;
  recovery: WorkspaceRecoveryModel;
}): WorkspaceRouteState {
  const hosts = useHosts();
  const host = useMemo(
    () => hosts.find((entry) => entry.serverId === input.serverId) ?? null,
    [hosts, input.serverId],
  );
  const hostSnapshot = useHostRuntimeSnapshot(input.serverId);
  const hostName = useMemo(() => getHostDisplayName(host, input.serverId), [host, input.serverId]);
  return useMemo(
    () =>
      resolveWorkspaceRouteState({
        hostName,
        connectionStatus: hostSnapshot?.connectionStatus ?? "connecting",
        lastError: hostSnapshot?.lastError ?? null,
        workspace: input.workspace,
        hasHydratedWorkspaces: input.hasHydratedWorkspaces,
        recovery: input.recovery,
      }),
    [
      hostName,
      hostSnapshot?.connectionStatus,
      hostSnapshot?.lastError,
      input.workspace,
      input.hasHydratedWorkspaces,
      input.recovery,
    ],
  );
}

function shouldInspectWorkspaceRecovery(
  hasHydratedWorkspaces: boolean,
  workspace: WorkspaceDescriptor | null,
  recoveryRequested: boolean,
): boolean {
  return recoveryRequested && hasHydratedWorkspaces && workspace === null;
}

function WorkspaceScreenGateFrame({ children }: { children: ReactNode }) {
  return (
    <>
      <ScreenHeader left={GATED_WORKSPACE_HEADER_LEFT} />
      <View style={styles.centerContent}>{children}</View>
    </>
  );
}

function renderWorkspaceScreenGateShell(input: {
  gate: ReactNode;
  workspaceKey: string | null;
}): ReactElement | null {
  if (!input.gate) {
    return null;
  }

  return (
    <WorkspaceFocusProvider workspaceKey={input.workspaceKey}>
      <View style={styles.container}>
        <View style={styles.threePaneRow}>
          <View style={styles.centerColumn}>
            <WorkspaceScreenGateFrame>{input.gate}</WorkspaceScreenGateFrame>
          </View>
        </View>
      </View>
    </WorkspaceFocusProvider>
  );
}

function WorkspaceDocumentTitleEffectSlot({
  tab,
  serverId,
  workspaceId,
  isRouteFocused,
}: {
  tab: WorkspaceTabDescriptor | null;
  serverId: string;
  workspaceId: string;
  isRouteFocused: boolean;
}) {
  if (!isRouteFocused || !isWeb || !tab) {
    return null;
  }

  return (
    <WorkspaceTabPresentationResolver tab={tab} serverId={serverId} workspaceId={workspaceId}>
      {(presentation) => (
        <WorkspaceDocumentTitleEffect
          label={presentation.label}
          titleState={presentation.titleState}
        />
      )}
    </WorkspaceTabPresentationResolver>
  );
}

function shouldShowWorkspaceScreenHeader(input: {
  isFocusModeEnabled: boolean;
  isMobile: boolean;
}): boolean {
  return !input.isFocusModeEnabled || input.isMobile;
}

function shouldShowWorkspaceExplorerSidebar(input: {
  isRouteFocused: boolean;
  isFocusModeEnabled: boolean;
  isMobile: boolean;
}): boolean {
  return !input.isMobile && input.isRouteFocused && shouldShowWorkspaceScreenHeader(input);
}

interface WorkspaceChromeRowProps extends Omit<
  ComponentProps<typeof ExplorerSidebar>,
  "workspaceRoot"
> {
  children: ReactNode;
  explorerOpen: boolean;
  portalHostName: string;
  showExplorerSidebar: boolean;
  workspaceRoot: string | null;
}

function WorkspaceChromeRow({
  children,
  explorerOpen,
  portalHostName,
  showExplorerSidebar,
  workspaceRoot,
  ...explorerProps
}: WorkspaceChromeRowProps) {
  const explorerRendered = showExplorerSidebar && explorerOpen && workspaceRoot !== null;

  return (
    <View style={styles.threePaneRow}>
      <WindowChromeRegion corners={explorerRendered ? "top-left" : "both"}>
        <FloatingPanelPortalHostNameProvider hostName={portalHostName}>
          {children}
        </FloatingPanelPortalHostNameProvider>
      </WindowChromeRegion>

      <FloatingPanelPortalHost name={portalHostName} />

      {showExplorerSidebar && workspaceRoot ? (
        <WindowChromeRegion corners="top-right">
          <ExplorerSidebar {...explorerProps} workspaceRoot={workspaceRoot} />
        </WindowChromeRegion>
      ) : null}
    </View>
  );
}

function buildWorkspaceTerminalScopeKey(serverId: string, workspaceId: string): string | null {
  if (!serverId || !workspaceId) {
    return null;
  }
  return `${serverId}:${workspaceId}`;
}

function canObservePullRequest(
  isRouteFocused: boolean,
  isGitCheckout: boolean,
  isCompact: boolean,
): boolean {
  return isRouteFocused && isGitCheckout && !isCompact && supportsDesktopPaneSplits();
}

interface ToggleWorkspaceExplorerPaneInput {
  isCompact: boolean;
  persistenceKey: string | null;
  checkout: ExplorerCheckoutContext | null;
  toggleCompact: (input: { isCompact: boolean; checkout: ExplorerCheckoutContext }) => void;
}

function toggleWorkspaceExplorerPane(input: ToggleWorkspaceExplorerPaneInput): void {
  if (input.isCompact || !supportsDesktopPaneSplits()) {
    if (input.checkout) {
      input.toggleCompact({ isCompact: input.isCompact, checkout: input.checkout });
    }
    return;
  }
  if (!input.persistenceKey) {
    return;
  }

  const store = useWorkspaceLayoutStore.getState();
  const layout =
    store.layoutByWorkspace[input.persistenceKey] ?? createWorkspaceLayoutWithExplorer();
  const parentTabId = findPaneById(layout.root, layout.focusedPaneId)?.focusedTabId ?? null;
  const explorerPaneId = resolveExplorerPaneId(
    layout,
    store.explorerPaneIdByWorkspace[input.persistenceKey],
  );
  const explorerPane = findPaneById(layout.root, explorerPaneId);
  if (explorerPane) {
    if (explorerPane.hidden === true) {
      store.showPane(input.persistenceKey, explorerPane.id);
    } else {
      store.hidePane(input.persistenceKey, explorerPane.id);
      return;
    }
    // The companion pane can already hold an unrelated tab (the setup
    // progress tab auto-opens here) before the user ever toggles it, so
    // "empty" is the wrong signal for "needs a Changes tab seeded". Check
    // for the working_diff tab specifically.
    const layoutTabs = collectAllTabs(layout.root);
    const hasWorkingDiffTab = explorerPane.tabIds.some(
      (tabId) => layoutTabs.find((tab) => tab.tabId === tabId)?.target.kind === "working_diff",
    );
    if (!hasWorkingDiffTab) {
      const tabId = parentTabId
        ? store.openChildTabFocused(input.persistenceKey, { kind: "working_diff" }, parentTabId)
        : store.openTabFocused(input.persistenceKey, { kind: "working_diff" });
      if (tabId) {
        store.moveTabToPane(input.persistenceKey, tabId, explorerPane.id);
      }
    }
    return;
  }

  const ensuredPane = store.ensureExplorerPane(input.persistenceKey);
  if (!ensuredPane) {
    return;
  }
  const tabId = parentTabId
    ? store.openChildTabFocused(input.persistenceKey, { kind: "working_diff" }, parentTabId)
    : store.openTabFocused(input.persistenceKey, { kind: "working_diff" });
  if (tabId) {
    store.moveTabToPane(input.persistenceKey, tabId, ensuredPane.paneId);
  }
}

function isWorkspaceExplorerPaneOpen(
  state: ReturnType<typeof useWorkspaceLayoutStore.getState>,
  persistenceKey: string | null,
): boolean {
  if (!persistenceKey) {
    return false;
  }
  const layout = state.layoutByWorkspace[persistenceKey];
  const paneId = layout
    ? resolveExplorerPaneId(layout, state.explorerPaneIdByWorkspace[persistenceKey])
    : null;
  const pane = paneId && layout ? findPaneById(layout.root, paneId) : null;
  return Boolean(pane && pane.hidden !== true);
}

function resolveExplorerOpen(
  isCompact: boolean,
  compactExplorerOpen: boolean,
  desktopExplorerOpen: boolean,
): boolean {
  return isCompact ? compactExplorerOpen : desktopExplorerOpen;
}

interface WorkspaceTerminalTabActionsInput {
  persistenceKey: string | null;
  openWorkspaceTabFocused: (
    workspaceKey: string,
    target: WorkspaceTabTarget,
    options?: WorkspaceTabOpenOptions,
  ) => string | null;
  labels: {
    workspacePathUnavailable: string;
    terminalQueued: string;
  };
  toast: {
    error: (message: string) => void;
    show: (message: string) => void;
  };
}

interface WorkspaceTerminalTabActions {
  handleTerminalCreated: (input: { terminalId: string; paneId?: string }) => void;
  handleScriptTerminalSelected: (terminalId: string) => void;
  handleWorkspacePathUnavailable: () => void;
  handleTerminalCreateQueued: () => void;
  handleTerminalCreateFailed: (reason: string) => void;
}

function useWorkspaceTerminalTabActions({
  persistenceKey,
  openWorkspaceTabFocused,
  labels,
  toast,
}: WorkspaceTerminalTabActionsInput): WorkspaceTerminalTabActions {
  const handleTerminalCreated = useCallback(
    ({ terminalId, paneId }: { terminalId: string; paneId?: string }) => {
      if (!persistenceKey) {
        return;
      }
      openWorkspaceTabFocused(persistenceKey, { kind: "terminal", terminalId }, { paneId });
    },
    [openWorkspaceTabFocused, persistenceKey],
  );
  const handleScriptTerminalSelected = useCallback(
    (terminalId: string) => {
      if (!persistenceKey) {
        return;
      }
      openWorkspaceTabFocused(persistenceKey, { kind: "terminal", terminalId });
    },
    [openWorkspaceTabFocused, persistenceKey],
  );
  const handleWorkspacePathUnavailable = useCallback(() => {
    toast.error(labels.workspacePathUnavailable);
  }, [labels.workspacePathUnavailable, toast]);
  const handleTerminalCreateQueued = useCallback(() => {
    toast.show(labels.terminalQueued);
  }, [labels.terminalQueued, toast]);
  const handleTerminalCreateFailed = useCallback(
    (reason: string) => {
      toast.error(reason);
    },
    [toast],
  );

  return {
    handleTerminalCreated,
    handleScriptTerminalSelected,
    handleWorkspacePathUnavailable,
    handleTerminalCreateQueued,
    handleTerminalCreateFailed,
  };
}

function WorkspaceScreenContent({
  serverId,
  workspaceId,
  isRouteFocused,
  recoveryRequested,
  recoveryAgentId,
}: WorkspaceScreenContentProps) {
  const { t } = useTranslation();
  const _insets = useSafeAreaInsets();
  const toast = useToast();
  const isMobile = useIsCompactFormFactor();
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const toggleFocusMode = usePanelStore((state) => state.toggleFocusMode);

  const normalizedServerId = useMemo(() => trimNonEmpty(decodeSegment(serverId)) ?? "", [serverId]);

  const normalizedWorkspaceId = useMemo(
    () => resolveWorkspaceRouteId({ routeWorkspaceId: workspaceId }) ?? "",
    [workspaceId],
  );
  const workspaceDescriptor = useWorkspace(normalizedServerId, normalizedWorkspaceId);
  const workspaceScripts = getWorkspaceScripts(workspaceDescriptor);
  const { handleRetryHost, handleManageHost, handleDismissMissingWorkspace } =
    useWorkspaceRouteActions(normalizedServerId);

  const workspaceTerminalScopeKey = useMemo(
    () => buildWorkspaceTerminalScopeKey(normalizedServerId, normalizedWorkspaceId),
    [normalizedServerId, normalizedWorkspaceId],
  );
  useWorkspaceTerminalSessionRetention({
    scopeKey: workspaceTerminalScopeKey,
  });

  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);
  const supportsProvidersSnapshot = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.serverInfo?.features?.providersSnapshot === true,
  );
  const workspaceDirectory = workspaceDescriptor?.workspaceDirectory || null;
  const isMissingWorkspaceDirectory = Boolean(workspaceDescriptor) && !workspaceDirectory;
  const [isImportSheetVisible, setIsImportSheetVisible] = useState(false);
  const canOpenImportSheet = [client, isConnected, workspaceDirectory].every(Boolean);
  const openImportSheet = useCallback(() => {
    setIsImportSheetVisible(true);
  }, []);
  const closeImportSheet = useCallback(() => {
    setIsImportSheetVisible(false);
  }, []);

  useEffect(() => {
    if (
      !isRouteFocused ||
      !isConnected ||
      !client ||
      !workspaceDirectory ||
      !supportsProvidersSnapshot
    ) {
      return;
    }
    prefetchProvidersSnapshot(normalizedServerId, client, { cwd: workspaceDirectory });
  }, [
    client,
    isConnected,
    isRouteFocused,
    normalizedServerId,
    supportsProvidersSnapshot,
    workspaceDirectory,
  ]);

  const persistenceKey = useMemo(
    () =>
      buildWorkspaceTabPersistenceKey({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
      }),
    [normalizedServerId, normalizedWorkspaceId],
  );
  const openWorkspaceTabFocused = useWorkspaceLayoutStore((state) => state.openTabFocused);
  const openWorkspaceChildTabFocused = useWorkspaceLayoutStore(
    (state) => state.openChildTabFocused,
  );
  // File targets stay identity-stable so the same path reuses its tab. Keep navigation
  // requests separate so clicking an unchanged path:line can still recenter the pane.
  const [fileNavigationRevisionByTabId, setFileNavigationRevisionByTabId] = useState<
    Record<string, number>
  >({});
  const requestFileNavigation = useCallback((tabId: string) => {
    setFileNavigationRevisionByTabId((current) => ({
      ...current,
      [tabId]: (current[tabId] ?? 0) + 1,
    }));
  }, []);
  const focusWorkspacePane = useWorkspaceLayoutStore((state) => state.focusPane);
  const hasHydratedWorkspaces = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedWorkspaces ?? false,
  );
  const workspaceRecovery = useWorkspaceRecovery({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    agentId: recoveryAgentId,
    enabled: shouldInspectWorkspaceRecovery(
      hasHydratedWorkspaces,
      workspaceDescriptor,
      recoveryRequested,
    ),
  });

  const workspaceAgentVisibility = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      deriveWorkspaceAgentVisibility({
        sessionAgents: state.sessions[normalizedServerId]?.agents,
        agentDetails: state.sessions[normalizedServerId]?.agentDetails,
        workspaceId: normalizedWorkspaceId,
      }),
    workspaceAgentVisibilityEqual,
  );

  const {
    handleTerminalCreated,
    handleScriptTerminalSelected,
    handleWorkspacePathUnavailable,
    handleTerminalCreateQueued,
    handleTerminalCreateFailed,
  } = useWorkspaceTerminalTabActions({
    persistenceKey,
    openWorkspaceTabFocused,
    labels: {
      workspacePathUnavailable: t("workspace.header.toasts.workspacePathUnavailable"),
      terminalQueued: t("workspace.header.toasts.terminalQueued"),
    },
    toast,
  });
  const queryClient = useQueryClient();
  const {
    createMutation: createTerminalMutation,
    createTerminal,
    handleScriptTerminalStarted,
    handleViewScriptTerminal,
    invalidateTerminals,
    killMutation: killTerminalMutation,
    knownTerminalIds,
    liveTerminalIds,
    pendingCreateInput: pendingTerminalCreateInput,
    query: terminalsQuery,
    queryKey: terminalsQueryKey,
    removeTerminalFromCache,
    standaloneTerminalIds,
    terminals,
  } = useWorkspaceTerminals({
    client,
    isConnected,
    isRouteFocused,
    normalizedServerId,
    normalizedWorkspaceId,
    workspaceDirectory,
    workspaceScripts,
    hasHydratedWorkspaces,
    isMissingWorkspaceDirectory,
    onTerminalCreated: handleTerminalCreated,
    onScriptTerminalSelected: handleScriptTerminalSelected,
    onWorkspacePathUnavailable: handleWorkspacePathUnavailable,
    onTerminalCreateQueued: handleTerminalCreateQueued,
    onTerminalCreateFailed: handleTerminalCreateFailed,
  });
  const { archiveAgent } = useArchiveAgent();

  const { checkoutQuery, isCheckoutStatusLoading } = useWorkspaceCheckoutStatus({
    client,
    isConnected,
    isRouteFocused,
    normalizedServerId,
    normalizedWorkspaceId,
    workspaceDirectory,
  });
  const hasHydratedAgents = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedAgents ?? false,
  );
  const workspaceRouteState = useResolvedWorkspaceRouteState({
    serverId: normalizedServerId,
    workspace: workspaceDescriptor,
    hasHydratedWorkspaces,
    recovery: workspaceRecovery.state,
  });
  const workspaceHeaderCheckoutState = buildWorkspaceHeaderCheckoutState({
    isCheckoutStatusLoading,
    isError: checkoutQuery.isError,
    data: checkoutQuery.data,
  });
  const {
    isWorkspaceHeaderLoading,
    workspaceHeaderTitle,
    workspaceHeaderSubtitle,
    isWorkspaceHeaderSubtitleDistinct,
    isGitCheckout,
    currentBranchName,
  } = deriveWorkspaceHeaderFields({
    workspace: workspaceDescriptor,
    checkoutState: workspaceHeaderCheckoutState,
  });
  usePullRequestAutoAdd({
    workspaceKey: persistenceKey,
    serverId: normalizedServerId,
    cwd: workspaceDirectory,
    enabled: canObservePullRequest(isRouteFocused, isGitCheckout, isMobile),
  });

  const isCompactExplorerOpen = usePanelStore((state) =>
    selectIsFileExplorerOpen(state, { isCompact: isMobile }),
  );
  const toggleFileExplorerForCheckout = usePanelStore(
    (state) => state.toggleFileExplorerForCheckout,
  );
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);

  const activeExplorerCheckout = useMemo<ExplorerCheckoutContext | null>(() => {
    if (!normalizedServerId || !workspaceDirectory) {
      return null;
    }
    return {
      serverId: normalizedServerId,
      cwd: workspaceDirectory,
      isGit: isGitCheckout,
    };
  }, [isGitCheckout, normalizedServerId, workspaceDirectory]);

  const isDesktopExplorerOpen = useWorkspaceLayoutStore((state) =>
    isWorkspaceExplorerPaneOpen(state, persistenceKey),
  );
  const isExplorerOpen = resolveExplorerOpen(
    isMobile,
    isCompactExplorerOpen,
    isDesktopExplorerOpen,
  );

  const explorerToggleAccessibilityState = useMemo(
    () => ({ expanded: isExplorerOpen }),
    [isExplorerOpen],
  );

  useEffect(() => {
    if (!isRouteFocused || isWeb || !isExplorerOpen) {
      return;
    }

    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isExplorerOpen) {
        showMobileAgent();
        return true;
      }
      return false;
    });

    return () => handler.remove();
  }, [isExplorerOpen, isRouteFocused, showMobileAgent]);

  const workspaceLayout = useWorkspaceLayoutStore((state) =>
    persistenceKey ? (state.layoutByWorkspace[persistenceKey] ?? null) : null,
  );
  const hasHydratedWorkspaceLayoutStore = useWorkspaceLayoutStoreHydrated();
  const workspaceSetupSnapshot = useWorkspaceSetupStore((state) =>
    persistenceKey ? (state.snapshots[persistenceKey] ?? null) : null,
  );
  const ensureWorkspaceSetupStatus = useWorkspaceSetupStore((state) => state.ensureSetupStatus);
  const showWorkspaceSetup = shouldShowWorkspaceSetup(workspaceSetupSnapshot);
  const uiTabs = useMemo(
    () => (workspaceLayout ? collectAllTabs(workspaceLayout.root) : EMPTY_UI_TABS),
    [workspaceLayout],
  );
  useOpenAgentTabLabels({
    client,
    serverId: normalizedServerId,
    tabs: uiTabs,
    enabled: hasHydratedWorkspaceLayoutStore,
  });
  useSyncWorkspaceActiveBrowser({
    workspaceLayout,
    isRouteFocused,
    workspaceId: normalizedWorkspaceId,
  });
  const openWorkspaceTabInBackground = useWorkspaceLayoutStore(
    (state) => state.openTabInBackground,
  );
  const openWorkspaceTabInExplorerPaneBackground = useWorkspaceLayoutStore(
    (state) => state.openTabInExplorerPaneBackground,
  );
  const openWorkspaceTabInExplorerPaneFocused = useWorkspaceLayoutStore(
    (state) => state.openTabInExplorerPaneFocused,
  );
  const focusWorkspaceTab = useWorkspaceLayoutStore((state) => state.focusTab);
  const closeWorkspaceTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const unpinWorkspaceAgent = useWorkspaceLayoutStore((state) => state.unpinAgent);
  const hideWorkspaceAgent = useWorkspaceLayoutStore((state) => state.hideAgent);
  const retargetWorkspaceTab = useWorkspaceLayoutStore((state) => state.retargetTab);
  const reconcileWorkspaceTabs = useWorkspaceLayoutStore((state) => state.reconcileTabs);
  const splitWorkspacePane = useWorkspaceLayoutStore((state) => state.splitPane);
  const splitWorkspacePaneEmpty = useWorkspaceLayoutStore((state) => state.splitPaneEmpty);
  const moveWorkspaceTabToPane = useWorkspaceLayoutStore((state) => state.moveTabToPane);
  const handleToggleExplorer = useCallback(() => {
    toggleWorkspaceExplorerPane({
      isCompact: isMobile,
      persistenceKey,
      checkout: activeExplorerCheckout,
      toggleCompact: toggleFileExplorerForCheckout,
    });
  }, [activeExplorerCheckout, isMobile, persistenceKey, toggleFileExplorerForCheckout]);
  const paneFocusSuppressedRef = useRef(false);
  const resizeWorkspaceSplit = useWorkspaceLayoutStore((state) => state.resizeSplit);
  const reorderWorkspaceTabsInPane = useWorkspaceLayoutStore((state) => state.reorderTabsInPane);
  const _pinnedAgentIds = useWorkspaceLayoutStore((state) =>
    persistenceKey
      ? (state.pinnedAgentIdsByWorkspace[persistenceKey] ?? EMPTY_PINNED_AGENT_IDS)
      : EMPTY_PINNED_AGENT_IDS,
  );
  const _hiddenAgentIds = useWorkspaceLayoutStore((state) =>
    persistenceKey ? (state.hiddenAgentIdsByWorkspace[persistenceKey] ?? EMPTY_SET) : EMPTY_SET,
  );
  const pendingByDraftId = useCreateFlowStore((state) => state.pendingByDraftId);
  const { closingTabIds, closeTab } = useCloseTabs();
  const closeWorkspaceTabWithCleanup = useCallback(
    function closeWorkspaceTabWithCleanup(input: {
      tabId: string;
      target?: WorkspaceTabTarget | null;
    }) {
      const normalizedTabId = trimNonEmpty(input.tabId);
      if (!normalizedTabId || !persistenceKey) {
        return;
      }

      if (input.target?.kind === "agent") {
        unpinWorkspaceAgent(persistenceKey, input.target.agentId);
        hideWorkspaceAgent(persistenceKey, input.target.agentId);
      }
      if (input.target?.kind === "browser") {
        const { browserId } = input.target;
        useBrowserStore.getState().removeBrowser(browserId);
        removeResidentBrowserWebview(browserId);
        void getDesktopHost()?.browser?.unregisterWorkspaceBrowser?.(browserId);
      }
      closeWorkspaceTab(persistenceKey, normalizedTabId);
    },
    [closeWorkspaceTab, hideWorkspaceAgent, persistenceKey, unpinWorkspaceAgent],
  );

  const focusedPaneTabState = useMemo(
    () =>
      deriveWorkspacePaneState({
        layout: workspaceLayout,
        tabs: uiTabs,
      }),
    [uiTabs, workspaceLayout],
  );
  const viewedTimelineSync = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.viewedTimelineSync ?? null,
  );
  const visibleAgentIds = useMemo(
    () =>
      selectVisibleAgentIds({
        layout: workspaceLayout,
        tabs: uiTabs,
        routeFocused: isRouteFocused,
        focusedPaneOnly: isMobile || isFocusModeEnabled || !supportsDesktopPaneSplits(),
      }),
    [isFocusModeEnabled, isMobile, isRouteFocused, uiTabs, workspaceLayout],
  );
  useLayoutEffect(() => {
    if (!persistenceKey || !viewedTimelineSync) {
      return;
    }
    viewedTimelineSync.replaceVisibleAgentIds(persistenceKey, visibleAgentIds);
  }, [persistenceKey, viewedTimelineSync, visibleAgentIds]);
  useEffect(() => {
    if (!persistenceKey || !viewedTimelineSync) {
      return;
    }
    return () => viewedTimelineSync.replaceVisibleAgentIds(persistenceKey, []);
  }, [persistenceKey, viewedTimelineSync]);
  const setFocusedAgentId = useSessionStore((state) => state.setFocusedAgentId);
  const setFocusedTerminalId = useSessionStore((state) => state.setFocusedTerminalId);
  const focusedPaneAgentId = useMemo(() => {
    const target = focusedPaneTabState.activeTab?.descriptor.target;
    if (target?.kind !== "agent") {
      return null;
    }
    return target.agentId;
  }, [focusedPaneTabState.activeTab]);
  const focusedPaneTerminalId = useMemo(() => {
    const target = focusedPaneTabState.activeTab?.descriptor.target;
    if (target?.kind !== "terminal") {
      return null;
    }
    return target.terminalId;
  }, [focusedPaneTabState.activeTab]);

  useEffect(() => {
    if (!isRouteFocused) {
      return;
    }
    setFocusedAgentId(normalizedServerId, focusedPaneAgentId);
    setFocusedTerminalId(normalizedServerId, focusedPaneTerminalId);
  }, [
    focusedPaneAgentId,
    focusedPaneTerminalId,
    isRouteFocused,
    normalizedServerId,
    setFocusedAgentId,
    setFocusedTerminalId,
  ]);

  useEffect(() => {
    if (!isRouteFocused) {
      return;
    }
    return () => {
      setFocusedAgentId(normalizedServerId, null);
      setFocusedTerminalId(normalizedServerId, null);
    };
  }, [isRouteFocused, normalizedServerId, setFocusedAgentId, setFocusedTerminalId]);

  const openWorkspaceDraftTab = useCallback(
    function openWorkspaceDraftTab(input?: {
      draftId?: string;
      focus?: boolean;
      paneId?: string | null;
    }) {
      if (!persistenceKey) {
        return null;
      }

      const target = normalizeWorkspaceTabTarget({
        kind: "draft",
        draftId: trimNonEmpty(input?.draftId) ?? generateDraftId(),
      });
      invariant(target?.kind === "draft", "Draft tab target must be valid");
      const placement = { paneId: input?.paneId };
      if (input?.focus === false) {
        return openWorkspaceTabInBackground(persistenceKey, target, placement);
      }
      return openWorkspaceTabFocused(persistenceKey, target, placement);
    },
    [openWorkspaceTabFocused, openWorkspaceTabInBackground, persistenceKey],
  );

  useEffect(() => {
    if (!isRouteFocused) {
      return;
    }
    if (!normalizedServerId || !normalizedWorkspaceId || !persistenceKey) {
      return;
    }
    if (!hasHydratedWorkspaceLayoutStore) {
      return;
    }

    const hasActivePendingDraftCreateInWorkspace = uiTabs.some((tab) => {
      if (tab.target.kind !== "draft") {
        return false;
      }
      const pending = pendingByDraftId[tab.target.draftId];
      return pending?.serverId === normalizedServerId && pending.lifecycle === "active";
    });

    reconcileWorkspaceTabs(
      persistenceKey,
      buildWorkspaceTabSnapshot({
        agentVisibility: workspaceAgentVisibility,
        agentsHydrated: hasHydratedAgents,
        terminalsHydrated: terminalsQuery.isSuccess,
        knownTerminalIds,
        standaloneTerminalIds,
        hasActivePendingDraftCreate: hasActivePendingDraftCreateInWorkspace,
      }),
    );
  }, [
    hasHydratedAgents,
    hasHydratedWorkspaceLayoutStore,
    isRouteFocused,
    normalizedServerId,
    normalizedWorkspaceId,
    pendingByDraftId,
    persistenceKey,
    reconcileWorkspaceTabs,
    knownTerminalIds,
    standaloneTerminalIds,
    terminalsQuery.isSuccess,
    uiTabs,
    workspaceAgentVisibility,
  ]);

  const activeTabId = focusedPaneTabState.activeTabId;
  const activeTab = focusedPaneTabState.activeTab;

  const tabs = useMemo<WorkspaceTabDescriptor[]>(
    () => focusedPaneTabState.tabs.map((tab) => tab.descriptor),
    [focusedPaneTabState.tabs],
  );
  const hasSetupTab = useMemo(
    () =>
      uiTabs.some(
        (tab) => tab.target.kind === "setup" && tab.target.workspaceId === normalizedWorkspaceId,
      ),
    [normalizedWorkspaceId, uiTabs],
  );
  const navigateToTabId = useCallback(
    function navigateToTabId(tabId: string) {
      if (!tabId || !persistenceKey) {
        return;
      }
      focusWorkspaceTab(persistenceKey, tabId);
    },
    [focusWorkspaceTab, persistenceKey],
  );
  const handleImportedAgent = useCallback(
    (agentId: string) => {
      if (!persistenceKey) {
        return;
      }
      const tabId = openWorkspaceTabFocused(persistenceKey, { kind: "agent", agentId });
      if (tabId) {
        navigateToTabId(tabId);
      }
    },
    [navigateToTabId, openWorkspaceTabFocused, persistenceKey],
  );

  const emptyWorkspaceSeedRef = useRef<string | null>(null);
  const autoOpenedSetupTabWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    if (!isRouteFocused) {
      return;
    }
    if (!persistenceKey) {
      return;
    }
    if (!workspaceSetupSnapshot || !showWorkspaceSetup) {
      if (autoOpenedSetupTabWorkspaceRef.current === persistenceKey) {
        autoOpenedSetupTabWorkspaceRef.current = null;
      }
      return;
    }

    const snapshotAge = Date.now() - workspaceSetupSnapshot.updatedAt;
    const shouldAutoOpen =
      workspaceSetupSnapshot.status === "running" ||
      snapshotAge <= WORKSPACE_SETUP_AUTO_OPEN_WINDOW_MS;
    if (!shouldAutoOpen) {
      return;
    }
    if (hasSetupTab) {
      autoOpenedSetupTabWorkspaceRef.current = persistenceKey;
      return;
    }
    if (autoOpenedSetupTabWorkspaceRef.current === persistenceKey) {
      return;
    }

    const target = normalizeWorkspaceTabTarget({
      kind: "setup",
      workspaceId: normalizedWorkspaceId,
    });
    if (!target) {
      return;
    }

    const tabId =
      isMobile || !supportsDesktopPaneSplits()
        ? openWorkspaceTabInBackground(persistenceKey, target)
        : openWorkspaceTabInExplorerPaneBackground(persistenceKey, target);
    if (!tabId) {
      return;
    }

    autoOpenedSetupTabWorkspaceRef.current = persistenceKey;
  }, [
    hasSetupTab,
    isMobile,
    isRouteFocused,
    normalizedWorkspaceId,
    openWorkspaceTabInBackground,
    openWorkspaceTabInExplorerPaneBackground,
    persistenceKey,
    showWorkspaceSetup,
    workspaceSetupSnapshot,
  ]);

  useEffect(() => {
    if (!isRouteFocused || !client || !normalizedServerId || !normalizedWorkspaceId) {
      return;
    }
    ensureWorkspaceSetupStatus({
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
      client,
    });
  }, [
    client,
    ensureWorkspaceSetupStatus,
    isRouteFocused,
    normalizedServerId,
    normalizedWorkspaceId,
  ]);

  useEffect(() => {
    if (
      !shouldSeedEmptyWorkspaceDraft({
        isRouteFocused,
        hasPersistenceKey: Boolean(persistenceKey),
        hasWorkspaceDirectory: Boolean(workspaceDirectory),
        hasHydratedWorkspaceLayoutStore,
        hasHydratedAgents,
        hasLoadedTerminals: terminalsQuery.isSuccess,
        activeAgentCount: workspaceAgentVisibility.activeAgentIds.size,
        terminalCount: terminals.length,
        tabCount: tabs.length,
      })
    ) {
      emptyWorkspaceSeedRef.current = null;
      return;
    }
    const workspaceKey = `${normalizedServerId}:${normalizedWorkspaceId}`;
    if (emptyWorkspaceSeedRef.current === workspaceKey) {
      return;
    }
    emptyWorkspaceSeedRef.current = workspaceKey;
    openWorkspaceDraftTab();
  }, [
    normalizedServerId,
    normalizedWorkspaceId,
    openWorkspaceDraftTab,
    persistenceKey,
    hasHydratedAgents,
    hasHydratedWorkspaceLayoutStore,
    isRouteFocused,
    terminals.length,
    terminalsQuery.isSuccess,
    tabs.length,
    workspaceDirectory,
    workspaceAgentVisibility.activeAgentIds.size,
  ]);

  const handleOpenFileFromExplorer = useCallback(
    function handleOpenFileFromExplorer(filePath: string) {
      if (!persistenceKey) {
        return;
      }
      const location = normalizeWorkspaceFileLocation({ path: filePath });
      if (!location) {
        return;
      }
      const tabId = openWorkspaceTabFocused(persistenceKey, createWorkspaceFileTabTarget(location));
      if (tabId) {
        navigateToTabId(tabId);
      }
    },
    [navigateToTabId, openWorkspaceTabFocused, persistenceKey],
  );

  const handleOpenFileFromChat = useCallback(
    (location: WorkspaceFileLocation, options?: { parentTabId?: string | null }) => {
      const normalizedLocation = normalizeWorkspaceFileLocation(location);
      if (!normalizedLocation) {
        return;
      }
      if (isMobile) {
        showMobileAgent();
      }
      if (!persistenceKey) {
        return;
      }
      const target = createWorkspaceFileTabTarget(normalizedLocation);
      const tabId = options?.parentTabId
        ? openWorkspaceChildTabFocused(persistenceKey, target, options.parentTabId)
        : openWorkspaceTabFocused(persistenceKey, target);
      if (tabId) {
        requestFileNavigation(tabId);
        navigateToTabId(tabId);
      }
    },
    [
      isMobile,
      navigateToTabId,
      openWorkspaceChildTabFocused,
      openWorkspaceTabFocused,
      persistenceKey,
      requestFileNavigation,
      showMobileAgent,
    ],
  );

  const handleOpenAssistantFileInExplorerPane = useCallback(
    (input: { location: WorkspaceFileLocation; parentTabId?: string | null }) => {
      const location = normalizeWorkspaceFileLocation(input.location);
      if (!location) {
        return;
      }
      if (!persistenceKey || isMobile || !supportsDesktopPaneSplits()) {
        handleOpenFileFromChat(location, { parentTabId: input.parentTabId });
        return;
      }

      const target: WorkspaceTabTarget = createWorkspaceFileTabTarget(location);
      const tabId = useWorkspaceLayoutStore
        .getState()
        .openTabInExplorerPaneFocused(persistenceKey, {
          target,
          parentTabId: input.parentTabId,
        });
      if (tabId) {
        requestFileNavigation(tabId);
        navigateToTabId(tabId);
      }
    },
    [handleOpenFileFromChat, isMobile, navigateToTabId, persistenceKey, requestFileNavigation],
  );

  const handleOpenWorkspaceFileFromPane = useStableEvent(function handleOpenWorkspaceFileFromPane({
    request,
    paneId,
    parentTabId,
    focusPaneBeforeOpen,
  }: {
    request: WorkspaceFileOpenRequest;
    paneId?: string | null;
    parentTabId: string;
    focusPaneBeforeOpen?: boolean;
  }) {
    if (focusPaneBeforeOpen && paneId && persistenceKey) {
      focusWorkspacePane(persistenceKey, paneId);
    }
    if (request.disposition === "side") {
      handleOpenAssistantFileInExplorerPane({
        location: request.location,
        parentTabId,
      });
      return;
    }
    handleOpenFileFromChat(request.location, { parentTabId });
  });

  const [hoveredCloseTabKey, setHoveredCloseTabKey] = useState<string | null>(null);
  const { handleRenameTab, renamingTab, handleRenameModalSubmit, handleRenameModalClose } =
    useWorkspaceTabRename({
      client,
      normalizedServerId,
      queryClient,
      terminalsData: terminalsQuery.data,
      terminalsQueryKey,
    });

  const tabByKey = useMemo(() => {
    const map = new Map<string, WorkspaceTabDescriptor>();
    for (const tab of tabs) {
      map.set(tab.key, tab);
    }
    return map;
  }, [tabs]);

  const allTabDescriptorsById = useMemo(() => {
    const map = new Map<string, WorkspaceTabDescriptor>();
    for (const tab of uiTabs) {
      map.set(tab.tabId, {
        key: tab.tabId,
        tabId: tab.tabId,
        kind: tab.target.kind,
        target: tab.target,
      });
    }
    return map;
  }, [uiTabs]);
  const bulkCloseConfirmationLabels = useMemo<BulkCloseConfirmationLabels>(
    () => ({
      all: ({ agents, terminals: terminalCount, tabs: tabCount }) =>
        t("workspace.tabs.confirmations.bulk.all", {
          agents,
          terminals: terminalCount,
          tabs: tabCount,
        }),
      agentsAndTerminals: ({ agents, terminals: terminalCount }) =>
        t("workspace.tabs.confirmations.bulk.agentsAndTerminals", {
          agents,
          terminals: terminalCount,
        }),
      terminalsAndTabs: ({ terminals: terminalCount, tabs: tabCount }) =>
        t("workspace.tabs.confirmations.bulk.terminalsAndTabs", {
          terminals: terminalCount,
          tabs: tabCount,
        }),
      agentsAndTabs: ({ agents, tabs: tabCount }) =>
        t("workspace.tabs.confirmations.bulk.agentsAndTabs", { agents, tabs: tabCount }),
      terminals: ({ terminals: terminalCount }) =>
        t("workspace.tabs.confirmations.bulk.terminals", { terminals: terminalCount }),
      tabs: ({ tabs: tabCount }) => t("workspace.tabs.confirmations.bulk.tabs", { tabs: tabCount }),
      agents: ({ agents }) => t("workspace.tabs.confirmations.bulk.agents", { agents }),
    }),
    [t],
  );
  const explorerToggleLabel = isExplorerOpen
    ? t("workspace.tabs.explorer.close")
    : t("workspace.tabs.explorer.open");

  const activeTabKey = useMemo(() => activeTabId ?? "", [activeTabId]);
  const tabFallbackLabels = useMemo(
    () => ({
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

  const handleCreateDraftTab = useCallback(
    (input?: { paneId?: string }) => {
      openWorkspaceDraftTab({ paneId: input?.paneId });
    },
    [openWorkspaceDraftTab],
  );

  const handleCreateTerminal = useStableEvent(createTerminal);

  const handleCreateTerminalWithProfile = useCallback(
    (profile: TerminalProfile) => {
      createTerminal({ profile });
    },
    [createTerminal],
  );

  const handleCreateBrowserTab = useCallback(
    (input?: { paneId?: string }) => {
      if (!persistenceKey || !getIsElectron()) {
        return;
      }
      const { browserId } = createWorkspaceBrowser();
      openWorkspaceTabFocused(
        persistenceKey,
        { kind: "browser", browserId },
        { paneId: input?.paneId },
      );
    },
    [openWorkspaceTabFocused, persistenceKey],
  );

  const handleOpenUrlInBrowserTab = useCallback(
    (url: string) => {
      if (!persistenceKey || !getIsElectron()) {
        return;
      }
      const { browserId } = createWorkspaceBrowser({ initialUrl: url });
      openWorkspaceTabFocused(persistenceKey, { kind: "browser", browserId });
    },
    [openWorkspaceTabFocused, persistenceKey],
  );

  useDesktopBrowserNewTabRequests({
    enabled: Boolean(persistenceKey),
    workspaceLayout,
    openUrl: handleOpenUrlInBrowserTab,
  });

  const handleSelectSwitcherTab = useCallback(
    (key: string) => {
      navigateToTabId(key);
    },
    [navigateToTabId],
  );

  const handleCreateDraftSplit = useCallback(
    (input: { targetPaneId: string; position: "left" | "right" | "top" | "bottom" }) => {
      if (!persistenceKey) {
        return;
      }

      const paneId = splitWorkspacePaneEmpty(persistenceKey, input);
      if (!paneId) {
        return;
      }

      handleCreateDraftTab({ paneId });
    },
    [handleCreateDraftTab, persistenceKey, splitWorkspacePaneEmpty],
  );

  const killTerminalAsync = killTerminalMutation.mutateAsync;

  const handleCloseTerminalTab = useCallback(
    async (input: { tabId: string; terminalId: string }) => {
      const { tabId, terminalId } = input;
      await closeTab(tabId, async () => {
        const confirmed = await confirmDialog({
          title: t("workspace.tabs.confirmations.closeTerminalTitle"),
          message: t("workspace.tabs.confirmations.closeTerminalMessage"),
          confirmLabel: t("workspace.tabs.confirmations.close"),
          cancelLabel: t("workspace.tabs.confirmations.cancel"),
          destructive: true,
        });
        if (!confirmed) {
          return;
        }

        removeTerminalFromCache(terminalId);
        setHoveredCloseTabKey((current) => (current === tabId ? null : current));
        if (persistenceKey) {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: { kind: "terminal", terminalId },
          });
        }

        void killTerminalAsync(terminalId).catch(invalidateTerminals);
      });
    },
    [
      closeTab,
      closeWorkspaceTabWithCleanup,
      invalidateTerminals,
      killTerminalAsync,
      persistenceKey,
      removeTerminalFromCache,
      t,
    ],
  );

  const handleCloseAgentTab = useCallback(
    async (input: { tabId: string; agentId: string }) => {
      const { tabId, agentId } = input;
      await closeTab(tabId, async () => {
        if (!normalizedServerId) {
          return;
        }

        const agent =
          useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
        let closePolicy = resolveCloseAgentTabPolicy(agent);
        const isRunning = agent?.status === "running";

        if (isRunning && closePolicy.kind === "archive-on-close") {
          const confirmed = await confirmDialog({
            title: t("workspace.tabs.confirmations.archiveRunningAgentTitle"),
            message: t("workspace.tabs.confirmations.archiveRunningAgentMessage"),
            confirmLabel: t("workspace.tabs.confirmations.archive"),
            cancelLabel: t("workspace.tabs.confirmations.cancel"),
            destructive: true,
          });
          if (!confirmed) {
            return;
          }
        }

        if (closePolicy.kind === "layout-only") {
          const sessionClient = useSessionStore.getState().sessions[normalizedServerId]?.client;
          if (!sessionClient) {
            toast.error(t("common.errors.daemonClientUnavailable"));
            return;
          }
          try {
            const clientId = await getOrCreateClientId();
            await sessionClient.updateAgent(agentId, {
              labels: { [getOpenAgentTabLabel(clientId)]: "false" },
            });
            const latestAgent =
              useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
            closePolicy = resolveCloseAgentTabPolicy(latestAgent);
          } catch (error) {
            console.error("[WorkspaceScreen] Failed to close subagent tab", { error, agentId });
            toast.error(t("workspace.tabs.toasts.failedToCloseAgent"));
            return;
          }
        }

        setHoveredCloseTabKey((current) => (current === tabId ? null : current));
        if (persistenceKey) {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: { kind: "agent", agentId },
          });
        }

        if (closePolicy.kind === "layout-only") {
          return;
        }

        // Errors (e.g. timeout) are handled by the mutation's onSettled callback
        void archiveAgent({ serverId: normalizedServerId, agentId }).catch(() => {});
      });
    },
    [
      archiveAgent,
      closeTab,
      closeWorkspaceTabWithCleanup,
      normalizedServerId,
      persistenceKey,
      t,
      toast,
    ],
  );

  const handleClosePassiveTab = useCallback(
    function handleClosePassiveTab(input: { tabId: string; target?: WorkspaceTabTarget | null }) {
      setHoveredCloseTabKey((current) => (current === input.tabId ? null : current));
      if (persistenceKey) {
        closeWorkspaceTabWithCleanup({ tabId: input.tabId, target: input.target });
      }
    },
    [closeWorkspaceTabWithCleanup, persistenceKey],
  );

  const confirmDiscardModifiedTab = useCallback(
    async (tabId: string): Promise<boolean> => {
      const attributes = getPanelInstanceAttributes({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
        tabId,
      });
      if (!attributes.modified) return true;
      const resumePendingSave = attributes.suspendPendingSave?.();
      const confirmed = await confirmDialog({
        title: t("workspace.tabs.confirmations.unsavedTitle"),
        message: t("workspace.tabs.confirmations.unsavedMessage"),
        confirmLabel: t("workspace.tabs.confirmations.closeWithoutSaving"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) resumePendingSave?.();
      return confirmed;
    },
    [normalizedServerId, normalizedWorkspaceId, t],
  );

  const handleCloseTabById = useCallback(
    async (tabId: string) => {
      const tab = allTabDescriptorsById.get(tabId);
      if (!tab) {
        return;
      }
      if (!(await confirmDiscardModifiedTab(tabId))) {
        return;
      }
      if (tab.target.kind === "terminal") {
        await handleCloseTerminalTab({ tabId, terminalId: tab.target.terminalId });
        return;
      }
      if (tab.target.kind === "agent") {
        await handleCloseAgentTab({ tabId, agentId: tab.target.agentId });
        return;
      }
      handleClosePassiveTab({ tabId, target: tab.target });
    },
    [
      allTabDescriptorsById,
      confirmDiscardModifiedTab,
      handleCloseAgentTab,
      handleClosePassiveTab,
      handleCloseTerminalTab,
    ],
  );

  const handleCopyAgentId = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      try {
        await Clipboard.setStringAsync(agentId);
        toast.copied(t("workspace.tabs.toasts.agentIdCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [toast, t],
  );

  const handleCopyTerminalId = useCallback(
    async (terminalId: string) => {
      if (!terminalId) return;
      try {
        await Clipboard.setStringAsync(terminalId);
        toast.copied(t("workspace.tabs.toasts.terminalIdCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [toast, t],
  );

  const handleCopyFilePath = useCallback(
    async (path: string) => {
      if (!path) return;
      try {
        await Clipboard.setStringAsync(path);
        toast.copied(t("workspace.tabs.toasts.filePathCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [toast, t],
  );

  const handleCopyResumeCommand = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      const agent =
        useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
      const providerSessionId =
        agent?.runtimeInfo?.sessionId ?? agent?.persistence?.sessionId ?? null;
      if (!agent || !providerSessionId) {
        toast.error(t("workspace.tabs.toasts.resumeIdUnavailable"));
        return;
      }

      const command =
        buildProviderCommand({
          provider: agent.provider,
          id: "resume",
          sessionId: providerSessionId,
        }) ?? null;
      if (!command) {
        toast.error(t("workspace.tabs.toasts.resumeCommandUnavailable"));
        return;
      }
      try {
        await Clipboard.setStringAsync(command);
        toast.copied(t("workspace.tabs.toasts.resumeCommandCopiedLabel"));
      } catch {
        toast.error(t("workspace.tabs.toasts.copyFailed"));
      }
    },
    [normalizedServerId, toast, t],
  );

  const handleReloadAgent = useCallback(
    async (agentId: string) => {
      if (!client || !isConnected) {
        toast.error(t("workspace.terminal.hostDisconnected"));
        return;
      }

      toast.show(t("workspace.tabs.toasts.reloadingAgent"), { durationMs: null });
      try {
        await client.refreshAgent(agentId);
        // Send the existing cursor so the server detects the new epoch and
        // returns reset:true. Without a cursor, the server returns reset:false
        // and the client takes the incremental path, where new-epoch rows are
        // dropped against the stale cursor.
        const sessionState = useSessionStore.getState().sessions[normalizedServerId];
        const currentCursor = sessionState?.agentTimelineCursor.get(agentId);
        await getHostRuntimeStore().fetchAgentTimeline(normalizedServerId, agentId, {
          direction: "tail",
          projection: "projected",
          ...(currentCursor
            ? { cursor: { epoch: currentCursor.epoch, seq: currentCursor.endSeq } }
            : {}),
        });
        toast.show(t("workspace.tabs.toasts.reloadedAgent"), { variant: "success" });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : t("workspace.tabs.toasts.failedToReloadAgent"),
        );
      }
    },
    [client, isConnected, normalizedServerId, toast, t],
  );

  const handleCopyWorkspacePath = useCallback(async () => {
    if (!workspaceDirectory) {
      toast.error(t("workspace.header.toasts.workspacePathUnavailable"));
      return;
    }

    try {
      await Clipboard.setStringAsync(workspaceDirectory);
      toast.copied(t("workspace.header.toasts.workspacePathCopiedLabel"));
    } catch {
      toast.error(t("workspace.tabs.toasts.copyFailed"));
    }
  }, [toast, workspaceDirectory, t]);

  const handleCopyBranchName = useCallback(async () => {
    if (!currentBranchName) {
      toast.error(t("workspace.header.toasts.branchNameUnavailable"));
      return;
    }

    try {
      await Clipboard.setStringAsync(currentBranchName);
      toast.copied(t("workspace.header.toasts.branchNameCopiedLabel"));
    } catch {
      toast.error(t("workspace.tabs.toasts.copyFailed"));
    }
  }, [currentBranchName, toast, t]);

  const handleOpenSetupTab = useCallback(() => {
    if (!persistenceKey) {
      return;
    }
    const target = normalizeWorkspaceTabTarget({
      kind: "setup",
      workspaceId: normalizedWorkspaceId,
    });
    if (!target) {
      return;
    }
    if (isMobile || !supportsDesktopPaneSplits()) {
      openWorkspaceTabFocused(persistenceKey, target);
      return;
    }
    openWorkspaceTabInExplorerPaneFocused(persistenceKey, { target });
  }, [
    isMobile,
    normalizedWorkspaceId,
    openWorkspaceTabFocused,
    openWorkspaceTabInExplorerPaneFocused,
    persistenceKey,
  ]);

  const handleBulkCloseTabs = useCallback(
    async (input: { tabsToClose: WorkspaceTabDescriptor[]; title: string; logLabel: string }) => {
      const { tabsToClose, title, logLabel } = input;
      if (tabsToClose.length === 0) {
        return;
      }

      const groups = classifyBulkClosableTabs(tabsToClose, (agentId) => {
        const agent = useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId);
        return resolveCloseAgentTabPolicy(agent).kind === "layout-only" ? "layout-only" : "archive";
      });
      const modifiedCount = tabsToClose.filter(
        (tab) =>
          getPanelInstanceAttributes({
            serverId: normalizedServerId,
            workspaceId: normalizedWorkspaceId,
            tabId: tab.tabId,
          }).modified,
      ).length;
      const bulkMessage = buildBulkCloseConfirmationMessage(groups, bulkCloseConfirmationLabels);
      const confirmed = await confirmDialog({
        title,
        message:
          modifiedCount > 0
            ? `${bulkMessage}\n\n${t("workspace.tabs.confirmations.bulkUnsaved", { count: modifiedCount })}`
            : bulkMessage,
        confirmLabel: t("workspace.tabs.confirmations.close"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      await closeBulkWorkspaceTabs({
        client,
        groups,
        closeTab,
        closeLayoutOnlyAgent: async (agentId) => {
          if (!client) {
            throw new Error(t("common.errors.daemonClientUnavailable"));
          }
          const clientId = await getOrCreateClientId();
          await client.updateAgent(agentId, {
            labels: { [getOpenAgentTabLabel(clientId)]: "false" },
          });
          const latestAgent =
            useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
          if (resolveCloseAgentTabPolicy(latestAgent).kind === "archive-on-close") {
            await archiveAgent({ serverId: normalizedServerId, agentId });
          }
        },
        closeWorkspaceTabWithCleanup: (cleanupInput) => {
          if (!persistenceKey) {
            return;
          }
          closeWorkspaceTabWithCleanup(cleanupInput);
        },
        logLabel,
        warn: (message, payload) => {
          console.warn(message, payload);
        },
      });

      const closedKeys = new Set(tabsToClose.map((tab) => tab.key));
      setHoveredCloseTabKey((current) => (current && closedKeys.has(current) ? null : current));
    },
    [
      archiveAgent,
      bulkCloseConfirmationLabels,
      client,
      closeTab,
      closeWorkspaceTabWithCleanup,
      normalizedServerId,
      normalizedWorkspaceId,
      persistenceKey,
      t,
    ],
  );

  const handleCloseTabsToLeftInPane = useCallback(
    async (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => {
      const index = paneTabs.findIndex((tab) => tab.tabId === tabId);
      if (index < 0) {
        return;
      }
      await handleBulkCloseTabs({
        tabsToClose: paneTabs.slice(0, index),
        title: t("workspace.tabs.confirmations.closeTabsLeftTitle"),
        logLabel: "to the left",
      });
    },
    [handleBulkCloseTabs, t],
  );

  const handleCloseTabsToLeft = useCallback(
    async (tabId: string) => {
      await handleCloseTabsToLeftInPane(tabId, tabs);
    },
    [handleCloseTabsToLeftInPane, tabs],
  );

  const handleCloseTabsToRightInPane = useCallback(
    async (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => {
      const index = paneTabs.findIndex((tab) => tab.tabId === tabId);
      if (index < 0) {
        return;
      }
      await handleBulkCloseTabs({
        tabsToClose: paneTabs.slice(index + 1),
        title: t("workspace.tabs.confirmations.closeTabsRightTitle"),
        logLabel: "to the right",
      });
    },
    [handleBulkCloseTabs, t],
  );

  const handleCloseTabsToRight = useCallback(
    async (tabId: string) => {
      await handleCloseTabsToRightInPane(tabId, tabs);
    },
    [handleCloseTabsToRightInPane, tabs],
  );

  const handleCloseOtherTabsInPane = useCallback(
    async (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => {
      const tabsToClose = paneTabs.filter((tab) => tab.tabId !== tabId);
      await handleBulkCloseTabs({
        tabsToClose,
        title: t("workspace.tabs.confirmations.closeOtherTabsTitle"),
        logLabel: "from close other tabs",
      });
    },
    [handleBulkCloseTabs, t],
  );

  const handleCloseOtherTabs = useCallback(
    async (tabId: string) => {
      await handleCloseOtherTabsInPane(tabId, tabs);
    },
    [handleCloseOtherTabsInPane, tabs],
  );

  const handleWorkspaceTabAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      switch (action.id) {
        case "workspace.agent.new":
          handleCreateDraftTab();
          return true;
        case "workspace.terminal.new":
          handleCreateTerminal();
          return true;
        case "workspace.browser.new":
          handleCreateBrowserTab();
          return true;
        case "workspace.tab.close-current":
          if (activeTabId) {
            void handleCloseTabById(activeTabId);
          }
          return true;
        case "workspace.tab.navigate-index": {
          const next = tabs[action.index - 1] ?? null;
          if (next?.tabId) {
            navigateToTabId(next.tabId);
          }
          return true;
        }
        case "workspace.tab.navigate-relative": {
          if (tabs.length > 0) {
            const currentIndex = tabs.findIndex((tab) => tab.tabId === activeTabId);
            const fromIndex = currentIndex >= 0 ? currentIndex : 0;
            const nextIndex = (fromIndex + action.delta + tabs.length) % tabs.length;
            const next = tabs[nextIndex] ?? null;
            if (next?.tabId) {
              navigateToTabId(next.tabId);
            }
          }
          return true;
        }
        default:
          return false;
      }
    },
    [
      activeTabId,
      handleCloseTabById,
      handleCreateDraftTab,
      handleCreateBrowserTab,
      handleCreateTerminal,
      navigateToTabId,
      tabs,
    ],
  );

  const handleWorkspaceSidebarAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id !== "sidebar.toggle.right") {
        return false;
      }
      handleToggleExplorer();
      return true;
    },
    [handleToggleExplorer],
  );

  const handleWorkspacePaneAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
      if (action.id === "workspace.focus.toggle") {
        toggleFocusMode();
        return true;
      }

      if (!persistenceKey || !workspaceLayout) {
        return true;
      }

      const focusedPane = focusedPaneTabState.pane;
      if (!focusedPane) {
        return true;
      }

      if (action.id === "workspace.pane.split.right") {
        handleCreateDraftSplit({
          targetPaneId: focusedPane.id,
          position: "right",
        });
        return true;
      }

      if (action.id === "workspace.pane.split.down") {
        handleCreateDraftSplit({
          targetPaneId: focusedPane.id,
          position: "bottom",
        });
        return true;
      }

      if (action.id.startsWith("workspace.pane.focus.")) {
        const direction = parsePaneDirection(action.id);
        if (direction) {
          const adjacentPaneId = findAdjacentPane(workspaceLayout.root, focusedPane.id, direction);
          if (adjacentPaneId) {
            focusWorkspacePane(persistenceKey, adjacentPaneId);
          }
        }
        return true;
      }

      if (action.id.startsWith("workspace.pane.move-tab.")) {
        const direction = parsePaneDirection(action.id);
        if (direction) {
          const activePaneTabId = focusedPaneTabState.activeTabId;
          const adjacentPaneId = findAdjacentPane(workspaceLayout.root, focusedPane.id, direction);
          if (activePaneTabId && adjacentPaneId) {
            paneFocusSuppressedRef.current = true;
            moveWorkspaceTabToPane(persistenceKey, activePaneTabId, adjacentPaneId);
            requestAnimationFrame(() => {
              paneFocusSuppressedRef.current = false;
            });
          }
        }
        return true;
      }

      if (action.id === "workspace.pane.close") {
        const tabsToClose = focusedPane.tabIds.flatMap((tabId) => {
          const tab = allTabDescriptorsById.get(tabId);
          return tab ? [tab] : [];
        });
        void handleBulkCloseTabs({
          tabsToClose,
          title: t("workspace.tabs.confirmations.closePaneTitle"),
          logLabel: "from pane close",
        });
        return true;
      }

      return false;
    },
    [
      allTabDescriptorsById,
      focusWorkspacePane,
      handleBulkCloseTabs,
      handleCreateDraftSplit,
      moveWorkspaceTabToPane,
      persistenceKey,
      focusedPaneTabState.activeTabId,
      focusedPaneTabState.pane,
      toggleFocusMode,
      t,
      workspaceLayout,
    ],
  );

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-tab-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: [
      "workspace.agent.new",
      "workspace.tab.close-current",
      "workspace.tab.navigate-index",
      "workspace.tab.navigate-relative",
      "workspace.terminal.new",
      "workspace.browser.new",
    ] as const,
    enabled: Boolean(isRouteFocused && normalizedServerId && normalizedWorkspaceId),
    priority: 100,
    isActive: () => true,
    handle: handleWorkspaceTabAction,
  });

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-pane-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: [
      "workspace.pane.split.right",
      "workspace.pane.split.down",
      "workspace.pane.focus.left",
      "workspace.pane.focus.right",
      "workspace.pane.focus.up",
      "workspace.pane.focus.down",
      "workspace.pane.move-tab.left",
      "workspace.pane.move-tab.right",
      "workspace.pane.move-tab.up",
      "workspace.pane.move-tab.down",
      "workspace.pane.close",
      "workspace.focus.toggle",
    ] as const,
    enabled: Boolean(isRouteFocused && normalizedServerId && normalizedWorkspaceId),
    priority: 100,
    isActive: () => true,
    handle: handleWorkspacePaneAction,
  });

  useKeyboardActionHandler({
    handlerId: buildWorkspaceKeyboardHandlerId({
      name: "workspace-sidebar-actions",
      serverId: normalizedServerId,
      workspaceId: normalizedWorkspaceId,
    }),
    actions: ["sidebar.toggle.right"] as const,
    enabled: Boolean(isRouteFocused && normalizedServerId && normalizedWorkspaceId),
    priority: 100,
    isActive: () => true,
    handle: handleWorkspaceSidebarAction,
  });

  const activeTabDescriptor = useMemo(() => activeTab?.descriptor ?? null, [activeTab]);
  const activeFileFields = getWorkspaceFileLocationFields(activeTabDescriptor);
  const activeFilePath = activeFileFields.path;
  const activeFileLineStart = activeFileFields.lineStart;
  const activeFileLineEnd = activeFileFields.lineEnd;
  const activeFileLocation = useMemo<WorkspaceFileLocation | null>(
    () =>
      buildWorkspaceFileLocation({
        path: activeFilePath,
        lineStart: activeFileLineStart,
        lineEnd: activeFileLineEnd,
      }),
    [activeFileLineEnd, activeFileLineStart, activeFilePath],
  );
  const canRenderDesktopPaneSplits = supportsDesktopPaneSplits();
  const shouldRenderDesktopPaneFallback = useMemo(
    () => !isMobile && !canRenderDesktopPaneSplits,
    [isMobile, canRenderDesktopPaneSplits],
  );
  useEffect(() => {
    if (!isRouteFocused || isNative || typeof document === "undefined" || activeTabDescriptor) {
      return;
    }
    document.title = "Workspace";
  }, [activeTabDescriptor, isRouteFocused]);
  const buildPaneContentModel = useCallback(
    (input: {
      tab: WorkspaceTabDescriptor;
      paneId?: string | null;
      focusPaneBeforeOpen?: boolean;
    }) =>
      buildWorkspacePaneContentModel({
        tab: input.tab,
        normalizedServerId,
        normalizedWorkspaceId,
        fileNavigationRevision: fileNavigationRevisionByTabId[input.tab.tabId] ?? 0,
        onOpenTab: (target) => {
          if (!persistenceKey) {
            return;
          }
          const tabId = openWorkspaceChildTabFocused(persistenceKey, target, input.tab.tabId, {
            paneId: input.focusPaneBeforeOpen ? input.paneId : null,
          });
          if (tabId) {
            navigateToTabId(tabId);
          }
        },
        onCloseCurrentTab: () => {
          void handleCloseTabById(input.tab.tabId);
        },
        onRetargetCurrentTab: (target) => {
          if (!persistenceKey) {
            return;
          }
          retargetWorkspaceTab(persistenceKey, input.tab.tabId, target);
        },
        onOpenWorkspaceFile: (request: WorkspaceFileOpenRequest) => {
          handleOpenWorkspaceFileFromPane({
            request,
            paneId: input.paneId,
            parentTabId: input.tab.tabId,
            focusPaneBeforeOpen: input.focusPaneBeforeOpen,
          });
        },
        onOpenImportSheet: openImportSheet,
      }),
    [
      handleCloseTabById,
      fileNavigationRevisionByTabId,
      handleOpenWorkspaceFileFromPane,
      navigateToTabId,
      normalizedServerId,
      normalizedWorkspaceId,
      openImportSheet,
      openWorkspaceChildTabFocused,
      persistenceKey,
      retargetWorkspaceTab,
    ],
  );
  const focusedPaneId = useMemo(
    () => focusedPaneTabState.pane?.id ?? null,
    [focusedPaneTabState.pane],
  );
  const focusedPaneTabIds = useMemo(() => tabs.map((tab) => tab.tabId), [tabs]);
  const modifiedFocusedPaneTabIds = useModifiedPanelTabIds({
    serverId: normalizedServerId,
    workspaceId: normalizedWorkspaceId,
    tabIds: focusedPaneTabIds,
  });
  const focusedPaneTabDescriptorMap = useStableTabDescriptorMap(tabs);
  const { mountedTabIds: mountedFocusedPaneTabIdsSet } = useMountedTabSet({
    activeTabId,
    allTabIds: focusedPaneTabIds,
    retainedTabIds: modifiedFocusedPaneTabIds,
    cap: 3,
  });
  const mountedFocusedPaneTabIds = useMemo(
    () => focusedPaneTabIds.filter((tabId) => mountedFocusedPaneTabIdsSet.has(tabId)),
    [focusedPaneTabIds, mountedFocusedPaneTabIdsSet],
  );
  const buildMobilePaneContentModel = useCallback(
    function buildMobilePaneContentModel(input: {
      paneId: string | null;
      tab: WorkspaceTabDescriptor;
    }) {
      return buildPaneContentModel({
        tab: input.tab,
        paneId: input.paneId,
        focusPaneBeforeOpen: false,
      });
    },
    [buildPaneContentModel],
  );
  const content = renderWorkspaceContent({
    isMissingWorkspaceDirectory,
    activeTabDescriptor,
    hasHydratedAgents,
    mountedFocusedPaneTabIds,
    focusedPaneTabDescriptorMap,
    isRouteFocused,
    focusedPaneId,
    buildMobilePaneContentModel,
  });

  const buildDesktopPaneContentModel = useCallback(
    function buildDesktopPaneContentModel(input: { paneId: string; tab: WorkspaceTabDescriptor }) {
      return buildPaneContentModel({
        tab: input.tab,
        paneId: input.paneId,
        focusPaneBeforeOpen: true,
      });
    },
    [buildPaneContentModel],
  );

  const desktopTabRowItems = useMemo<WorkspaceDesktopTabRowItem[]>(
    () =>
      tabs.map((tab) => ({
        tab,
        isActive: tab.tabId === activeTabDescriptor?.tabId,
        isCloseHovered: hoveredCloseTabKey === tab.key,
        isClosingTab: closingTabIds.has(tab.tabId),
      })),
    [activeTabDescriptor?.tabId, closingTabIds, hoveredCloseTabKey, tabs],
  );

  const handleFocusPane = useStableEvent(function handleFocusPane(paneId: string) {
    if (!persistenceKey || paneFocusSuppressedRef.current) {
      return;
    }
    focusWorkspacePane(persistenceKey, paneId);
  });

  const handleSplitPane = useCallback(
    function handleSplitPane(input: {
      tabId: string;
      targetPaneId: string;
      position: "left" | "right" | "top" | "bottom";
    }) {
      if (!persistenceKey) {
        return;
      }
      splitWorkspacePane(persistenceKey, input);
    },
    [persistenceKey, splitWorkspacePane],
  );

  const handleMoveTabToPane = useCallback(
    function handleMoveTabToPane(tabId: string, toPaneId: string) {
      if (!persistenceKey) {
        return;
      }
      moveWorkspaceTabToPane(persistenceKey, tabId, toPaneId);
    },
    [moveWorkspaceTabToPane, persistenceKey],
  );

  const handleResizePaneSplit = useCallback(
    function handleResizePaneSplit(groupId: string, sizes: number[]) {
      if (!persistenceKey) {
        return;
      }
      resizeWorkspaceSplit(persistenceKey, groupId, sizes);
    },
    [persistenceKey, resizeWorkspaceSplit],
  );

  const handleReorderTabsInPane = useCallback(
    function handleReorderTabsInPane(paneId: string, tabIds: string[]) {
      if (!persistenceKey) {
        return;
      }
      reorderWorkspaceTabsInPane(persistenceKey, paneId, tabIds);
    },
    [persistenceKey, reorderWorkspaceTabsInPane],
  );

  const handleReorderTabsInFocusedPane = useCallback(
    (nextTabs: WorkspaceTabDescriptor[]) => {
      if (!focusedPaneId) {
        return;
      }
      handleReorderTabsInPane(
        focusedPaneId,
        nextTabs.map((tab) => tab.tabId),
      );
    },
    [focusedPaneId, handleReorderTabsInPane],
  );

  const renderSplitPaneEmptyState = useCallback(
    function renderSplitPaneEmptyState() {
      return (
        <View style={styles.emptyState}>
          <Text style={styles.emptyStateText}>{t("workspace.tabs.emptyPane")}</Text>
        </View>
      );
    },
    [t],
  );

  const containerStyle = [styles.container, styles.containerWorkspaceBackground];

  const workspaceScreenGate = renderWorkspaceRouteGate({
    state: workspaceRouteState,
    actions: {
      onRetryHost: handleRetryHost,
      onManageHost: handleManageHost,
      onDismissMissingWorkspace: handleDismissMissingWorkspace,
      onRecoverWorkspace: workspaceRecovery.restore,
      onRetryRecoveryInspection: workspaceRecovery.retryInspection,
    },
  });
  const gatedWorkspaceScreen = renderWorkspaceScreenGateShell({
    gate: workspaceScreenGate,
    workspaceKey: persistenceKey,
  });

  const headerRight = useMemo(
    () => (
      <View style={styles.headerRight}>
        {!isMobile && workspaceDescriptor && workspaceDescriptor.scripts.length > 0 ? (
          <WorkspaceScriptsButton
            serverId={normalizedServerId}
            workspaceId={normalizedWorkspaceId}
            scripts={workspaceDescriptor.scripts}
            liveTerminalIds={liveTerminalIds}
            onScriptTerminalStarted={handleScriptTerminalStarted}
            onViewTerminal={handleViewScriptTerminal}
            onOpenUrlInBrowserTab={handleOpenUrlInBrowserTab}
            hideLabels
          />
        ) : null}
        {!isMobile && workspaceDirectory ? (
          <WorkspaceOpenInEditorButton
            serverId={normalizedServerId}
            cwd={workspaceDirectory}
            activeFile={activeFileLocation}
            hideLabels
          />
        ) : null}
        {!isMobile && workspaceDirectory ? (
          <>
            <WorkspaceActions serverId={normalizedServerId} cwd={workspaceDirectory} />
            <HeaderToggleButton
              testID="workspace-explorer-toggle"
              onPress={handleToggleExplorer}
              tooltipLabel={t("workspace.tabs.explorer.toggle")}
              tooltipKeys={EXPLORER_TOGGLE_KEYS}
              tooltipSide="left"
              style={styles.compactHeaderActionButton}
              accessible
              accessibilityRole="button"
              accessibilityLabel={explorerToggleLabel}
              accessibilityState={explorerToggleAccessibilityState}
            >
              {({ hovered }) => {
                const colorMapping = hovered ? foregroundColorMapping : extraMutedColorMapping;
                return <ThemedPanelRight size={16} uniProps={colorMapping} />;
              }}
            </HeaderToggleButton>
          </>
        ) : null}
        {isMobile ? (
          <HeaderToggleButton
            testID="workspace-explorer-toggle"
            onPress={handleToggleExplorer}
            tooltipLabel={t("workspace.tabs.explorer.toggle")}
            tooltipKeys={EXPLORER_TOGGLE_KEYS}
            tooltipSide="left"
            style={styles.headerActionButton}
            accessible
            accessibilityRole="button"
            accessibilityLabel={explorerToggleLabel}
            accessibilityState={explorerToggleAccessibilityState}
          >
            {({ hovered }) => {
              const colorMapping = hovered ? foregroundColorMapping : mutedColorMapping;
              // Matches the ghost scripts Play icon in the same header (16 / 1.5).
              return <ThemedPanelRight size={16} strokeWidth={1.5} uniProps={colorMapping} />;
            }}
          </HeaderToggleButton>
        ) : null}
      </View>
    ),
    [
      isMobile,
      workspaceDescriptor,
      normalizedServerId,
      normalizedWorkspaceId,
      workspaceDirectory,
      activeFileLocation,
      liveTerminalIds,
      handleScriptTerminalStarted,
      handleViewScriptTerminal,
      handleOpenUrlInBrowserTab,
      handleToggleExplorer,
      explorerToggleLabel,
      explorerToggleAccessibilityState,
      t,
    ],
  );

  const showScreenHeader = useMemo(
    () => shouldShowWorkspaceScreenHeader({ isFocusModeEnabled, isMobile }),
    [isFocusModeEnabled, isMobile],
  );
  const showExplorerSidebar = useMemo(
    () => shouldShowWorkspaceExplorerSidebar({ isRouteFocused, isFocusModeEnabled, isMobile }),
    [isRouteFocused, isFocusModeEnabled, isMobile],
  );
  const createTerminalDisabled = useMemo(
    () => createTerminalMutation.isPending || pendingTerminalCreateInput !== null,
    [createTerminalMutation.isPending, pendingTerminalCreateInput],
  );
  const showCreateBrowserTab = getIsElectron();
  const focusedPaneIdOrUndefined = useMemo(() => focusedPaneId ?? undefined, [focusedPaneId]);
  const desktopFocusModeEnabled = useMemo(
    () => isFocusModeEnabled && !isMobile,
    [isFocusModeEnabled, isMobile],
  );
  const workspaceFloatingPanelPortalHostName = useMemo(
    () =>
      `${WORKSPACE_FLOATING_PANEL_PORTAL_HOST_PREFIX}:${normalizedServerId}:${normalizedWorkspaceId}`,
    [normalizedServerId, normalizedWorkspaceId],
  );
  const desktopSplitContent = useMemo(() => {
    if (!canRenderDesktopPaneSplits || !workspaceLayout || !persistenceKey) {
      return null;
    }
    return (
      <SplitContainer
        layout={workspaceLayout}
        focusModeEnabled={desktopFocusModeEnabled}
        onExitFocusMode={toggleFocusMode}
        workspaceKey={persistenceKey}
        normalizedServerId={normalizedServerId}
        normalizedWorkspaceId={normalizedWorkspaceId}
        isWorkspaceFocused={isRouteFocused}
        uiTabs={uiTabs}
        hoveredCloseTabKey={hoveredCloseTabKey}
        setHoveredCloseTabKey={setHoveredCloseTabKey}
        closingTabIds={closingTabIds}
        onNavigateTab={navigateToTabId}
        onCloseTab={handleCloseTabById}
        onCopyResumeCommand={handleCopyResumeCommand}
        onCopyAgentId={handleCopyAgentId}
        onCopyTerminalId={handleCopyTerminalId}
        onCopyFilePath={handleCopyFilePath}
        onReloadAgent={handleReloadAgent}
        onRenameTab={handleRenameTab}
        onCloseTabsToLeft={handleCloseTabsToLeftInPane}
        onCloseTabsToRight={handleCloseTabsToRightInPane}
        onCloseOtherTabs={handleCloseOtherTabsInPane}
        onCreateDraftTab={handleCreateDraftTab}
        onCreateTerminalTab={handleCreateTerminal}
        onCreateBrowserTab={handleCreateBrowserTab}
        showCreateBrowserTab={showCreateBrowserTab}
        buildPaneContentModel={buildDesktopPaneContentModel}
        onFocusPane={handleFocusPane}
        onSplitPane={handleSplitPane}
        onSplitPaneEmpty={handleCreateDraftSplit}
        onMoveTabToPane={handleMoveTabToPane}
        onResizeSplit={handleResizePaneSplit}
        onReorderTabsInPane={handleReorderTabsInPane}
        renderPaneEmptyState={renderSplitPaneEmptyState}
      />
    );
  }, [
    canRenderDesktopPaneSplits,
    workspaceLayout,
    persistenceKey,
    desktopFocusModeEnabled,
    toggleFocusMode,
    normalizedServerId,
    normalizedWorkspaceId,
    isRouteFocused,
    uiTabs,
    hoveredCloseTabKey,
    closingTabIds,
    navigateToTabId,
    handleCloseTabById,
    handleCopyResumeCommand,
    handleCopyAgentId,
    handleCopyTerminalId,
    handleCopyFilePath,
    handleReloadAgent,
    handleRenameTab,
    handleCloseTabsToLeftInPane,
    handleCloseTabsToRightInPane,
    handleCloseOtherTabsInPane,
    handleCreateDraftTab,
    handleCreateTerminal,
    handleCreateBrowserTab,
    showCreateBrowserTab,
    buildDesktopPaneContentModel,
    handleFocusPane,
    handleSplitPane,
    handleCreateDraftSplit,
    handleMoveTabToPane,
    handleResizePaneSplit,
    handleReorderTabsInPane,
    renderSplitPaneEmptyState,
  ]);
  const desktopContent = desktopSplitContent ?? content;

  const workspaceCenterColumn = (
    <View style={styles.centerColumn}>
      {showScreenHeader && (
        <ScreenHeader
          left={
            <>
              <SidebarMenuToggle />
              <WorkspaceHeaderTitleBar
                isLoading={isWorkspaceHeaderLoading}
                title={workspaceHeaderTitle}
                subtitle={workspaceHeaderSubtitle}
                isSubtitleDistinct={isWorkspaceHeaderSubtitleDistinct}
                currentBranchName={currentBranchName}
                normalizedServerId={normalizedServerId}
                normalizedWorkspaceId={normalizedWorkspaceId}
                workspaceScripts={workspaceScripts}
                liveTerminalIds={liveTerminalIds}
                showWorkspaceSetup={showWorkspaceSetup}
                showCreateBrowserTab={showCreateBrowserTab}
                isMobile={isMobile}
                createTerminalDisabled={createTerminalDisabled}
                importAgentDisabled={!canOpenImportSheet}
                copyPathDisabled={!workspaceDirectory}
                onCreateDraftTab={handleCreateDraftTab}
                onCreateTerminal={handleCreateTerminal}
                onCreateTerminalWithProfile={handleCreateTerminalWithProfile}
                onCreateBrowser={handleCreateBrowserTab}
                onOpenImportSheet={openImportSheet}
                onCopyWorkspacePath={handleCopyWorkspacePath}
                onCopyBranchName={handleCopyBranchName}
                onOpenSetupTab={handleOpenSetupTab}
                onScriptTerminalStarted={handleScriptTerminalStarted}
                onViewScriptTerminal={handleViewScriptTerminal}
                onOpenUrlInBrowserTab={handleOpenUrlInBrowserTab}
              />
            </>
          }
          right={headerRight}
        />
      )}

      {isMobile ? (
        <MobileWorkspaceTabSwitcher
          tabs={tabs}
          activeTabKey={activeTabKey}
          activeTab={activeTabDescriptor}
          tabSwitcherOptions={tabSwitcherOptions}
          tabByKey={tabByKey}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          onSelectSwitcherTab={handleSelectSwitcherTab}
          onCopyResumeCommand={handleCopyResumeCommand}
          onCopyAgentId={handleCopyAgentId}
          onCopyTerminalId={handleCopyTerminalId}
          onCopyFilePath={handleCopyFilePath}
          onReloadAgent={handleReloadAgent}
          onRenameTab={handleRenameTab}
          onCloseTab={handleCloseTabById}
          onCloseTabsAbove={handleCloseTabsToLeft}
          onCloseTabsBelow={handleCloseTabsToRight}
          onCloseOtherTabs={handleCloseOtherTabs}
        />
      ) : null}

      {shouldRenderDesktopPaneFallback ? (
        <WorkspaceDesktopTabsRow
          paneId={focusedPaneIdOrUndefined}
          isFocused={isRouteFocused}
          tabs={desktopTabRowItems}
          normalizedServerId={normalizedServerId}
          normalizedWorkspaceId={normalizedWorkspaceId}
          setHoveredCloseTabKey={setHoveredCloseTabKey}
          onNavigateTab={navigateToTabId}
          onCloseTab={handleCloseTabById}
          onCopyResumeCommand={handleCopyResumeCommand}
          onCopyAgentId={handleCopyAgentId}
          onCopyTerminalId={handleCopyTerminalId}
          onCopyFilePath={handleCopyFilePath}
          onReloadAgent={handleReloadAgent}
          onRenameTab={handleRenameTab}
          onCloseTabsToLeft={handleCloseTabsToLeft}
          onCloseTabsToRight={handleCloseTabsToRight}
          onCloseOtherTabs={handleCloseOtherTabs}
          onCreateDraftTab={handleCreateDraftTab}
          onCreateTerminalTab={handleCreateTerminal}
          onCreateBrowserTab={handleCreateBrowserTab}
          showCreateBrowserTab={showCreateBrowserTab}
          disableCreateTerminal={createTerminalMutation.isPending}
          isWaitingOnTerminalReadiness={pendingTerminalCreateInput !== null}
          onReorderTabs={handleReorderTabsInFocusedPane}
          focusModeEnabled={desktopFocusModeEnabled}
          onExitFocusMode={toggleFocusMode}
        />
      ) : null}

      <View style={styles.centerContent}>
        {isMobile ? (
          <View style={styles.content}>{content}</View>
        ) : (
          <View style={styles.content}>{desktopContent}</View>
        )}
      </View>
    </View>
  );

  return (
    gatedWorkspaceScreen ?? (
      <WorkspaceFocusProvider workspaceKey={persistenceKey}>
        <RenderProfile id="WorkspaceScreenContent">
          <View style={containerStyle}>
            <WorkspaceDocumentTitleEffectSlot
              tab={activeTabDescriptor}
              serverId={normalizedServerId}
              workspaceId={normalizedWorkspaceId}
              isRouteFocused={isRouteFocused}
            />
            <WorkspaceChromeRow
              portalHostName={workspaceFloatingPanelPortalHostName}
              showExplorerSidebar={showExplorerSidebar}
              explorerOpen={isExplorerOpen}
              serverId={normalizedServerId}
              workspaceId={normalizedWorkspaceId}
              workspaceRoot={workspaceDirectory}
              isGit={isGitCheckout}
              onOpenFile={handleOpenFileFromExplorer}
            >
              {workspaceCenterColumn}
            </WorkspaceChromeRow>
            <ImportSessionSheet
              visible={isRouteFocused && isImportSheetVisible}
              client={client}
              serverId={normalizedServerId}
              cwd={workspaceDirectory}
              workspaceId={normalizedWorkspaceId}
              onClose={closeImportSheet}
              onImportedAgent={handleImportedAgent}
            />
            <WorkspaceTabRenameModal
              renamingTab={isRouteFocused ? renamingTab : null}
              onSubmit={handleRenameModalSubmit}
              onClose={handleRenameModalClose}
            />
          </View>
        </RenderProfile>
      </WorkspaceFocusProvider>
    )
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  containerWorkspaceBackground: {
    backgroundColor: theme.colors.surfaceWorkspace,
  },
  threePaneRow: {
    flex: 1,
    minHeight: 0,
    flexDirection: "row",
    alignItems: "stretch",
  },
  centerColumn: {
    flex: 1,
    minHeight: 0,
  },
  headerTitleContainer: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: {
      xs: theme.spacing[1],
      md: theme.spacing[2],
    },
    overflow: "hidden",
  },
  headerTitleTextGroup: {
    minWidth: 0,
    overflow: "hidden",
    flexShrink: 1,
    flexGrow: {
      xs: 1,
      md: 0,
    },
    flexDirection: {
      xs: "column",
      md: "row",
    },
    alignItems: {
      xs: "flex-start",
      md: "center",
    },
    justifyContent: "flex-start",
    gap: {
      xs: 0,
      md: theme.spacing[2],
    },
  },
  // No width cap. A percentage cap resolves against the title group, whose own width comes from
  // this row's content, so it clips the project name while there is still room beside it.
  // `flexShrink` on both this row and the title already gives up space only when there is none.
  headerProjectRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    minWidth: 0,
    flexShrink: 1,
  },
  headerProjectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: {
      xs: theme.fontSize.sm,
      md: theme.fontSize.base,
    },
    flexShrink: 1,
    minWidth: 0,
  },
  headerProjectSeparator: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 0,
  },
  headerTitleSkeleton: {
    width: 220,
    maxWidth: "100%",
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.25,
  },
  headerRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: {
      xs: theme.spacing[1],
      md: theme.spacing[2],
    },
  },
  headerActionButton: {
    paddingVertical: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
  },
  compactHeaderActionButton: {
    width: {
      xs: theme.spacing[8],
      md: buttonControlHeight.xs,
    },
    height: {
      xs: theme.spacing[8],
      md: buttonControlHeight.xs,
    },
    padding: 0,
    borderRadius: theme.borderRadius.lg,
    alignItems: "center",
    justifyContent: "center",
  },
  compactHeaderMenuCluster: {
    flexDirection: "row",
    alignItems: "center",
    gap: {
      xs: 0,
      md: theme.spacing[2],
    },
  },
  newTabActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  newTabActionButton: {
    width: 30,
    height: 30,
    borderRadius: theme.borderRadius.md,
    borderWidth: theme.borderWidth[1],
    borderColor: theme.colors.border,
    backgroundColor: theme.colors.surface1,
    alignItems: "center",
    justifyContent: "center",
  },
  newTabActionButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  newTabTooltipText: {
    fontSize: theme.fontSize.base,
    color: theme.colors.popoverForeground,
  },
  newTabTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  newTabTooltipShortcut: {},
  mobileTabsRow: {
    backgroundColor: theme.colors.surface0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
  },
  switcherTrigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2] + theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  switcherTriggerPressed: {
    backgroundColor: theme.colors.surface1,
  },
  switcherTriggerLeft: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  switcherTriggerIcon: {
    flexShrink: 0,
  },
  switcherTriggerText: {
    minWidth: 0,
    flex: 1,
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  headerMenuProfileIconWrapper: {
    width: 16,
    height: 16,
  },
  tabsContainer: {
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.surface0,
    flexDirection: "row",
    alignItems: "center",
  },
  tabsScroll: {
    flex: 1,
    minWidth: 0,
  },
  tabsContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  tabsActions: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingRight: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  centerContent: {
    flex: 1,
    minHeight: 0,
  },
  tab: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    maxWidth: 260,
  },
  tabHandle: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    flex: 1,
    minWidth: 0,
  },
  tabIcon: {
    flexShrink: 0,
  },
  tabActive: {
    backgroundColor: theme.colors.surface2,
  },
  tabHovered: {
    backgroundColor: theme.colors.surface2,
  },
  tabLabel: {
    flexShrink: 1,
    minWidth: 0,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  tabLabelWithCloseButton: {
    paddingRight: 0,
  },
  tabLabelActive: {
    color: theme.colors.foreground,
  },
  tabCloseButton: {
    width: 18,
    height: 18,
    marginLeft: 0,
    borderRadius: theme.borderRadius.sm,
    alignItems: "center",
    justifyContent: "center",
  },
  tabCloseButtonShown: {
    opacity: 1,
  },
  tabCloseButtonHidden: {
    opacity: 0,
  },
  tabCloseButtonActive: {
    backgroundColor: theme.colors.surface3,
  },
  content: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
    position: "relative",
  },
  mobileMountedTabSlot: {
    ...StyleSheet.absoluteFillObject,
  },
  contentPlaceholder: {
    flex: 1,
    minHeight: 0,
    backgroundColor: theme.colors.surface0,
  },
  emptyState: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[3],
    paddingHorizontal: theme.spacing[6],
  },
  emptyStateText: {
    color: theme.colors.foregroundMuted,
    textAlign: "center",
  },
}));

const EXPLORER_TOGGLE_KEYS: ShortcutKey[] = ["mod", "E"];
