import { create } from "zustand";
import { persist } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  buildExplorerCheckoutKey,
  coerceExplorerTabForCheckout,
  resolveExplorerTabForCheckout,
  type ExplorerTab,
} from "../explorer-tab-memory";
import { type ExplorerCheckoutContext } from "../explorer-checkout-context";
import {
  buildOpenFileExplorerPatch,
  buildToggleFileExplorerPatch,
  clampTreeRailWidth,
  clampSidebarWidth,
  DEFAULT_TREE_RAIL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_TREE_RAIL_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_TREE_RAIL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  migratePanelState,
  PanelPersistedStateSchema,
  selectIsAgentListOpen,
  selectIsCompactFileExplorerOpen,
  setMobilePanelTarget,
  type DesktopSidebarState,
  type MobilePanelView,
  type MobilePanelSelection,
  type PanelLayoutInput,
  type SortOption,
} from "./state";
import { isWeb } from "@/constants/platform";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
export type { ExplorerTab } from "../explorer-tab-memory";
export type { ExplorerCheckoutContext } from "../explorer-checkout-context";
export type {
  DesktopSidebarState,
  MobilePanelView,
  MobilePanelSelection,
  PanelLayoutInput,
  SortOption,
} from "./state";
export {
  DEFAULT_TREE_RAIL_WIDTH,
  DEFAULT_SIDEBAR_WIDTH,
  MAX_TREE_RAIL_WIDTH,
  MAX_SIDEBAR_WIDTH,
  MIN_TREE_RAIL_WIDTH,
  MIN_SIDEBAR_WIDTH,
  clampTreeRailWidth,
  selectIsAgentListOpen,
  selectIsCompactFileExplorerOpen,
};

export type ExpandedPathsUpdate = string[] | ((currentPaths: string[]) => string[]);

export interface PanelState {
  // Mobile: React's durable target plus the generation that owns it.
  mobilePanel: MobilePanelSelection;

  // Desktop: independent sidebar toggles
  desktop: DesktopSidebarState;

  // File explorer settings (shared between mobile/desktop)
  explorerTab: ExplorerTab;
  explorerTabByCheckout: Record<string, ExplorerTab>;
  expandedPathsByWorkspace: Record<string, string[]>;
  // Changes-view folder tree. Inverted semantics vs the fields above:
  // this stores COLLAPSED directory paths (empty = all folders expanded), keyed
  // by full uncompressed dir path, so folders default to expanded and new
  // folders stay expanded as the diff changes.
  diffCollapsedFoldersByWorkspace: Record<string, string[]>;
  collapsedFilePathsByWorkspace: Record<string, string[]>;
  sidebarWidth: number;
  explorerSortOption: SortOption;
  explorerShowHiddenFiles: boolean;
  treeRailWidth: number;
  // File panel's tree rail. The changes panel keeps its own flag in
  // `useChangesPreferences`; the two rails open and close independently.
  fileTreeVisible: boolean;

  // Actions
  toggleFocusMode: () => void;
  exitFocusMode: () => void;
  showMobileAgent: () => void;
  showMobileAgentList: () => void;
  toggleMobileAgentList: () => void;
  openDesktopAgentList: () => void;
  closeDesktopAgentList: () => void;
  toggleDesktopAgentList: () => void;
  openAgentListForLayout: (input: PanelLayoutInput) => void;
  closeAgentListForLayout: (input: PanelLayoutInput) => void;
  toggleAgentListForLayout: (input: PanelLayoutInput) => void;
  openCompactFileExplorer: (checkout: ExplorerCheckoutContext) => void;
  toggleCompactFileExplorer: (checkout: ExplorerCheckoutContext) => void;

  // File explorer settings actions
  setExplorerTab: (tab: ExplorerTab) => void;
  setExplorerTabForCheckout: (params: ExplorerCheckoutContext & { tab: ExplorerTab }) => void;
  setExpandedPathsForWorkspace: (workspaceKey: string, paths: ExpandedPathsUpdate) => void;
  setDiffCollapsedFoldersForWorkspace: (workspaceKey: string, dirPaths: string[]) => void;
  setCollapsedFilePathsForWorkspace: (workspaceKey: string, paths: string[]) => void;
  activateExplorerTabForCheckout: (checkout: ExplorerCheckoutContext) => void;
  setSidebarWidth: (width: number) => void;
  setExplorerSortOption: (option: SortOption) => void;
  toggleExplorerShowHiddenFiles: () => void;
  setTreeRailWidth: (width: number) => void;
  toggleFileTreeVisible: () => void;
}

const DEFAULT_DESKTOP_OPEN = isWeb;

