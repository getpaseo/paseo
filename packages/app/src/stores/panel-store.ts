import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { Platform } from "react-native";

/**
 * Mobile panel state machine.
 *
 * On mobile, exactly one panel can be visible at a time:
 * - 'agent': Main agent view (no overlay panel)
 * - 'agent-list': Agent list sidebar (left overlay)
 * - 'file-explorer': File explorer sidebar (right overlay)
 *
 * This makes impossible states unrepresentable - you cannot have both
 * sidebars open at the same time on mobile.
 */
type MobilePanelView = "agent" | "agent-list" | "file-explorer";

/**
 * Desktop sidebar state.
 *
 * On desktop, sidebars are independent toggleable panels that don't overlay
 * the main content - they sit alongside it. Both can be open simultaneously.
 */
interface DesktopSidebarState {
  agentListOpen: boolean;
  fileExplorerOpen: boolean;
}

export type ExplorerTab = "changes" | "files";
export type SortOption = "name" | "modified" | "size";

export const DEFAULT_EXPLORER_SIDEBAR_WIDTH = Platform.OS === "web" ? 520 : 400;
export const MIN_EXPLORER_SIDEBAR_WIDTH = 280;
// Upper bound is intentionally generous; desktop resizing enforces a min-chat-width constraint.
export const MAX_EXPLORER_SIDEBAR_WIDTH = 2000;

export const DEFAULT_EXPLORER_FILES_SPLIT_RATIO = 0.38;
export const MIN_EXPLORER_FILES_SPLIT_RATIO = 0.2;
export const MAX_EXPLORER_FILES_SPLIT_RATIO = 0.8;

interface PanelState {
  // Mobile: which panel is currently shown
  mobileView: MobilePanelView;

  // Desktop: independent sidebar toggles
  desktop: DesktopSidebarState;

  // File explorer settings (shared between mobile/desktop)
  explorerTab: ExplorerTab;
  explorerWidth: number;
  explorerSortOption: SortOption;
  explorerFilesSplitRatio: number;

  // Actions
  openAgentList: () => void;
  openFileExplorer: () => void;
  closeToAgent: () => void;
  toggleAgentList: () => void;
  toggleFileExplorer: () => void;

  // File explorer settings actions
  setExplorerTab: (tab: ExplorerTab) => void;
  setExplorerWidth: (width: number) => void;
  setExplorerSortOption: (option: SortOption) => void;
  setExplorerFilesSplitRatio: (ratio: number) => void;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function clampWidth(width: number): number {
  return clampNumber(width, MIN_EXPLORER_SIDEBAR_WIDTH, MAX_EXPLORER_SIDEBAR_WIDTH);
}

function clampExplorerFilesSplitRatio(ratio: number): number {
  return clampNumber(ratio, MIN_EXPLORER_FILES_SPLIT_RATIO, MAX_EXPLORER_FILES_SPLIT_RATIO);
}

const DEFAULT_DESKTOP_OPEN = Platform.OS === "web";

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      // Mobile always starts at agent view
      mobileView: "agent",

      // Desktop defaults based on platform
      desktop: {
        agentListOpen: DEFAULT_DESKTOP_OPEN,
        fileExplorerOpen: DEFAULT_DESKTOP_OPEN,
      },

      // File explorer defaults
      explorerTab: "changes",
      explorerWidth: DEFAULT_EXPLORER_SIDEBAR_WIDTH,
      explorerSortOption: "name",
      explorerFilesSplitRatio: DEFAULT_EXPLORER_FILES_SPLIT_RATIO,

      openAgentList: () =>
        set((state) => ({
          mobileView: "agent-list",
          desktop: { ...state.desktop, agentListOpen: true },
        })),

      openFileExplorer: () =>
        set((state) => ({
          mobileView: "file-explorer",
          desktop: { ...state.desktop, fileExplorerOpen: true },
        })),

      closeToAgent: () =>
        set((state) => ({
          mobileView: "agent",
          // On desktop, closing depends on which panel triggered it
          // This is called when closing via gesture/backdrop, so we close the currently active mobile panel
          desktop: {
            agentListOpen:
              state.mobileView === "agent-list" ? false : state.desktop.agentListOpen,
            fileExplorerOpen:
              state.mobileView === "file-explorer" ? false : state.desktop.fileExplorerOpen,
          },
        })),

