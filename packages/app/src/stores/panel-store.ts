import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  buildExplorerCheckoutKey,
  coerceExplorerTabForCheckout,
  isExplorerTab,
  resolveExplorerTabForCheckout,
  type ExplorerTab,
} from "./explorer-tab-memory";
import { type ExplorerCheckoutContext } from "./explorer-checkout-context";
import { isWeb } from "@/constants/platform";
export type { ExplorerTab } from "./explorer-tab-memory";
export type { ExplorerCheckoutContext } from "./explorer-checkout-context";

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
export type MobilePanelView = "agent" | "agent-list" | "file-explorer";

/**
 * Desktop sidebar state.
 *
 * On desktop, sidebars are independent toggleable panels that don't overlay
 * the main content - they sit alongside it. Both can be open simultaneously.
 */
interface DesktopSidebarState {
  agentListOpen: boolean;
  fileExplorerOpen: boolean;
  focusModeEnabled: boolean;
}

export type SortOption = "name" | "modified" | "size";
export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;

export const DEFAULT_EXPLORER_SIDEBAR_WIDTH = 400;
export const MIN_EXPLORER_SIDEBAR_WIDTH = 280;
// Upper bound is intentionally generous; desktop resizing enforces a min-chat-width constraint.
export const MAX_EXPLORER_SIDEBAR_WIDTH = 2000;

export const DEFAULT_EXPLORER_FILES_SPLIT_RATIO = 0.38;
export const MIN_EXPLORER_FILES_SPLIT_RATIO = 0.2;
export const MAX_EXPLORER_FILES_SPLIT_RATIO = 0.8;

export interface PanelVisibilityState {
  isAgentListOpen: boolean;
  isFileExplorerOpen: boolean;
}

export interface PanelLayoutInput {
  isCompact: boolean;
}

export interface ExplorerPanelIntent extends PanelLayoutInput {
  checkout: ExplorerCheckoutContext;
}

export interface PanelState {
  // Mobile: which panel is currently shown
  mobileView: MobilePanelView;

  // Desktop: independent sidebar toggles
  desktop: DesktopSidebarState;

  // File explorer settings (shared between mobile/desktop)
  explorerTab: ExplorerTab;
  explorerTabByCheckout: Record<string, ExplorerTab>;
  expandedPathsByWorkspace: Record<string, string[]>;
  diffExpandedPathsByWorkspace: Record<string, string[]>;
  sidebarWidth: number;
  explorerWidth: number;
  explorerSortOption: SortOption;
  explorerFilesSplitRatio: number;

  // Actions
  toggleFocusMode: () => void;
  showMobileAgent: () => void;
  showMobileAgentList: () => void;
  toggleMobileAgentList: () => void;
  openDesktopAgentList: () => void;
  closeDesktopAgentList: () => void;
  toggleDesktopAgentList: () => void;
  closeDesktopFileExplorer: () => void;
  openAgentListForLayout: (input: PanelLayoutInput) => void;
  closeAgentListForLayout: (input: PanelLayoutInput) => void;
  toggleAgentListForLayout: (input: PanelLayoutInput) => void;
  openFileExplorerForCheckout: (input: ExplorerPanelIntent) => void;
  toggleFileExplorerForCheckout: (input: ExplorerPanelIntent) => void;