function setMobilePanelTargetPatch(
  state: PanelState,
  target: MobilePanelView,
): PanelState | Pick<PanelState, "mobilePanel"> {
  const mobilePanel = setMobilePanelTarget(state.mobilePanel, target);
  return mobilePanel === state.mobilePanel ? state : { mobilePanel };
}

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      // Mobile always starts at agent view
      mobilePanel: { target: "agent", revision: 0 },

      // Desktop defaults based on platform
      desktop: {
        agentListOpen: DEFAULT_DESKTOP_OPEN,
        focusModeEnabled: false,
      },

      // File explorer defaults
      explorerTab: "changes",
      explorerTabByCheckout: {},
      expandedPathsByWorkspace: {},
      diffCollapsedFoldersByWorkspace: {},
      collapsedFilePathsByWorkspace: {},
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      explorerSortOption: "name",
      explorerShowHiddenFiles: true,
      treeRailWidth: DEFAULT_TREE_RAIL_WIDTH,
      fileTreeVisible: true,

      toggleFocusMode: () =>
        set((state) => ({
          desktop: { ...state.desktop, focusModeEnabled: !state.desktop.focusModeEnabled },
        })),

      exitFocusMode: () =>
        set((state) =>
          state.desktop.focusModeEnabled
            ? { desktop: { ...state.desktop, focusModeEnabled: false } }
            : state,
        ),

      showMobileAgent: () => set((state) => setMobilePanelTargetPatch(state, "agent")),

      showMobileAgentList: () => set((state) => setMobilePanelTargetPatch(state, "agent-list")),

      toggleMobileAgentList: () =>
        set((state) =>
          setMobilePanelTargetPatch(
            state,
            state.mobilePanel.target === "agent-list" ? "agent" : "agent-list",
          ),
        ),

      openDesktopAgentList: () =>
        set((state) => {
          if (state.desktop.agentListOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, agentListOpen: true } };
        }),

      closeDesktopAgentList: () =>
        set((state) => {
          if (!state.desktop.agentListOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, agentListOpen: false } };
        }),

      toggleDesktopAgentList: () =>
        set((state) => ({
          desktop: { ...state.desktop, agentListOpen: !state.desktop.agentListOpen },
        })),

      openAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return setMobilePanelTargetPatch(state, "agent-list");
          }
          return state.desktop.agentListOpen
            ? state
            : { desktop: { ...state.desktop, agentListOpen: true } };
        }),

      closeAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return setMobilePanelTargetPatch(state, "agent");
          }
          return state.desktop.agentListOpen
            ? { desktop: { ...state.desktop, agentListOpen: false } }
            : state;
        }),

      toggleAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return setMobilePanelTargetPatch(
              state,
              state.mobilePanel.target === "agent-list" ? "agent" : "agent-list",
            );
          }
          return {
            desktop: { ...state.desktop, agentListOpen: !state.desktop.agentListOpen },
          };
        }),

      openCompactFileExplorer: (checkout) =>
        set((state) => buildOpenFileExplorerPatch(state, checkout)),

      toggleCompactFileExplorer: (checkout) =>
        set((state) => buildToggleFileExplorerPatch(state, checkout)),

      setExplorerTab: (tab) => set({ explorerTab: tab }),
      setExplorerTabForCheckout: ({ serverId, cwd, isGit, tab }) =>
        set((state) => {
          const resolvedTab = coerceExplorerTabForCheckout(tab, isGit);
          const key = buildExplorerCheckoutKey(serverId, cwd);
          const nextState: Partial<PanelState> = { explorerTab: resolvedTab };
          if (key) {
            const current = state.explorerTabByCheckout[key];
            if (current !== resolvedTab) {
              nextState.explorerTabByCheckout = {
                ...state.explorerTabByCheckout,
                [key]: resolvedTab,
              };
            }
          }
          return nextState;
        }),
      setExpandedPathsForWorkspace: (workspaceKey, paths) =>
        set((state) => {
          const currentPaths = state.expandedPathsByWorkspace[workspaceKey] ?? ["."];
          const nextPaths = typeof paths === "function" ? paths(currentPaths) : paths;
          return {
            expandedPathsByWorkspace: {
              ...state.expandedPathsByWorkspace,
              [workspaceKey]: nextPaths,
            },
          };
        }),
      setDiffCollapsedFoldersForWorkspace: (workspaceKey, dirPaths) =>
        set((state) => ({
          diffCollapsedFoldersByWorkspace: {
            ...state.diffCollapsedFoldersByWorkspace,
            [workspaceKey]: dirPaths,
          },
        })),
      setCollapsedFilePathsForWorkspace: (workspaceKey, paths) =>
        set((state) => ({
          collapsedFilePathsByWorkspace: {
            ...state.collapsedFilePathsByWorkspace,
            [workspaceKey]: paths,
          },
        })),
      activateExplorerTabForCheckout: (checkout) =>
        set((state) => ({
          explorerTab: resolveExplorerTabForCheckout({
            serverId: checkout.serverId,
            cwd: checkout.cwd,
            isGit: checkout.isGit,
            explorerTabByCheckout: state.explorerTabByCheckout,
          }),
        })),
      setSidebarWidth: (width) => set({ sidebarWidth: clampSidebarWidth(width) }),
      setExplorerSortOption: (option) => set({ explorerSortOption: option }),
      toggleExplorerShowHiddenFiles: () =>
        set((state) => ({ explorerShowHiddenFiles: !state.explorerShowHiddenFiles })),
      setTreeRailWidth: (width) => set({ treeRailWidth: clampTreeRailWidth(width) }),
      toggleFileTreeVisible: () => set((state) => ({ fileTreeVisible: !state.fileTreeVisible })),
    }),
    {
      name: "panel-state",
      version: 16,
      storage: createValidatedPersistStorage(AsyncStorage, PanelPersistedStateSchema),
      migrate: (persistedState, version) => migratePanelState(persistedState, version),
      partialize: (state) => ({
        desktop: state.desktop,
        explorerTab: state.explorerTab,
        explorerTabByCheckout: state.explorerTabByCheckout,
        expandedPathsByWorkspace: state.expandedPathsByWorkspace,
        diffCollapsedFoldersByWorkspace: state.diffCollapsedFoldersByWorkspace,
        collapsedFilePathsByWorkspace: state.collapsedFilePathsByWorkspace,
        sidebarWidth: state.sidebarWidth,
        explorerSortOption: state.explorerSortOption,
        explorerShowHiddenFiles: state.explorerShowHiddenFiles,
        treeRailWidth: state.treeRailWidth,
        fileTreeVisible: state.fileTreeVisible,
      }),
    },
  ),
);