      toggleAgentList: () =>
        set((state) => {
          // Mobile: toggle between agent and agent-list
          const newMobileView = state.mobileView === "agent-list" ? "agent" : "agent-list";
          return {
            mobileView: newMobileView,
            desktop: {
              ...state.desktop,
              agentListOpen: !state.desktop.agentListOpen,
            },
          };
        }),

      toggleFileExplorer: () =>
        set((state) => {
          // Mobile: toggle between agent and file-explorer
          const newMobileView = state.mobileView === "file-explorer" ? "agent" : "file-explorer";
          return {
            mobileView: newMobileView,
            desktop: {
              ...state.desktop,
              fileExplorerOpen: !state.desktop.fileExplorerOpen,
            },
          };
        }),

      setExplorerTab: (tab) => set({ explorerTab: tab }),
      setExplorerWidth: (width) => set({ explorerWidth: clampWidth(width) }),
      setExplorerSortOption: (option) => set({ explorerSortOption: option }),
      setExplorerFilesSplitRatio: (ratio) =>
        set({ explorerFilesSplitRatio: clampExplorerFilesSplitRatio(ratio) }),
    }),
    {
      name: "panel-state",
      version: 2,
      storage: createJSONStorage(() => AsyncStorage),
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<PanelState> & Record<string, unknown>;

        if (version < 2) {
          if (
            Platform.OS === "web" &&
            typeof state.explorerWidth === "number" &&
            state.explorerWidth === 400
          ) {
            state.explorerWidth = DEFAULT_EXPLORER_SIDEBAR_WIDTH;
          }

          if (typeof state.explorerFilesSplitRatio !== "number") {
            state.explorerFilesSplitRatio = DEFAULT_EXPLORER_FILES_SPLIT_RATIO;
          }
        }

        return state as PanelState;
      },
      partialize: (state) => ({
        mobileView: state.mobileView,
        desktop: state.desktop,
        explorerTab: state.explorerTab,
        explorerWidth: state.explorerWidth,
        explorerSortOption: state.explorerSortOption,
        explorerFilesSplitRatio: state.explorerFilesSplitRatio,
      }),
    }
  )
);

/**
 * Hook that provides platform-aware panel state.
 *
 * On mobile, uses the state machine (mobileView).
 * On desktop, uses independent booleans (desktop.agentListOpen, desktop.fileExplorerOpen).
 *
 * @param isMobile - Whether the current breakpoint is mobile
 */
export function usePanelState(isMobile: boolean) {
  const store = usePanelStore();

  if (isMobile) {
    return {
      isAgentListOpen: store.mobileView === "agent-list",
      isFileExplorerOpen: store.mobileView === "file-explorer",
      openAgentList: store.openAgentList,
      openFileExplorer: store.openFileExplorer,
      closeAgentList: store.closeToAgent,
      closeFileExplorer: store.closeToAgent,
      toggleAgentList: store.toggleAgentList,
      toggleFileExplorer: store.toggleFileExplorer,
      // Explorer settings
      explorerTab: store.explorerTab,
      explorerWidth: store.explorerWidth,
      explorerSortOption: store.explorerSortOption,
      explorerFilesSplitRatio: store.explorerFilesSplitRatio,
      setExplorerTab: store.setExplorerTab,
      setExplorerWidth: store.setExplorerWidth,
      setExplorerSortOption: store.setExplorerSortOption,
      setExplorerFilesSplitRatio: store.setExplorerFilesSplitRatio,
    };
  }

  // Desktop: independent toggles
  return {
    isAgentListOpen: store.desktop.agentListOpen,
    isFileExplorerOpen: store.desktop.fileExplorerOpen,
    openAgentList: store.openAgentList,
    openFileExplorer: store.openFileExplorer,
    closeAgentList: () =>
      usePanelStore.setState((state) => ({
        desktop: { ...state.desktop, agentListOpen: false },
      })),
    closeFileExplorer: () =>
      usePanelStore.setState((state) => ({
        desktop: { ...state.desktop, fileExplorerOpen: false },
      })),
    toggleAgentList: store.toggleAgentList,
    toggleFileExplorer: store.toggleFileExplorer,
    // Explorer settings
    explorerTab: store.explorerTab,
    explorerWidth: store.explorerWidth,
    explorerSortOption: store.explorerSortOption,
    explorerFilesSplitRatio: store.explorerFilesSplitRatio,
    setExplorerTab: store.setExplorerTab,
    setExplorerWidth: store.setExplorerWidth,
    setExplorerSortOption: store.setExplorerSortOption,
    setExplorerFilesSplitRatio: store.setExplorerFilesSplitRatio,
  };
}
