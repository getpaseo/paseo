import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useIsFocused } from "@react-navigation/native";
import {
  ActivityIndicator,
  BackHandler,
  Keyboard,
  Platform,
  Pressable,
  Text,
  View,
} from "react-native";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import {
  CopyX,
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  Copy,
  Ellipsis,
  EllipsisVertical,
  PanelRight,
  RotateCw,
  SquarePen,
  SquareTerminal,
  X,
} from "lucide-react-native";
import { GestureDetector } from "react-native-gesture-handler";
import Animated from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { StyleSheet, useUnistyles } from "react-native-unistyles";
import invariant from "tiny-invariant";
import { SidebarMenuToggle } from "@/components/headers/menu-header";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import { ScreenHeader } from "@/components/headers/screen-header";
import { BranchSwitcher } from "@/components/branch-switcher";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Shortcut } from "@/components/ui/shortcut";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExplorerSidebar } from "@/components/explorer-sidebar";
import { SplitContainer } from "@/components/split-container";
import { SourceControlPanelIcon } from "@/components/icons/source-control-panel-icon";
import { WorkspaceGitActions } from "@/screens/workspace/workspace-git-actions";
import { WorkspaceOpenInEditorButton } from "@/screens/workspace/workspace-open-in-editor-button";
import { ExplorerSidebarAnimationProvider } from "@/contexts/explorer-sidebar-animation-context";
import { useToast } from "@/contexts/toast-context";
import { useExplorerOpenGesture } from "@/hooks/use-explorer-open-gesture";
import { usePanelStore, type ExplorerCheckoutContext } from "@/stores/panel-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildWorkspaceTabPersistenceKey,
  collectAllTabs,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store";
import type { WorkspaceTab, WorkspaceTabTarget } from "@/stores/workspace-tabs-store";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { KeyboardActionDefinition } from "@/keyboard/keyboard-action-dispatcher";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import { decodeWorkspaceIdFromPathSegment } from "@/utils/host-routes";
import { isAbsolutePath } from "@/utils/path";
import { normalizeWorkspaceIdentity } from "@/utils/workspace-identity";
import {
  normalizeWorkspaceTabTarget,
  workspaceTabTargetsEqual,
} from "@/utils/workspace-tab-identity";
import { useHostRuntimeClient, useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import { useWorkspaceTerminalSessionRetention } from "@/terminal/hooks/use-workspace-terminal-session-retention";
import {
  checkoutStatusQueryKey,
  type CheckoutStatusPayload,
} from "@/hooks/use-checkout-status-query";
import type { ListTerminalsResponse } from "@server/shared/messages";
import { upsertTerminalListEntry } from "@/utils/terminal-list";
import { confirmDialog } from "@/utils/confirm-dialog";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useStableEvent } from "@/hooks/use-stable-event";
import { buildProviderCommand } from "@/utils/provider-command-templates";
import { generateDraftId } from "@/stores/draft-keys";
import {
  WorkspaceTabPresentationResolver,
  WorkspaceTabIcon,
  WorkspaceTabOptionRow,
} from "@/screens/workspace/workspace-tab-presentation";
import {
  WorkspaceDesktopTabsRow,
  type WorkspaceDesktopTabRowItem,
} from "@/screens/workspace/workspace-desktop-tabs-row";
import { buildWorkspaceTabMenuEntries } from "@/screens/workspace/workspace-tab-menu";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  resolveWorkspaceHeader,
  shouldRenderMissingWorkspaceDescriptor,
} from "@/screens/workspace/workspace-header-source";
import {
  deriveWorkspaceAgentVisibility,
  shouldPruneWorkspaceAgentTab,
  workspaceAgentVisibilityEqual,
} from "@/screens/workspace/workspace-agent-visibility";
import { deriveWorkspacePaneState } from "@/screens/workspace/workspace-pane-state";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
  type WorkspacePaneContentModel,
} from "@/screens/workspace/workspace-pane-content";
import { useMountedTabSet } from "@/screens/workspace/use-mounted-tab-set";
import {
  buildBulkCloseConfirmationMessage,
  classifyBulkClosableTabs,
  closeBulkWorkspaceTabs,
} from "@/screens/workspace/workspace-bulk-close";
import { findAdjacentPane } from "@/utils/split-navigation";
import { useIsCompactFormFactor, supportsDesktopPaneSplits } from "@/constants/layout";

const TERMINALS_QUERY_STALE_TIME = 5_000;
const NEW_TAB_AGENT_OPTION_ID = "__new_tab_agent__";
const NEW_TAB_TERMINAL_OPTION_ID = "__new_tab_terminal__";
type NewTabOptionId = typeof NEW_TAB_AGENT_OPTION_ID | typeof NEW_TAB_TERMINAL_OPTION_ID;
const EMPTY_UI_TABS: WorkspaceTab[] = [];
const EMPTY_PINNED_AGENT_IDS = new Set<string>();
const EMPTY_SET = new Set<string>();

