import {
  buildExplorerCheckoutKey,
  isExplorerTab,
  resolveExplorerTabForCheckout,
  type ExplorerTab,
} from "../explorer-tab-memory";
import { type ExplorerCheckoutContext } from "../explorer-checkout-context";

export type MobilePanelView = "agent" | "agent-list" | "file-explorer";

export interface DesktopSidebarState {
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

export interface PanelCoreState {
  mobileView: MobilePanelView;
  desktop: DesktopSidebarState;
  explorerTab: ExplorerTab;
  explorerTabByCheckout: Record<string, ExplorerTab>;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

export function clampSidebarWidth(width: number): number {
  return clampNumber(width, MIN_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH);
}

export function clampExplorerWidth(width: number): number {
  return clampNumber(width, MIN_EXPLORER_SIDEBAR_WIDTH, MAX_EXPLORER_SIDEBAR_WIDTH);
}

export function clampExplorerFilesSplitRatio(ratio: number): number {
  return clampNumber(ratio, MIN_EXPLORER_FILES_SPLIT_RATIO, MAX_EXPLORER_FILES_SPLIT_RATIO);
}

export function selectPanelVisibility(
  state: PanelCoreState,
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

export function selectIsAgentListOpen(state: PanelCoreState, input: PanelLayoutInput): boolean {
  return selectPanelVisibility(state, input).isAgentListOpen;
}

export function selectIsFileExplorerOpen(state: PanelCoreState, input: PanelLayoutInput): boolean {
  return selectPanelVisibility(state, input).isFileExplorerOpen;
}

function resolveExplorerTabFromCheckout(
  state: PanelCoreState,
  checkout: ExplorerCheckoutContext,
): ExplorerTab {
  return resolveExplorerTabForCheckout({
    serverId: checkout.serverId,
    cwd: checkout.cwd,
    isGit: checkout.isGit,
    explorerTabByCheckout: state.explorerTabByCheckout,
  });
}

export interface OpenFileExplorerPatch {
  mobileView?: MobilePanelView;
  desktop?: DesktopSidebarState;
  explorerTab: ExplorerTab;
}

export function buildOpenFileExplorerPatch(
  state: PanelCoreState,
  input: ExplorerPanelIntent,
): OpenFileExplorerPatch {
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

export type ToggleFileExplorerPatch =
  | OpenFileExplorerPatch
  | { mobileView: MobilePanelView }
  | { desktop: DesktopSidebarState };

export function buildToggleFileExplorerPatch(
  state: PanelCoreState,
  input: ExplorerPanelIntent,
): ToggleFileExplorerPatch {
  const isOpen = selectIsFileExplorerOpen(state, input);
  if (!isOpen) {
    return buildOpenFileExplorerPatch(state, input);
  }
  if (input.isCompact) {
    return { mobileView: "agent" };
  }
  return { desktop: { ...state.desktop, fileExplorerOpen: false } };
}

type MigratablePanelState = Record<string, unknown>;

function migratePanelV2Explorer(state: MigratablePanelState, isWeb: boolean): void {
  if (isWeb && typeof state.explorerWidth === "number" && state.explorerWidth === 400) {
    state.explorerWidth = DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  }
  if (typeof state.explorerFilesSplitRatio !== "number") {
    state.explorerFilesSplitRatio = DEFAULT_EXPLORER_FILES_SPLIT_RATIO;
  } else {
    state.explorerFilesSplitRatio = clampExplorerFilesSplitRatio(state.explorerFilesSplitRatio);
  }
}

function migratePanelV3Explorer(state: MigratablePanelState, isWeb: boolean): void {
  if (
    isWeb &&
    typeof state.explorerWidth === "number" &&
    (state.explorerWidth === 400 || state.explorerWidth === 520)
  ) {
    state.explorerWidth = DEFAULT_EXPLORER_SIDEBAR_WIDTH;
  }
}

function migratePanelExplorerTabByCheckout(state: MigratablePanelState, version: number): void {
  if (
    version < 4 ||
    typeof state.explorerTabByCheckout !== "object" ||
    !state.explorerTabByCheckout
  ) {
    state.explorerTabByCheckout = {};
    return;
  }
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

function migratePanelDesktopFocusMode(state: MigratablePanelState): void {
  const desktop = state.desktop as Record<string, unknown> | undefined;
  if (!desktop) {
    return;
  }
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

export function migratePanelState(
  persistedState: unknown,
  version: number,
  options: { isWeb: boolean },
): MigratablePanelState {
  const state = (persistedState ?? {}) as MigratablePanelState;
  const { isWeb } = options;

  if (version < 2) {
    migratePanelV2Explorer(state, isWeb);
  }
  if (version < 3) {
    migratePanelV3Explorer(state, isWeb);
  }
  if (!isExplorerTab(state.explorerTab)) {
    state.explorerTab = "changes";
  }
  migratePanelExplorerTabByCheckout(state, version);
  if (version < 8) {
    migratePanelDesktopFocusMode(state);
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

  return state;
}

export { buildExplorerCheckoutKey, resolveExplorerTabForCheckout };
export type { ExplorerTab, ExplorerCheckoutContext };