  // File explorer settings actions
  setExplorerTab: (tab: ExplorerTab) => void;
  setExplorerTabForCheckout: (params: ExplorerCheckoutContext & { tab: ExplorerTab }) => void;
  setExpandedPathsForWorkspace: (workspaceKey: string, paths: string[]) => void;
  setDiffExpandedPathsForWorkspace: (workspaceKey: string, paths: string[]) => void;
  activateExplorerTabForCheckout: (checkout: ExplorerCheckoutContext) => void;
  setSidebarWidth: (width: number) => void;
  setExplorerWidth: (width: number) => void;
  setExplorerSortOption: (option: SortOption) => void;
  setExplorerFilesSplitRatio: (ratio: number) => void;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function clampSidebarWidth(width: number): number {
  return clampNumber(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

function clampWidth(width: number): number {
  return clampNumber(width, MIN_EXPLORER_SIDEBAR_WIDTH, MAX_EXPLORER_SIDEBAR_WIDTH);
}

function clampExplorerFilesSplitRatio(ratio: number): number {
  return clampNumber(ratio, MIN_EXPLORER_FILES_SPLIT_RATIO, MAX_EXPLORER_FILES_SPLIT_RATIO);
}

function resolveExplorerTabFromCheckout(state: PanelState, checkout: ExplorerCheckoutContext) {
  return resolveExplorerTabForCheckout({
    serverId: checkout.serverId,
    cwd: checkout.cwd,
    isGit: checkout.isGit,
    explorerTabByCheckout: state.explorerTabByCheckout,
  });
}

function buildOpenFileExplorerPatch(
  state: PanelState,
  input: ExplorerPanelIntent,
): Partial<PanelState> {
  const resolvedTab = resolveExplorerTabFromCheckout(state, input.checkout);
  if (input.isCompact) {
    return {
      mobileView: "file-explorer",
      explorerTab: resolvedTab,
    };
  }
  return {
    desktop: { ...state.desktop, fileExplorerOpen: true },
    explorerTab: resolvedTab,
  };
}

export function selectPanelVisibility(
  state: PanelState,
  input: PanelLayoutInput,
): PanelVisibilityState {
  if (input.isCompact) {
    return {
      isAgentListOpen: state.mobileView === "agent-list",
      isFileExplorerOpen: state.mobileView === "file-explorer",
    };
  }
  return {
    isAgentListOpen: state.desktop.agentListOpen,
    isFileExplorerOpen: state.desktop.fileExplorerOpen,
  };
}

export function selectIsAgentListOpen(state: PanelState, input: PanelLayoutInput): boolean {
  return selectPanelVisibility(state, input).isAgentListOpen;
}

export function selectIsFileExplorerOpen(state: PanelState, input: PanelLayoutInput): boolean {
  return selectPanelVisibility(state, input).isFileExplorerOpen;
}

const DEFAULT_DESKTOP_OPEN = isWeb;

export const usePanelStore = create<PanelState>()(
  persist(
    (set) => ({
      // Mobile always starts at agent view
      mobileView: "agent",

      // Desktop defaults based on platform
      desktop: {
        agentListOpen: DEFAULT_DESKTOP_OPEN,
        fileExplorerOpen: false,
        focusModeEnabled: false,
      },

      // File explorer defaults
      explorerTab: "changes",
      explorerTabByCheckout: {},
      expandedPathsByWorkspace: {},
      diffExpandedPathsByWorkspace: {},
      sidebarWidth: DEFAULT_SIDEBAR_WIDTH,
      explorerWidth: DEFAULT_EXPLORER_SIDEBAR_WIDTH,
      explorerSortOption: "name",
      explorerFilesSplitRatio: DEFAULT_EXPLORER_FILES_SPLIT_RATIO,

      toggleFocusMode: () =>
        set((state) => ({
          desktop: { ...state.desktop, focusModeEnabled: !state.desktop.focusModeEnabled },
        })),

      showMobileAgent: () =>
        set((state) => {
          if (state.mobileView === "agent") {
            return state;
          }
          return { mobileView: "agent" as const };
        }),

      showMobileAgentList: () =>
        set((state) => {
          if (state.mobileView === "agent-list") {
            return state;
          }
          return { mobileView: "agent-list" as const };
        }),

      toggleMobileAgentList: () =>
        set((state) => ({
          mobileView: state.mobileView === "agent-list" ? "agent" : "agent-list",
        })),

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

      closeDesktopFileExplorer: () =>
        set((state) => {
          if (!state.desktop.fileExplorerOpen) {
            return state;
          }
          return { desktop: { ...state.desktop, fileExplorerOpen: false } };
        }),

      openAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return state.mobileView === "agent-list"
              ? state
              : { mobileView: "agent-list" as const };
          }
          return state.desktop.agentListOpen
            ? state
            : { desktop: { ...state.desktop, agentListOpen: true } };
        }),

      closeAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return state.mobileView === "agent" ? state : { mobileView: "agent" as const };
          }
          return state.desktop.agentListOpen
            ? { desktop: { ...state.desktop, agentListOpen: false } }
            : state;
        }),