type WorkspaceScreenProps = {
  serverId: string;
  workspaceId: string;
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

function getFallbackTabOptionLabel(tab: WorkspaceTabDescriptor): string {
  if (tab.target.kind === "draft") {
    return "New Agent";
  }
  if (tab.target.kind === "terminal") {
    return "Terminal";
  }
  if (tab.target.kind === "file") {
    return tab.target.path.split("/").filter(Boolean).pop() ?? tab.target.path;
  }
  return "Agent";
}

function getFallbackTabOptionDescription(tab: WorkspaceTabDescriptor): string {
  if (tab.target.kind === "draft") {
    return "New Agent";
  }
  if (tab.target.kind === "agent") {
    return "Agent";
  }
  if (tab.target.kind === "terminal") {
    return "Terminal";
  }
  return tab.target.path;
}

type MobileWorkspaceTabSwitcherProps = {
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
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCloseTabsAbove: (tabId: string) => Promise<void> | void;
  onCloseTabsBelow: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
};

function MobileActiveTabTrigger({
  activeTab,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  activeTab: WorkspaceTabDescriptor | null;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  if (!activeTab) {
    return null;
  }

  return (
    <ResolvedMobileActiveTabTrigger
      activeTab={activeTab}
      normalizedServerId={normalizedServerId}
      normalizedWorkspaceId={normalizedWorkspaceId}
    />
  );
}

function ResolvedMobileActiveTabTrigger({
  activeTab,
  normalizedServerId,
  normalizedWorkspaceId,
}: {
  activeTab: WorkspaceTabDescriptor;
  normalizedServerId: string;
  normalizedWorkspaceId: string;
}) {
  return (
    <WorkspaceTabPresentationResolver
      tab={activeTab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => (
        <>
          <View style={styles.switcherTriggerIcon} testID="workspace-active-tab-icon">
            <WorkspaceTabIcon presentation={presentation} active />
          </View>

          <Text style={styles.switcherTriggerText} numberOfLines={1}>
            {presentation.titleState === "loading" ? "Loading..." : presentation.label}
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
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined") {
      return;
    }
    const resolvedLabel = label.trim();
    document.title = titleState === "loading" ? "Loading..." : resolvedLabel || "Workspace";
  }, [label, titleState]);

  return null;
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
  onReloadAgent,
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
  onReloadAgent: (agentId: string) => Promise<void> | void;
  onCloseTab: (tabId: string) => Promise<void> | void;
  onCloseTabsAbove: (tabId: string) => Promise<void> | void;
  onCloseTabsBelow: (tabId: string) => Promise<void> | void;
  onCloseOtherTabs: (tabId: string) => Promise<void> | void;
}) {
  const { theme } = useUnistyles();
  const menuTestIDBase = `workspace-tab-menu-${tab.key}`;
  const menuEntries = buildWorkspaceTabMenuEntries({
    surface: "mobile",
    tab,
    index: tabIndex,
    tabCount,
    menuTestIDBase,
    onCopyResumeCommand,
    onCopyAgentId,
    onReloadAgent,
    onCloseTab,
    onCloseTabsBefore: onCloseTabsAbove,
    onCloseTabsAfter: onCloseTabsBelow,
    onCloseOtherTabs,
  });

  return (
    <WorkspaceTabPresentationResolver
      tab={tab}
      serverId={normalizedServerId}
      workspaceId={normalizedWorkspaceId}
    >
      {(presentation) => (
        <WorkspaceTabOptionRow
          presentation={presentation}
          selected={selected}
          active={active}
          onPress={onPress}
          trailingAccessory={
            <DropdownMenu>
              <DropdownMenuTrigger
                testID={`${menuTestIDBase}-trigger`}
                accessibilityRole="button"
                accessibilityLabel={`Open menu for ${presentation.label}`}
                hitSlop={8}
                style={({ open, pressed }) => [
                  styles.mobileTabMenuTrigger,
                  (open || pressed) && styles.mobileTabMenuTriggerActive,
                ]}
              >
                <Ellipsis size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
              </DropdownMenuTrigger>
              <DropdownMenuContent side="bottom" align="end" width={220} testID={menuTestIDBase}>
                {menuEntries.map((entry) =>
                  entry.kind === "separator" ? (
                    <DropdownMenuSeparator key={entry.key} />
                  ) : (
                    <DropdownMenuItem
                      key={entry.key}
                      testID={entry.testID}
                      disabled={entry.disabled}
                      destructive={entry.destructive}
                      onSelect={entry.onSelect}
                      tooltip={entry.tooltip}
                      leading={(() => {
                        const iconColor = theme.colors.foregroundMuted;
                        switch (entry.icon) {
                          case "copy":
                            return <Copy size={16} color={iconColor} />;
                          case "rotate-cw":
                            return <RotateCw size={16} color={iconColor} />;
                          case "arrow-left-to-line":
                            return <ArrowLeftToLine size={16} color={iconColor} />;
                          case "arrow-right-to-line":
                            return <ArrowRightToLine size={16} color={iconColor} />;
                          case "copy-x":
                            return <CopyX size={16} color={iconColor} />;
                          case "x":
                            return <X size={16} color={iconColor} />;
                          default:
                            return undefined;
                        }
                      })()}
                      trailing={
                        entry.hint ? (
                          <Text style={styles.menuItemHint}>{entry.hint}</Text>
                        ) : undefined
                      }
                    >
                      {entry.label}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          }
        />
      )}
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
  onReloadAgent,
  onCloseTab,
  onCloseTabsAbove,
  onCloseTabsBelow,
  onCloseOtherTabs,
}: MobileWorkspaceTabSwitcherProps) {
  const { theme } = useUnistyles();
  const [isOpen, setIsOpen] = useState(false);
  const anchorRef = useRef<View>(null);
  const tabIndexByKey = useMemo(() => {
    const map = new Map<string, number>();
    tabs.forEach((tab, index) => {
      map.set(tab.key, index);
    });
    return map;
  }, [tabs]);

  return (
    <View style={styles.mobileTabsRow} testID="workspace-tabs-row">
      <Pressable
        ref={anchorRef}
        testID="workspace-tab-switcher-trigger"
        accessibilityRole="button"
        accessibilityLabel={`Switch tabs (${tabs.length} open)`}
        style={({ pressed }) => [styles.switcherTrigger, pressed && styles.switcherTriggerPressed]}
        onPress={() => {
          Keyboard.dismiss();
          setIsOpen(true);
        }}
      >
        <View style={styles.switcherTriggerLeft}>
          <MobileActiveTabTrigger
            activeTab={activeTab}
            normalizedServerId={normalizedServerId}
            normalizedWorkspaceId={normalizedWorkspaceId}
          />
        </View>
        <ChevronDown size={theme.iconSize.sm} color={theme.colors.foregroundMuted} />
      </Pressable>

      <Combobox
        options={tabSwitcherOptions}
        value={activeTabKey}
        onSelect={onSelectSwitcherTab}
        searchable={false}
        title="Switch tab"
        searchPlaceholder="Search tabs"
        open={isOpen}
        onOpenChange={setIsOpen}
        enableDismissOnClose={false}
        anchorRef={anchorRef}
        renderOption={({ option, selected, active, onPress }) => {
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
              onReloadAgent={onReloadAgent}
              onCloseTab={onCloseTab}
              onCloseTabsAbove={onCloseTabsAbove}
              onCloseTabsBelow={onCloseTabsBelow}
              onCloseOtherTabs={onCloseOtherTabs}
            />
          );
        }}
      />
    </View>
  );
});

interface MobileMountedTabSlotProps {
  tabDescriptor: WorkspaceTabDescriptor;
  isVisible: boolean;
  isPaneFocused: boolean;
  paneId: string | null;
  buildPaneContentModel: (input: {
    paneId: string | null;
    isPaneFocused: boolean;
    tab: WorkspaceTabDescriptor;
  }) => WorkspacePaneContentModel;
}

const MobileMountedTabSlot = memo(function MobileMountedTabSlot({
  tabDescriptor,
  isVisible,
  isPaneFocused,
  paneId,
  buildPaneContentModel,
}: MobileMountedTabSlotProps) {
  const content = useMemo(
    () =>
      buildPaneContentModel({
        paneId,
        isPaneFocused,
        tab: tabDescriptor,
      }),
    [buildPaneContentModel, isPaneFocused, paneId, tabDescriptor],
  );

  return (
    <View style={{ display: isVisible ? "flex" : "none", flex: 1 }}>
      <WorkspacePaneContent content={content} />
    </View>
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

export function WorkspaceScreen({ serverId, workspaceId }: WorkspaceScreenProps) {
  const isFocused = useIsFocused();

  if (!isFocused) {
    return <View style={{ flex: 1 }} />;
  }

  return (
    <ExplorerSidebarAnimationProvider>
      <WorkspaceScreenContent serverId={serverId} workspaceId={workspaceId} />
    </ExplorerSidebarAnimationProvider>
  );
}

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

function WorkspaceScreenContent({ serverId, workspaceId }: WorkspaceScreenProps) {
  const { theme } = useUnistyles();
  const insets = useSafeAreaInsets();
  const mainBackgroundColor = theme.colors.surfaceWorkspace;
  const toast = useToast();
  const isMobile = useIsCompactFormFactor();
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);

  const normalizedServerId = trimNonEmpty(decodeSegment(serverId)) ?? "";
  const normalizedWorkspaceId =
    normalizeWorkspaceIdentity(decodeWorkspaceIdFromPathSegment(workspaceId)) ?? "";
  const workspaceTerminalScopeKey =
    normalizedServerId && normalizedWorkspaceId
      ? `${normalizedServerId}:${normalizedWorkspaceId}`
      : null;
  useWorkspaceTerminalSessionRetention({
    scopeKey: workspaceTerminalScopeKey,
  });

  const queryClient = useQueryClient();
  const client = useHostRuntimeClient(normalizedServerId);
  const isConnected = useHostRuntimeIsConnected(normalizedServerId);

  const workspaceAgentVisibility = useStoreWithEqualityFn(
    useSessionStore,
    (state) =>
      deriveWorkspaceAgentVisibility({
        sessionAgents: state.sessions[normalizedServerId]?.agents,
        workspaceId: normalizedWorkspaceId,
      }),
    workspaceAgentVisibilityEqual,
  );

  const terminalsQueryKey = useMemo(
    () => ["terminals", normalizedServerId, normalizedWorkspaceId] as const,
    [normalizedServerId, normalizedWorkspaceId],
  );
  type ListTerminalsPayload = ListTerminalsResponse["payload"];
  const terminalsQuery = useQuery({
    queryKey: terminalsQueryKey,
    enabled:
      Boolean(client && isConnected) &&
      normalizedWorkspaceId.length > 0 &&
      isAbsolutePath(normalizedWorkspaceId),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.listTerminals(normalizedWorkspaceId);
    },
    staleTime: TERMINALS_QUERY_STALE_TIME,
  });
  const terminals = terminalsQuery.data?.terminals ?? [];
  const createTerminalMutation = useMutation({
    mutationFn: async (input?: { paneId?: string }) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return await client.createTerminal(normalizedWorkspaceId);
    },
    onSuccess: (payload, input) => {
      const createdTerminal = payload.terminal;
      if (createdTerminal) {
        queryClient.setQueryData<ListTerminalsPayload>(terminalsQueryKey, (current) => {
          const nextTerminals = upsertTerminalListEntry({
            terminals: current?.terminals ?? [],
            terminal: createdTerminal,
          });
          return {
            cwd: current?.cwd ?? normalizedWorkspaceId,
            terminals: nextTerminals,
            requestId: current?.requestId ?? `terminal-create-${createdTerminal.id}`,
          };
        });
      }

      void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
      if (createdTerminal) {
        const workspaceKey = buildWorkspaceTabPersistenceKey({
          serverId: normalizedServerId,
          workspaceId: normalizedWorkspaceId,
        });
        if (!workspaceKey) {
          return;
        }
        if (input?.paneId) {
          focusWorkspacePane(workspaceKey, input.paneId);
        }
        const tabId = useWorkspaceLayoutStore
          .getState()
          .openTab(workspaceKey, { kind: "terminal", terminalId: createdTerminal.id });
        if (tabId) {
          useWorkspaceLayoutStore.getState().focusTab(workspaceKey, tabId);
        }
      }
    },
  });
  const killTerminalMutation = useMutation({
    mutationFn: async (terminalId: string) => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      const payload = await client.killTerminal(terminalId);
      if (!payload.success) {
        throw new Error("Unable to close terminal");
      }
      return payload;
    },
  });
  const { archiveAgent } = useArchiveAgent();

  useEffect(() => {
    if (!client || !isConnected || !isAbsolutePath(normalizedWorkspaceId)) {
      return;
    }

    const unsubscribeChanged = client.on("terminals_changed", (message) => {
      if (message.type !== "terminals_changed") {
        return;
      }
      if (message.payload.cwd !== normalizedWorkspaceId) {
        return;
      }

      queryClient.setQueryData<ListTerminalsPayload>(terminalsQueryKey, (current) => ({
        cwd: message.payload.cwd,
        terminals: message.payload.terminals,
        requestId: current?.requestId ?? `terminals-changed-${Date.now()}`,
      }));
    });

    client.subscribeTerminals({ cwd: normalizedWorkspaceId });

    return () => {
      unsubscribeChanged();
      client.unsubscribeTerminals({ cwd: normalizedWorkspaceId });
    };
  }, [client, isConnected, normalizedWorkspaceId, queryClient, terminalsQueryKey]);

  const checkoutQuery = useQuery({
    queryKey: checkoutStatusQueryKey(normalizedServerId, normalizedWorkspaceId),
    enabled:
      Boolean(client && isConnected) &&
      normalizedWorkspaceId.length > 0 &&
      isAbsolutePath(normalizedWorkspaceId),
    queryFn: async () => {
      if (!client) {
        throw new Error("Host is not connected");
      }
      return (await client.getCheckoutStatus(normalizedWorkspaceId)) as CheckoutStatusPayload;
    },
    staleTime: 15_000,
  });

  const workspaceDescriptor = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.workspaces.get(normalizedWorkspaceId) ?? null,
  );
  const hasHydratedWorkspaces = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedWorkspaces ?? false,
  );
  const hasHydratedAgents = useSessionStore(
    (state) => state.sessions[normalizedServerId]?.hasHydratedAgents ?? false,
  );
  const workspaceHeader = workspaceDescriptor
    ? resolveWorkspaceHeader({ workspace: workspaceDescriptor })
    : null;
  const isWorkspaceHeaderLoading = workspaceHeader === null;

  const isGitCheckout = checkoutQuery.data?.isGit ?? false;
  const currentBranchName =
    checkoutQuery.data?.isGit && checkoutQuery.data.currentBranch !== "HEAD"
      ? trimNonEmpty(checkoutQuery.data.currentBranch)
      : null;

  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const toggleFileExplorer = usePanelStore((state) => state.toggleFileExplorer);
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer);
  const activateExplorerTabForCheckout = usePanelStore(
    (state) => state.activateExplorerTabForCheckout,
  );
  const closeToAgent = usePanelStore((state) => state.closeToAgent);
  const setActiveExplorerCheckout = usePanelStore((state) => state.setActiveExplorerCheckout);

  const isExplorerOpen = isMobile ? mobileView === "file-explorer" : desktopFileExplorerOpen;

  const activeExplorerCheckout = useMemo<ExplorerCheckoutContext | null>(() => {
    if (!normalizedServerId || !isAbsolutePath(normalizedWorkspaceId)) {
      return null;
    }
    return {
      serverId: normalizedServerId,
      cwd: normalizedWorkspaceId,
      isGit: isGitCheckout,
    };
  }, [isGitCheckout, normalizedServerId, normalizedWorkspaceId]);

  useEffect(() => {
    setActiveExplorerCheckout(activeExplorerCheckout);
  }, [activeExplorerCheckout, setActiveExplorerCheckout]);

  const openExplorerForWorkspace = useCallback(() => {
    if (!activeExplorerCheckout) {
      return;
    }
    activateExplorerTabForCheckout(activeExplorerCheckout);
    openFileExplorer();
  }, [activateExplorerTabForCheckout, activeExplorerCheckout, openFileExplorer]);

  const handleToggleExplorer = useCallback(() => {
    if (isExplorerOpen) {
      toggleFileExplorer();
      return;
    }
    openExplorerForWorkspace();
  }, [isExplorerOpen, openExplorerForWorkspace, toggleFileExplorer]);

  const explorerOpenGesture = useExplorerOpenGesture({
    enabled: isMobile && mobileView === "agent",
    onOpen: openExplorerForWorkspace,
  });

  useEffect(() => {
    if (Platform.OS === "web" || !isExplorerOpen) {
      return;
    }

    const handler = BackHandler.addEventListener("hardwareBackPress", () => {
      if (isExplorerOpen) {
        closeToAgent();
        return true;
      }
      return false;
    });

    return () => handler.remove();
  }, [closeToAgent, isExplorerOpen]);

  const persistenceKey = useMemo(
    () =>
      buildWorkspaceTabPersistenceKey({
        serverId: normalizedServerId,
        workspaceId: normalizedWorkspaceId,
      }),
    [normalizedServerId, normalizedWorkspaceId],
  );

  const workspaceLayout = useWorkspaceLayoutStore((state) =>
    persistenceKey ? (state.layoutByWorkspace[persistenceKey] ?? null) : null,
  );
  const uiTabs = useMemo(
    () => (workspaceLayout ? collectAllTabs(workspaceLayout.root) : EMPTY_UI_TABS),
    [workspaceLayout],
  );
  const openWorkspaceTab = useWorkspaceLayoutStore((state) => state.openTab);
  const focusWorkspaceTab = useWorkspaceLayoutStore((state) => state.focusTab);
  const closeWorkspaceTab = useWorkspaceLayoutStore((state) => state.closeTab);
  const unpinWorkspaceAgent = useWorkspaceLayoutStore((state) => state.unpinAgent);
  const hideWorkspaceAgent = useWorkspaceLayoutStore((state) => state.hideAgent);
  const retargetWorkspaceTab = useWorkspaceLayoutStore((state) => state.retargetTab);
  const splitWorkspacePane = useWorkspaceLayoutStore((state) => state.splitPane);
  const splitWorkspacePaneEmpty = useWorkspaceLayoutStore((state) => state.splitPaneEmpty);
  const moveWorkspaceTabToPane = useWorkspaceLayoutStore((state) => state.moveTabToPane);
  const focusWorkspacePane = useWorkspaceLayoutStore((state) => state.focusPane);
  const paneFocusSuppressedRef = useRef(false);
  const resizeWorkspaceSplit = useWorkspaceLayoutStore((state) => state.resizeSplit);
  const reorderWorkspaceTabsInPane = useWorkspaceLayoutStore((state) => state.reorderTabsInPane);
  const pinnedAgentIds = useWorkspaceLayoutStore((state) =>
    persistenceKey
      ? (state.pinnedAgentIdsByWorkspace[persistenceKey] ?? EMPTY_PINNED_AGENT_IDS)
      : EMPTY_PINNED_AGENT_IDS,
  );
  const hiddenAgentIds = useWorkspaceLayoutStore((state) =>
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
  const setFocusedAgentId = useSessionStore((state) => state.setFocusedAgentId);
  const focusedPaneAgentId = useMemo(() => {
    const target = focusedPaneTabState.activeTab?.descriptor.target;
    if (target?.kind !== "agent") {
      return null;
    }
    return target.agentId;
  }, [focusedPaneTabState.activeTab]);

  useEffect(() => {
    setFocusedAgentId(normalizedServerId, focusedPaneAgentId);
  }, [focusedPaneAgentId, normalizedServerId, setFocusedAgentId]);

  useEffect(() => {
    return () => {
      setFocusedAgentId(normalizedServerId, null);
    };
  }, [normalizedServerId, setFocusedAgentId]);

  const ensureWorkspaceTab = useCallback(
    function ensureWorkspaceTab(target: WorkspaceTabTarget): string | null {
      if (!persistenceKey) {
        return null;
      }

      const normalizedTarget = normalizeWorkspaceTabTarget(target);
      if (!normalizedTarget) {
        return null;
      }

      const existingTab =
        uiTabs.find((tab) => workspaceTabTargetsEqual(tab.target, normalizedTarget)) ?? null;
      if (existingTab) {
        return existingTab.tabId;
      }

      const previousFocusedTabId = focusedPaneTabState.activeTabId;
      const tabId = openWorkspaceTab(persistenceKey, normalizedTarget);
      if (tabId && previousFocusedTabId && previousFocusedTabId !== tabId) {
        focusWorkspaceTab(persistenceKey, previousFocusedTabId);
      }
      return tabId;
    },
    [focusWorkspaceTab, focusedPaneTabState, openWorkspaceTab, persistenceKey, uiTabs],
  );

  const openWorkspaceDraftTab = useCallback(
    function openWorkspaceDraftTab(input?: { draftId?: string; focus?: boolean }) {
      if (!persistenceKey) {
        return null;
      }

      const target = normalizeWorkspaceTabTarget({
        kind: "draft",
        draftId: trimNonEmpty(input?.draftId) ?? generateDraftId(),
      });
      invariant(target?.kind === "draft", "Draft tab target must be valid");
      if (input?.focus === false) {
        return ensureWorkspaceTab(target);
      }

      const tabId = openWorkspaceTab(persistenceKey, target);
      if (tabId) {
        focusWorkspaceTab(persistenceKey, tabId);
      }
      return tabId;
    },
    [ensureWorkspaceTab, focusWorkspaceTab, openWorkspaceTab, persistenceKey],
  );

  useEffect(() => {
    if (!normalizedServerId || !normalizedWorkspaceId || !persistenceKey) {
      return;
    }

    const terminalIds = new Set(terminals.map((terminal) => terminal.id));
    const hasActivePendingDraftCreateInWorkspace = uiTabs.some((tab) => {
      if (tab.target.kind !== "draft") {
        return false;
      }
      const pending = pendingByDraftId[tab.target.draftId];
      return pending?.serverId === normalizedServerId && pending.lifecycle === "active";
    });

    for (const agentId of workspaceAgentVisibility.activeAgentIds) {
      if (hiddenAgentIds.has(agentId)) {
        continue;
      }
      const representedByTarget = uiTabs.some(
        (tab) => tab.target.kind === "agent" && tab.target.agentId === agentId,
      );
      const representedByDeterministicTabId = uiTabs.some(
        (tab) => tab.tabId === `agent_${agentId}`,
      );
      if (
        hasActivePendingDraftCreateInWorkspace &&
        !representedByTarget &&
        !representedByDeterministicTabId
      ) {
        continue;
      }
      ensureWorkspaceTab({ kind: "agent", agentId });
    }
    for (const terminal of terminals) {
      ensureWorkspaceTab({ kind: "terminal", terminalId: terminal.id });
    }

    const canPruneAgentTabs = hasHydratedAgents;
    const canPruneTerminalTabs = terminalsQuery.isSuccess;
    for (const tab of uiTabs) {
      if (
        canPruneAgentTabs &&
        tab.target.kind === "agent" &&
        !pinnedAgentIds.has(tab.target.agentId) &&
        shouldPruneWorkspaceAgentTab({
          agentId: tab.target.agentId,
          agentsHydrated: hasHydratedAgents,
          knownAgentIds: workspaceAgentVisibility.knownAgentIds,
          activeAgentIds: workspaceAgentVisibility.activeAgentIds,
        })
      ) {
        closeWorkspaceTabWithCleanup({ tabId: tab.tabId, target: tab.target });
      }
      if (
        canPruneTerminalTabs &&
        tab.target.kind === "terminal" &&
        !terminalIds.has(tab.target.terminalId)
      ) {
        closeWorkspaceTabWithCleanup({ tabId: tab.tabId, target: tab.target });
      }
    }
  }, [
    closeWorkspaceTabWithCleanup,
    ensureWorkspaceTab,
    hasHydratedAgents,
    hiddenAgentIds,
    pendingByDraftId,
    pinnedAgentIds,
    persistenceKey,
    terminals,
    terminalsQuery.isSuccess,
    uiTabs,
    workspaceAgentVisibility,
  ]);

  const activeTabId = focusedPaneTabState.activeTabId;
  const activeTab = focusedPaneTabState.activeTab;

  useEffect(() => {
    if (!activeTabId || !persistenceKey) {
      return;
    }
    focusWorkspaceTab(persistenceKey, activeTabId);
  }, [activeTabId, focusWorkspaceTab, persistenceKey]);

  const tabs = useMemo<WorkspaceTabDescriptor[]>(
    () => focusedPaneTabState.tabs.map((tab) => tab.descriptor),
    [focusedPaneTabState.tabs],
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

  const emptyWorkspaceSeedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!persistenceKey) {
      return;
    }
    if (workspaceAgentVisibility.activeAgentIds.size > 0 || terminals.length > 0) {
      emptyWorkspaceSeedRef.current = null;
      return;
    }
    if (tabs.length > 0) {
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
    terminals.length,
    tabs.length,
    workspaceAgentVisibility.activeAgentIds.size,
  ]);

  const handleOpenFileFromExplorer = useCallback(
    function handleOpenFileFromExplorer(filePath: string) {
      if (isMobile) {
        closeToAgent();
      }
      if (!persistenceKey) {
        return;
      }
      const tabId = openWorkspaceTab(persistenceKey, { kind: "file", path: filePath });
      if (tabId) {
        navigateToTabId(tabId);
      }
    },
    [closeToAgent, isMobile, navigateToTabId, openWorkspaceTab, persistenceKey],
  );

  const handleOpenFileFromChat = useCallback(
    ({ filePath }: { filePath: string }) => {
      const normalizedFilePath = filePath.trim();
      if (!normalizedFilePath) {
        return;
      }
      handleOpenFileFromExplorer(normalizedFilePath);
    },
    [handleOpenFileFromExplorer],
  );

  const [hoveredTabKey, setHoveredTabKey] = useState<string | null>(null);
  const [hoveredCloseTabKey, setHoveredCloseTabKey] = useState<string | null>(null);

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

  const activeTabKey = activeTabId ?? "";

  const tabSwitcherOptions = useMemo(
    () =>
      tabs.map((tab) => ({
        id: tab.key,
        label: getFallbackTabOptionLabel(tab),
        description: getFallbackTabOptionDescription(tab),
      })),
    [tabs],
  );

  const handleCreateDraftTab = useCallback(() => {
    openWorkspaceDraftTab();
  }, [openWorkspaceDraftTab]);

  const handleCreateTerminal = useCallback(
    (input?: { paneId?: string }) => {
      if (createTerminalMutation.isPending) {
        return;
      }
      if (!isAbsolutePath(normalizedWorkspaceId)) {
        return;
      }
      createTerminalMutation.mutate(input);
    },
    [createTerminalMutation, normalizedWorkspaceId],
  );

  const handleSelectSwitcherTab = useCallback(
    (key: string) => {
      navigateToTabId(key);
    },
    [navigateToTabId],
  );

  const handleSelectNewTabOption = useCallback(
    (selection: { optionId: NewTabOptionId; paneId?: string }) => {
      if (selection.paneId && persistenceKey) {
        focusWorkspacePane(persistenceKey, selection.paneId);
      }
      if (selection.optionId === NEW_TAB_AGENT_OPTION_ID) {
        handleCreateDraftTab();
      } else if (selection.optionId === NEW_TAB_TERMINAL_OPTION_ID) {
        handleCreateTerminal({ paneId: selection.paneId });
      }
    },
    [focusWorkspacePane, handleCreateDraftTab, handleCreateTerminal, persistenceKey],
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

      focusWorkspacePane(persistenceKey, paneId);
      openWorkspaceDraftTab();
    },
    [focusWorkspacePane, openWorkspaceDraftTab, persistenceKey, splitWorkspacePaneEmpty],
  );

  const killTerminalAsync = killTerminalMutation.mutateAsync;

  const handleCloseTerminalTab = useCallback(
    async (input: { tabId: string; terminalId: string }) => {
      const { tabId, terminalId } = input;
      await closeTab(tabId, async () => {
        const confirmed = await confirmDialog({
          title: "Close terminal?",
          message: "Any running process in this terminal will be stopped immediately.",
          confirmLabel: "Close",
          cancelLabel: "Cancel",
          destructive: true,
        });
        if (!confirmed) {
          return;
        }

        queryClient.setQueryData<ListTerminalsPayload>(terminalsQueryKey, (current) => {
          if (!current) {
            return current;
          }
          return {
            ...current,
            terminals: current.terminals.filter((terminal) => terminal.id !== terminalId),
          };
        });
        setHoveredTabKey((current) => (current === tabId ? null : current));
        setHoveredCloseTabKey((current) => (current === tabId ? null : current));
        if (persistenceKey) {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: { kind: "terminal", terminalId },
          });
        }

        void killTerminalAsync(terminalId).catch(() => {
          void queryClient.invalidateQueries({ queryKey: terminalsQueryKey });
        });
      });
    },
    [
      closeTab,
      closeWorkspaceTabWithCleanup,
      killTerminalAsync,
      persistenceKey,
      queryClient,
      terminalsQueryKey,
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

        if (agent?.status !== "idle") {
          const confirmed = await confirmDialog({
            title: "Archive agent?",
            message: "This closes the tab and archives the agent.",
            confirmLabel: "Archive",
            cancelLabel: "Cancel",
            destructive: true,
          });
          if (!confirmed) {
            return;
          }
        }

        setHoveredTabKey((current) => (current === tabId ? null : current));
        setHoveredCloseTabKey((current) => (current === tabId ? null : current));
        if (persistenceKey) {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: { kind: "agent", agentId },
          });
        }

        void archiveAgent({ serverId: normalizedServerId, agentId });
      });
    },
    [archiveAgent, closeTab, closeWorkspaceTabWithCleanup, normalizedServerId, persistenceKey],
  );

  const handleCloseDraftOrFileTab = useCallback(
    function handleCloseDraftOrFileTab(tabId: string) {
      setHoveredTabKey((current) => (current === tabId ? null : current));
      setHoveredCloseTabKey((current) => (current === tabId ? null : current));
      if (persistenceKey) {
        closeWorkspaceTabWithCleanup({ tabId });
      }
    },
    [closeWorkspaceTabWithCleanup, persistenceKey],
  );

  const handleCloseTabById = useCallback(
    async (tabId: string) => {
      const tab = allTabDescriptorsById.get(tabId);
      if (!tab) {
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
      handleCloseDraftOrFileTab(tabId);
    },
    [allTabDescriptorsById, handleCloseAgentTab, handleCloseDraftOrFileTab, handleCloseTerminalTab],
  );

  const handleCopyAgentId = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      try {
        await Clipboard.setStringAsync(agentId);
        toast.copied("Agent ID");
      } catch {
        toast.error("Copy failed");
      }
    },
    [toast],
  );

  const handleCopyResumeCommand = useCallback(
    async (agentId: string) => {
      if (!agentId) return;
      const agent =
        useSessionStore.getState().sessions[normalizedServerId]?.agents?.get(agentId) ?? null;
      const providerSessionId =
        agent?.runtimeInfo?.sessionId ?? agent?.persistence?.sessionId ?? null;
      if (!agent || !providerSessionId) {
        toast.error("Resume ID not available");
        return;
      }

      const command =
        buildProviderCommand({
          provider: agent.provider,
          id: "resume",
          sessionId: providerSessionId,
        }) ?? null;
      if (!command) {
        toast.error("Resume command not available");
        return;
      }
      try {
        await Clipboard.setStringAsync(command);
        toast.copied("resume command");
      } catch {
        toast.error("Copy failed");
      }
    },
    [normalizedServerId, toast],
  );

  const handleReloadAgent = useCallback(
    async (agentId: string) => {
      if (!client || !isConnected) {
        toast.error("Host is not connected");
        return;
      }

      try {
        await client.refreshAgent(agentId);
        toast.show("Reloaded agent", { variant: "success" });
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to reload agent");
      }
    },
    [client, isConnected, toast],
  );

  const handleCopyWorkspacePath = useCallback(async () => {
    if (!isAbsolutePath(normalizedWorkspaceId)) {
      toast.error("Workspace path not available");
      return;
    }

    try {
      await Clipboard.setStringAsync(normalizedWorkspaceId);
      toast.copied("Workspace path");
    } catch {
      toast.error("Copy failed");
    }
  }, [normalizedWorkspaceId, toast]);

  const handleCopyBranchName = useCallback(async () => {
    if (!currentBranchName) {
      toast.error("Branch name not available");
      return;
    }

    try {
      await Clipboard.setStringAsync(currentBranchName);
      toast.copied("Branch name");
    } catch {
      toast.error("Copy failed");
    }
  }, [currentBranchName, toast]);

  const handleBulkCloseTabs = useCallback(
    async (input: { tabsToClose: WorkspaceTabDescriptor[]; title: string; logLabel: string }) => {
      const { tabsToClose, title, logLabel } = input;
      if (tabsToClose.length === 0) {
        return;
      }

      const groups = classifyBulkClosableTabs(tabsToClose);
      const confirmed = await confirmDialog({
        title,
        message: buildBulkCloseConfirmationMessage(groups),
        confirmLabel: "Close",
        cancelLabel: "Cancel",
        destructive: true,
      });
      if (!confirmed) {
        return;
      }

      await closeBulkWorkspaceTabs({
        client,
        groups,
        closeTab,
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
      setHoveredTabKey((current) => (current && closedKeys.has(current) ? null : current));
      setHoveredCloseTabKey((current) => (current && closedKeys.has(current) ? null : current));
    },
    [client, closeTab, closeWorkspaceTabWithCleanup, persistenceKey],
  );

  const handleCloseTabsToLeftInPane = useCallback(
    async (tabId: string, paneTabs: WorkspaceTabDescriptor[]) => {
      const index = paneTabs.findIndex((tab) => tab.tabId === tabId);
      if (index < 0) {
        return;
      }
      await handleBulkCloseTabs({
        tabsToClose: paneTabs.slice(0, index),
        title: "Close tabs to the left?",
        logLabel: "to the left",
      });
    },
    [handleBulkCloseTabs],
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
        title: "Close tabs to the right?",
        logLabel: "to the right",
      });
    },
    [handleBulkCloseTabs],
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
        title: "Close other tabs?",
        logLabel: "from close other tabs",
      });
    },
    [handleBulkCloseTabs],
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
        case "workspace.tab.new":
          handleCreateDraftTab();
          return true;
        case "workspace.terminal.new":
          handleCreateTerminal();
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
      handleCreateTerminal,
      navigateToTabId,
      tabs,
    ],
  );

  const handleWorkspacePaneAction = useCallback(
    (action: KeyboardActionDefinition): boolean => {
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

      if (
        action.id === "workspace.pane.focus.left" ||
        action.id === "workspace.pane.focus.right" ||
        action.id === "workspace.pane.focus.up" ||
        action.id === "workspace.pane.focus.down"
      ) {
        const direction = action.id.split(".").pop();
        if (
          direction === "left" ||
          direction === "right" ||
          direction === "up" ||
          direction === "down"
        ) {
          const adjacentPaneId = findAdjacentPane(workspaceLayout.root, focusedPane.id, direction);
          if (adjacentPaneId) {
            focusWorkspacePane(persistenceKey, adjacentPaneId);
          }
        }
        return true;
      }

      if (
        action.id === "workspace.pane.move-tab.left" ||
        action.id === "workspace.pane.move-tab.right" ||
        action.id === "workspace.pane.move-tab.up" ||
        action.id === "workspace.pane.move-tab.down"
      ) {
        const direction = action.id.split(".").pop();
        if (
          direction === "left" ||
          direction === "right" ||
          direction === "up" ||
          direction === "down"
        ) {
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
        for (const tabId of focusedPane.tabIds) {
          closeWorkspaceTabWithCleanup({
            tabId,
            target: allTabDescriptorsById.get(tabId)?.target ?? null,
          });
        }
        return true;
      }

      return false;
    },
    [
      allTabDescriptorsById,
      closeWorkspaceTabWithCleanup,
      focusWorkspacePane,
      handleCreateDraftSplit,
      moveWorkspaceTabToPane,
      persistenceKey,
      focusedPaneTabState.activeTabId,
      focusedPaneTabState.pane,
      workspaceLayout,
    ],
  );

  useKeyboardActionHandler({
    handlerId: `workspace-tab-actions:${normalizedServerId}:${normalizedWorkspaceId}`,
    actions: [
      "workspace.tab.new",
      "workspace.tab.close-current",
      "workspace.tab.navigate-index",
      "workspace.tab.navigate-relative",
      "workspace.terminal.new",
    ] as const,
    enabled: Boolean(normalizedServerId && normalizedWorkspaceId),
    priority: 100,
    isActive: () => true,
    handle: handleWorkspaceTabAction,
  });

  useKeyboardActionHandler({
    handlerId: `workspace-pane-actions:${normalizedServerId}:${normalizedWorkspaceId}`,
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
    ] as const,
    enabled: Boolean(normalizedServerId && normalizedWorkspaceId),
    priority: 100,
    isActive: () => true,
    handle: handleWorkspacePaneAction,
  });

  const activeTabDescriptor = activeTab?.descriptor ?? null;
  const canRenderDesktopPaneSplits = supportsDesktopPaneSplits();
  const shouldRenderDesktopPaneFallback = !isMobile && !canRenderDesktopPaneSplits;
  useEffect(() => {
    if (Platform.OS !== "web" || typeof document === "undefined" || activeTabDescriptor) {
      return;
    }
    document.title = "Workspace";
  }, [activeTabDescriptor]);
  const buildPaneContentModel = useCallback(
    (input: {
      tab: WorkspaceTabDescriptor;
      paneId?: string | null;
      isPaneFocused: boolean;
      focusPaneBeforeOpen?: boolean;
    }) =>
      buildWorkspacePaneContentModel({
        tab: input.tab,
        normalizedServerId,
        normalizedWorkspaceId,
        isPaneFocused: input.isPaneFocused,
        onOpenTab: (target) => {
          if (!persistenceKey) {
            return;
          }
          if (input.focusPaneBeforeOpen && input.paneId) {
            focusWorkspacePane(persistenceKey, input.paneId);
          }
          const tabId = openWorkspaceTab(persistenceKey, target);
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
        onOpenWorkspaceFile: (filePath) => {
          if (input.focusPaneBeforeOpen && input.paneId && persistenceKey) {
            focusWorkspacePane(persistenceKey, input.paneId);
          }
          handleOpenFileFromChat({ filePath });
        },
      }),
    [
      handleCloseTabById,
      handleOpenFileFromChat,
      focusWorkspacePane,
      navigateToTabId,
      normalizedServerId,
      normalizedWorkspaceId,
      openWorkspaceTab,
      persistenceKey,
      retargetWorkspaceTab,
    ],
  );
  const focusedPaneId = focusedPaneTabState.pane?.id ?? null;
  const focusedPaneTabIds = useMemo(() => tabs.map((tab) => tab.tabId), [tabs]);
  const focusedPaneTabDescriptorMap = useStableTabDescriptorMap(tabs);
  const { mountedTabIds: mountedFocusedPaneTabIdsSet } = useMountedTabSet({
    activeTabId: activeTabDescriptor?.tabId ?? null,
    allTabIds: focusedPaneTabIds,
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
      isPaneFocused: boolean;
    }) {
      return buildPaneContentModel({
        tab: input.tab,
        paneId: input.paneId,
        isPaneFocused: input.isPaneFocused,
        focusPaneBeforeOpen: false,
      });
    },
    [buildPaneContentModel],
  );
  const content = shouldRenderMissingWorkspaceDescriptor({
    workspace: workspaceDescriptor,
    hasHydratedWorkspaces,
  }) ? (
    <View style={styles.emptyState}>
      <ActivityIndicator color={theme.colors.foregroundMuted} />
    </View>
  ) : !activeTabDescriptor ? (
    !hasHydratedAgents ? (
      <View style={styles.emptyState}>
        <ActivityIndicator color={theme.colors.foregroundMuted} />
      </View>
    ) : (
      <View style={styles.emptyState}>
        <Text style={styles.emptyStateText}>
          No tabs are available yet. Use New tab to create an agent or terminal.
        </Text>
      </View>
    )
  ) : (
    mountedFocusedPaneTabIds.map((tabId) => {
      const tabDescriptor = focusedPaneTabDescriptorMap.get(tabId);
      if (!tabDescriptor) {
        return null;
      }

      return (
        <MobileMountedTabSlot
          key={tabId}
          tabDescriptor={tabDescriptor}
          isVisible={tabId === activeTabDescriptor.tabId}
          isPaneFocused={tabId === activeTabDescriptor.tabId}
          paneId={focusedPaneId}
          buildPaneContentModel={buildMobilePaneContentModel}
        />
      );
    })
  );

  const buildDesktopPaneContentModel = useCallback(
    function buildDesktopPaneContentModel(input: {
      paneId: string;
      tab: WorkspaceTabDescriptor;
      isPaneFocused: boolean;
    }) {
      return buildPaneContentModel({
        tab: input.tab,
        paneId: input.paneId,
        isPaneFocused: input.isPaneFocused,
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

  const renderSplitPaneEmptyState = useCallback(function renderSplitPaneEmptyState() {
    return (
      <View style={styles.emptyState}>
        <Text style={styles.emptyStateText}>No tabs in this pane.</Text>
      </View>
    );
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: mainBackgroundColor }]}>
      {Platform.OS === "web" && activeTabDescriptor ? (
        <WorkspaceTabPresentationResolver
          tab={activeTabDescriptor}
          serverId={normalizedServerId}
          workspaceId={normalizedWorkspaceId}
        >
          {(presentation) => (
            <WorkspaceDocumentTitleEffect
              label={presentation.label}
              titleState={presentation.titleState}
            />
          )}
        </WorkspaceTabPresentationResolver>
      ) : null}
      <View style={styles.threePaneRow}>
        <View style={styles.centerColumn}>
          {(!isFocusModeEnabled || isMobile) && (
            <ScreenHeader
              left={
                <>
                  <SidebarMenuToggle />
                  <View style={styles.headerTitleContainer}>
                    {isWorkspaceHeaderLoading ? (
                      <>
                        <View style={styles.headerTitleSkeleton} />
                        <View style={styles.headerProjectTitleSkeleton} />
                      </>
                    ) : (
                      <>
                        <BranchSwitcher
                          currentBranchName={currentBranchName}
                          title={workspaceHeader.title}
                          serverId={normalizedServerId}
                          workspaceId={normalizedWorkspaceId}
                          isGitCheckout={isGitCheckout}
                        />
                        <Text
                          testID="workspace-header-subtitle"
                          style={styles.headerProjectTitle}
                          numberOfLines={1}
                        >
                          {workspaceHeader.subtitle}
                        </Text>
                      </>
                    )}
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        testID="workspace-header-menu-trigger"
                        style={styles.headerActionButton}
                        accessibilityRole="button"
                        accessibilityLabel="Workspace actions"
                      >
                        {({ hovered, open }) => {
                          const Icon = isMobile ? EllipsisVertical : Ellipsis;
                          return (
                            <Icon
                              size={theme.iconSize.md}
                              color={
                                hovered || open
                                  ? theme.colors.foreground
                                  : theme.colors.foregroundMuted
                              }
                            />
                          );
                        }}
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" width={220} testID="workspace-header-menu">
                        <DropdownMenuItem
                          testID="workspace-header-new-agent"
                          leading={<SquarePen size={16} color={theme.colors.foregroundMuted} />}
                          onSelect={handleCreateDraftTab}
                        >
                          New agent
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          testID="workspace-header-new-terminal"
                          leading={
                            <SquareTerminal size={16} color={theme.colors.foregroundMuted} />
                          }
                          disabled={createTerminalMutation.isPending}
                          onSelect={handleCreateTerminal}
                        >
                          New terminal
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          testID="workspace-header-copy-path"
                          leading={<Copy size={16} color={theme.colors.foregroundMuted} />}
                          disabled={!isAbsolutePath(normalizedWorkspaceId)}
                          onSelect={handleCopyWorkspacePath}
                        >
                          Copy workspace path
                        </DropdownMenuItem>
                        {currentBranchName ? (
                          <DropdownMenuItem
                            testID="workspace-header-copy-branch-name"
                            leading={<Copy size={16} color={theme.colors.foregroundMuted} />}
                            onSelect={handleCopyBranchName}
                          >
                            Copy branch name
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </View>
                </>
              }
              right={
                <View style={styles.headerRight}>
                  {!isMobile ? (
                    <WorkspaceOpenInEditorButton
                      serverId={normalizedServerId}
                      cwd={normalizedWorkspaceId}
                    />
                  ) : null}
                  {!isMobile && isGitCheckout ? (
                    <>
                      <WorkspaceGitActions
                        serverId={normalizedServerId}
                        cwd={normalizedWorkspaceId}
                      />
                      <Tooltip delayDuration={0} enabledOnDesktop enabledOnMobile={false}>
                        <TooltipTrigger asChild>
                          <Pressable
                            testID="workspace-explorer-toggle"
                            onPress={handleToggleExplorer}
                            accessibilityRole="button"
                            accessibilityLabel={isExplorerOpen ? "Close explorer" : "Open explorer"}
                            accessibilityState={{ expanded: isExplorerOpen }}
                            style={({ hovered, pressed }) => [
                              styles.sourceControlButton,
                              workspaceDescriptor?.diffStat && styles.sourceControlButtonWithStats,
                              (hovered || pressed || isExplorerOpen) &&
                                styles.sourceControlButtonHovered,
                            ]}
                          >
                            {({ hovered, pressed }) => {
                              const active = isExplorerOpen || hovered || pressed;
                              const iconColor = active
                                ? theme.colors.foreground
                                : theme.colors.foregroundMuted;
                              return (
                                <>
                                  <SourceControlPanelIcon
                                    size={theme.iconSize.md}
                                    color={iconColor}
                                  />
                                  {workspaceDescriptor?.diffStat ? (
                                    <View style={styles.diffStatRow}>
                                      <Text style={styles.diffStatAdditions}>
                                        +{workspaceDescriptor.diffStat.additions}
                                      </Text>
                                      <Text style={styles.diffStatDeletions}>
                                        -{workspaceDescriptor.diffStat.deletions}
                                      </Text>
                                    </View>
                                  ) : null}
                                </>
                              );
                            }}
                          </Pressable>
                        </TooltipTrigger>
                        <TooltipContent
                          testID="workspace-explorer-toggle-tooltip"
                          side="left"
                          align="center"
                          offset={8}
                        >
                          <View style={styles.explorerTooltipRow}>
                            <Text style={styles.explorerTooltipText}>Toggle explorer</Text>
                            <Shortcut keys={["mod", "E"]} style={styles.explorerTooltipShortcut} />
                          </View>
                        </TooltipContent>
                      </Tooltip>
                    </>
                  ) : null}
                  {!isMobile && !isGitCheckout ? (
                    <HeaderToggleButton
                      testID="workspace-explorer-toggle"
                      onPress={handleToggleExplorer}
                      tooltipLabel="Toggle explorer"
                      tooltipKeys={["mod", "E"]}
                      tooltipSide="left"
                      style={styles.headerActionButton}
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={isExplorerOpen ? "Close explorer" : "Open explorer"}
                      accessibilityState={{ expanded: isExplorerOpen }}
                    >
                      {({ hovered }) => {
                        const color =
                          isExplorerOpen || hovered
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted;
                        return <PanelRight size={theme.iconSize.md} color={color} />;
                      }}
                    </HeaderToggleButton>
                  ) : null}
                  {isMobile ? (
                    <HeaderToggleButton
                      testID="workspace-explorer-toggle"
                      onPress={handleToggleExplorer}
                      tooltipLabel="Toggle explorer"
                      tooltipKeys={["mod", "E"]}
                      tooltipSide="left"
                      style={styles.headerActionButton}
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={isExplorerOpen ? "Close explorer" : "Open explorer"}
                      accessibilityState={{ expanded: isExplorerOpen }}
                    >
                      {({ hovered }) => {
                        const color =
                          isExplorerOpen || hovered
                            ? theme.colors.foreground
                            : theme.colors.foregroundMuted;
                        return isGitCheckout ? (
                          <SourceControlPanelIcon
                            size={theme.iconSize.lg}
                            color={color}
                            strokeWidth={1.5}
                          />
                        ) : (
                          <PanelRight size={theme.iconSize.lg} color={color} />
                        );
                      }}
                    </HeaderToggleButton>
                  ) : null}
                </View>
              }
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
              onReloadAgent={handleReloadAgent}
              onCloseTab={handleCloseTabById}
              onCloseTabsAbove={handleCloseTabsToLeft}
              onCloseTabsBelow={handleCloseTabsToRight}
              onCloseOtherTabs={handleCloseOtherTabs}
            />
          ) : null}

          {shouldRenderDesktopPaneFallback ? (
            <WorkspaceDesktopTabsRow
              paneId={focusedPaneId ?? undefined}
              isFocused
              tabs={desktopTabRowItems}
              normalizedServerId={normalizedServerId}
              normalizedWorkspaceId={normalizedWorkspaceId}
              setHoveredTabKey={setHoveredTabKey}
              setHoveredCloseTabKey={setHoveredCloseTabKey}
              onNavigateTab={navigateToTabId}
              onCloseTab={handleCloseTabById}
              onCopyResumeCommand={handleCopyResumeCommand}
              onCopyAgentId={handleCopyAgentId}
              onReloadAgent={handleReloadAgent}
              onCloseTabsToLeft={handleCloseTabsToLeft}
              onCloseTabsToRight={handleCloseTabsToRight}
              onCloseOtherTabs={handleCloseOtherTabs}
              onSelectNewTabOption={handleSelectNewTabOption}
              newTabAgentOptionId={NEW_TAB_AGENT_OPTION_ID}
              onReorderTabs={handleReorderTabsInFocusedPane}
              onNewTerminalTab={handleCreateTerminal}
              onSplitRight={() => {}}
              onSplitDown={() => {}}
              showPaneSplitActions={false}
            />
          ) : null}

          <View style={styles.centerContent}>
            {isMobile ? (
              <GestureDetector gesture={explorerOpenGesture} touchAction="pan-y">
                <View style={styles.content}>{content}</View>
              </GestureDetector>
            ) : (
              <View style={styles.content}>
                {canRenderDesktopPaneSplits && workspaceLayout && persistenceKey ? (
                  <SplitContainer
                    layout={workspaceLayout}
                    focusModeEnabled={isFocusModeEnabled && !isMobile}
                    workspaceKey={persistenceKey}
                    normalizedServerId={normalizedServerId}
                    normalizedWorkspaceId={normalizedWorkspaceId}
                    uiTabs={uiTabs}
                    hoveredCloseTabKey={hoveredCloseTabKey}
                    setHoveredTabKey={setHoveredTabKey}
                    setHoveredCloseTabKey={setHoveredCloseTabKey}
                    closingTabIds={closingTabIds}
                    onNavigateTab={navigateToTabId}
                    onCloseTab={handleCloseTabById}
                    onCopyResumeCommand={handleCopyResumeCommand}
                    onCopyAgentId={handleCopyAgentId}
                    onReloadAgent={handleReloadAgent}
                    onCloseTabsToLeft={handleCloseTabsToLeftInPane}
                    onCloseTabsToRight={handleCloseTabsToRightInPane}
                    onCloseOtherTabs={handleCloseOtherTabsInPane}
                    onSelectNewTabOption={handleSelectNewTabOption}
                    newTabAgentOptionId={NEW_TAB_AGENT_OPTION_ID}
                    buildPaneContentModel={buildDesktopPaneContentModel}
                    onFocusPane={handleFocusPane}
                    onNewTerminalTab={handleCreateTerminal}
                    onSplitPane={handleSplitPane}
                    onSplitPaneEmpty={handleCreateDraftSplit}
                    onMoveTabToPane={handleMoveTabToPane}
                    onResizeSplit={handleResizePaneSplit}
                    onReorderTabsInPane={handleReorderTabsInPane}
                    renderPaneEmptyState={renderSplitPaneEmptyState}
                  />
                ) : (
                  content
                )}
              </View>
            )}
          </View>
        </View>

        {(!isFocusModeEnabled || isMobile) && (
          <ExplorerSidebar
            serverId={normalizedServerId}
            workspaceId={normalizedWorkspaceId}
            workspaceRoot={normalizedWorkspaceId}
            isGit={isGitCheckout}
            onOpenFile={handleOpenFileFromExplorer}
          />
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
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
  headerTitle: {
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
    flexShrink: 1,
  },
  headerTitleContainer: {
    flexShrink: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  headerProjectTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    flexShrink: 1,
  },
  headerTitleSkeleton: {
    width: 190,
    maxWidth: "45%",
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.25,
  },
  headerProjectTitleSkeleton: {
    width: 300,
    maxWidth: "45%",
    height: 22,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.surface3,
    opacity: 0.18,
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
  sourceControlButton: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[1],
    paddingVertical: theme.spacing[1],
    minHeight: Math.ceil(theme.fontSize.sm * 1.5) + theme.spacing[1] * 2,
    minWidth: Math.ceil(theme.fontSize.sm * 1.5) + theme.spacing[1] * 2,
    borderRadius: theme.borderRadius.md,
  },
  sourceControlButtonWithStats: {
    paddingHorizontal: theme.spacing[3],
  },
  sourceControlButtonHovered: {
    backgroundColor: theme.colors.surface2,
  },
  diffStatRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    flexShrink: 0,
  },
  diffStatAdditions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffAddition,
  },
  diffStatDeletions: {
    fontSize: theme.fontSize.xs,
    fontWeight: theme.fontWeight.normal,
    color: theme.colors.diffDeletion,
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
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  newTabTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  newTabTooltipShortcut: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
  },
  explorerTooltipRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  explorerTooltipText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.popoverForeground,
  },
  explorerTooltipShortcut: {
    backgroundColor: theme.colors.surface3,
    borderColor: theme.colors.borderAccent,
  },
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
    fontSize: theme.fontSize.sm,
  },
  mobileTabMenuTrigger: {
    width: 28,
    height: 28,
    borderRadius: theme.borderRadius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  mobileTabMenuTriggerActive: {
    backgroundColor: theme.colors.surface2,
  },
  menuItemHint: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.xs,
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
    fontSize: theme.fontSize.sm,
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