      toggleAgentListForLayout: ({ isCompact }) =>
        set((state) => {
          if (isCompact) {
            return { mobileView: state.mobileView === "agent-list" ? "agent" : "agent-list" };
          }
          return {
            desktop: { ...state.desktop, agentListOpen: !state.desktop.agentListOpen },
          };
        }),

      openFileExplorerForCheckout: (input) =>
        set((state) => buildOpenFileExplorerPatch(state, input)),

      toggleFileExplorerForCheckout: (input) =>
        set((state) => {
          const isOpen = selectIsFileExplorerOpen(state, input);
          if (!isOpen) {
            return buildOpenFileExplorerPatch(state, input);
          }
          if (input.isCompact) {
            return { mobileView: "agent" as const };
          }
          return { desktop: { ...state.desktop, fileExplorerOpen: false } };
        }),

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
        set((state) => ({
          expandedPathsByWorkspace: { ...state.expandedPathsByWorkspace, [workspaceKey]: paths },
        })),
      setDiffExpandedPathsForWorkspace: (workspaceKey, paths) =>
        set((state) => ({
          diffExpandedPathsByWorkspace: {
            ...state.diffExpandedPathsByWorkspace,
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
      setExplorerWidth: (width) => set({ explorerWidth: clampWidth(width) }),
      setExplorerSortOption: (option) => set({ explorerSortOption: option }),
      setExplorerFilesSplitRatio: (ratio) =>
        set({
          explorerFilesSplitRatio: Number.isFinite(ratio)
            ? clampExplorerFilesSplitRatio(ratio)
            : DEFAULT_EXPLORER_FILES_SPLIT_RATIO,
        }),
    }),
    {
      name: "panel-state",
      version: 10,
      storage: createJSONStorage(() => AsyncStorage),
      migrate: (persistedState, version) => {
        const state = persistedState as Partial<PanelState> & Record<string, unknown>;

        if (version < 2) {
          if (isWeb && typeof state.explorerWidth === "number" && state.explorerWidth === 400) {
            state.explorerWidth = DEFAULT_EXPLORER_SIDEBAR_WIDTH;
          }

          if (typeof state.explorerFilesSplitRatio !== "number") {
            state.explorerFilesSplitRatio = DEFAULT_EXPLORER_FILES_SPLIT_RATIO;
          } else {
            state.explorerFilesSplitRatio = clampExplorerFilesSplitRatio(
              state.explorerFilesSplitRatio,
            );
          }
        }

        if (version < 3) {
          if (
            isWeb &&
            typeof state.explorerWidth === "number" &&
            (state.explorerWidth === 400 || state.explorerWidth === 520)
          ) {
            state.explorerWidth = DEFAULT_EXPLORER_SIDEBAR_WIDTH;
          }
        }

        if (!isExplorerTab(state.explorerTab)) {
          state.explorerTab = "changes";
        }

        if (
          version < 4 ||
          typeof state.explorerTabByCheckout !== "object" ||
          !state.explorerTabByCheckout
        ) {
          state.explorerTabByCheckout = {};
        } else {
          const entries = Object.entries(state.explorerTabByCheckout as Record<string, unknown>);
          const next: Record<string, ExplorerTab> = {};
          for (const [key, value] of entries) {
            if (!isExplorerTab(value)) {
              continue;
            }
            next[key] = value;
          }
          state.explorerTabByCheckout = next;
        }

        if (version < 8) {
          const desktop = state.desktop as Record<string, unknown> | undefined;
          if (desktop) {
            if ("zoomed" in desktop) {
              desktop.focusModeEnabled = desktop.zoomed;
              delete desktop.zoomed;
            }
            if ("focused" in desktop) {
              desktop.focusModeEnabled = desktop.focused;
              delete desktop.focused;
            }
            if (typeof desktop.focusModeEnabled !== "boolean") {
              desktop.focusModeEnabled = false;
            }
          }
        }

        if (version < 6 || typeof state.sidebarWidth !== "number") {
          state.sidebarWidth = DEFAULT_SIDEBAR_WIDTH;
        }

        if (
          version < 9 ||
          typeof state.expandedPathsByWorkspace !== "object" ||
          !state.expandedPathsByWorkspace
        ) {
          state.expandedPathsByWorkspace = {};
        }

        if (
          version < 10 ||
          typeof state.diffExpandedPathsByWorkspace !== "object" ||
          !state.diffExpandedPathsByWorkspace
        ) {
          state.diffExpandedPathsByWorkspace = {};
        }

        return state as PanelState;
      },
      partialize: (state) => ({
        mobileView: state.mobileView,
        desktop: state.desktop,
        explorerTab: state.explorerTab,
        explorerTabByCheckout: state.explorerTabByCheckout,
        expandedPathsByWorkspace: state.expandedPathsByWorkspace,
        diffExpandedPathsByWorkspace: state.diffExpandedPathsByWorkspace,
        sidebarWidth: state.sidebarWidth,
        explorerWidth: state.explorerWidth,
        explorerSortOption: state.explorerSortOption,
        explorerFilesSplitRatio: state.explorerFilesSplitRatio,
      }),
    },
  ),
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
  const isAgentListOpen = usePanelStore((state) =>
    selectIsAgentListOpen(state, { isCompact: isMobile }),
  );
  const isFileExplorerOpen = usePanelStore((state) =>
    selectIsFileExplorerOpen(state, { isCompact: isMobile }),
  );
  const showMobileAgent = usePanelStore((state) => state.showMobileAgent);
  const openAgentListForLayout = usePanelStore((state) => state.openAgentListForLayout);
  const closeAgentListForLayout = usePanelStore((state) => state.closeAgentListForLayout);
  const toggleAgentListForLayout = usePanelStore((state) => state.toggleAgentListForLayout);
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const explorerTab = usePanelStore((state) => state.explorerTab);
  const explorerTabByCheckout = usePanelStore((state) => state.explorerTabByCheckout);
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const explorerSortOption = usePanelStore((state) => state.explorerSortOption);
  const explorerFilesSplitRatio = usePanelStore((state) => state.explorerFilesSplitRatio);
  const setExplorerTab = usePanelStore((state) => state.setExplorerTab);
  const setExplorerTabForCheckout = usePanelStore((state) => state.setExplorerTabForCheckout);
  const activateExplorerTabForCheckout = usePanelStore(
    (state) => state.activateExplorerTabForCheckout,
  );
  const setExplorerWidth = usePanelStore((state) => state.setExplorerWidth);
  const setExplorerSortOption = usePanelStore((state) => state.setExplorerSortOption);
  const setExplorerFilesSplitRatio = usePanelStore((state) => state.setExplorerFilesSplitRatio);

  return {
    isAgentListOpen,
    isFileExplorerOpen,
    openAgentList: () => openAgentListForLayout({ isCompact: isMobile }),
    closeAgentList: () => closeAgentListForLayout({ isCompact: isMobile }),
    closeFileExplorer: isMobile ? showMobileAgent : closeDesktopFileExplorer,
    toggleAgentList: () => toggleAgentListForLayout({ isCompact: isMobile }),
    explorerTab,
    explorerTabByCheckout,
    explorerWidth,
    explorerSortOption,
    explorerFilesSplitRatio,
    setExplorerTab,
    setExplorerTabForCheckout,
    activateExplorerTabForCheckout,
    setExplorerWidth,
    setExplorerSortOption,
    setExplorerFilesSplitRatio,
  };
}
