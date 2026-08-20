import {
  buildExplorerCheckoutKey,
  isExplorerTab,
  resolveExplorerTabForCheckout,
  type ExplorerTab,
} from "../explorer-tab-memory";
import { type ExplorerCheckoutContext } from "../explorer-checkout-context";
import { z } from "zod";

export type MobilePanelView = "agent" | "agent-list" | "file-explorer";

export interface MobilePanelSelection {
  target: MobilePanelView;
  revision: number;
}

export interface DesktopSidebarState {
  agentListOpen: boolean;
  focusModeEnabled: boolean;
}

export type SortOption = "name" | "modified" | "size";

export const DEFAULT_SIDEBAR_WIDTH = 320;
export const MIN_SIDEBAR_WIDTH = 200;
export const MAX_SIDEBAR_WIDTH = 600;

export const DEFAULT_TREE_RAIL_WIDTH = 260;
export const MIN_TREE_RAIL_WIDTH = 180;
export const MAX_TREE_RAIL_WIDTH = 600;

export interface PanelLayoutInput {
  isCompact: boolean;
}

export interface PanelCoreState {
  mobilePanel: MobilePanelSelection;
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

export function clampTreeRailWidth(width: number): number {
  return clampNumber(width, MIN_TREE_RAIL_WIDTH, MAX_TREE_RAIL_WIDTH);
}

export function selectIsAgentListOpen(state: PanelCoreState, input: PanelLayoutInput): boolean {
  return input.isCompact ? state.mobilePanel.target === "agent-list" : state.desktop.agentListOpen;
}

/**
 * The overlay explorer exists only on compact layouts. Wider layouts render the
 * explorer as workspace tabs — see `@/workspace-tabs/explorer-surface`.
 */
export function selectIsCompactFileExplorerOpen(state: PanelCoreState): boolean {
  return state.mobilePanel.target === "file-explorer";
}

export function setMobilePanelTarget(
  selection: MobilePanelSelection,
  target: MobilePanelView,
): MobilePanelSelection {
  if (selection.target === target) {
    return selection;
  }
  return { target, revision: selection.revision + 1 };
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
  mobilePanel: MobilePanelSelection;
  explorerTab: ExplorerTab;
}

export function buildOpenFileExplorerPatch(
  state: PanelCoreState,
  checkout: ExplorerCheckoutContext,
): OpenFileExplorerPatch {
  return {
    mobilePanel: setMobilePanelTarget(state.mobilePanel, "file-explorer"),
    explorerTab: resolveExplorerTabFromCheckout(state, checkout),
  };
}

export type ToggleFileExplorerPatch = OpenFileExplorerPatch | { mobilePanel: MobilePanelSelection };

export function buildToggleFileExplorerPatch(
  state: PanelCoreState,
  checkout: ExplorerCheckoutContext,
): ToggleFileExplorerPatch {
  if (!selectIsCompactFileExplorerOpen(state)) {
    return buildOpenFileExplorerPatch(state, checkout);
  }
  return { mobilePanel: setMobilePanelTarget(state.mobilePanel, "agent") };
}

const ExplorerTabSchema = z.enum(["changes", "files", "pr"]);
const DesktopSidebarStorageSchema = z.strictObject({
  agentListOpen: z.boolean().optional(),
  focusModeEnabled: z.boolean().optional(),
  zoomed: z.boolean().optional(),
  focused: z.boolean().optional(),
  // Accepted only so migration can discard the former docked explorer sidebar.
  // The schema is strict and a parse failure drops the whole entry, so removing
  // this key outright would wipe every upgrading user's panel state.
  fileExplorerOpen: z.boolean().optional(),
});

export const PanelPersistedStateSchema = z.strictObject({
  mobileView: z.enum(["agent", "agent-list", "file-explorer"]).optional(),
  mobilePanel: z
    .strictObject({
      target: z.enum(["agent", "agent-list", "file-explorer"]),
      revision: z.number().int().nonnegative(),
    })
    .optional(),
  desktop: DesktopSidebarStorageSchema.optional(),
  explorerTab: ExplorerTabSchema.optional(),
  explorerTabByCheckout: z.record(z.string(), ExplorerTabSchema).optional(),
  expandedPathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  // Accepted only so migration can discard the former per-file diff expansion state.
  diffExpandedPathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  diffCollapsedFoldersByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  diffCollapsedSubmodulesByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  collapsedFilePathsByWorkspace: z.record(z.string(), z.array(z.string())).optional(),
  sidebarWidth: z.number().optional(),
  // Accepted only so migration can discard the former docked explorer sidebar width.
  explorerWidth: z.number().optional(),
  explorerSortOption: z.enum(["name", "modified", "size"]).optional(),
  explorerShowHiddenFiles: z.boolean().optional(),
  explorerFilesSplitRatio: z.number().optional(),
  treeRailWidth: z.number().optional(),
  fileTreeVisible: z.boolean().optional(),
});

type MigratablePanelState = z.infer<typeof PanelPersistedStateSchema>;

function migratePanelExplorerTabByCheckout(state: MigratablePanelState, version: number): void {
  if (
    version < 4 ||
    typeof state.explorerTabByCheckout !== "object" ||
    !state.explorerTabByCheckout
  ) {
    state.explorerTabByCheckout = {};
    return;
  }
  const entries = Object.entries(state.explorerTabByCheckout);
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
  const desktop = state.desktop;
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

// v16 narrowed the rail. Existing installs almost all carry the old 320 default,
// so the reset is what makes the narrower rail visible to anyone but a new user.
function migrateTreeRailWidth(state: MigratablePanelState, version: number): void {
  if (version < 16 || typeof state.treeRailWidth !== "number") {
    delete state.explorerFilesSplitRatio;
    state.treeRailWidth = DEFAULT_TREE_RAIL_WIDTH;
    return;
  }
  state.treeRailWidth = clampTreeRailWidth(state.treeRailWidth);
}

export function migratePanelState(persistedState: unknown, version: number): MigratablePanelState {
  const result = PanelPersistedStateSchema.safeParse(persistedState);
  const state: MigratablePanelState = result.success ? result.data : {};

  // The docked explorer sidebar is gone; wider layouts render the explorer as
  // workspace tabs. Left behind, `fileExplorerOpen` kept drawing a sidebar that
  // nothing could close.
  delete state.explorerWidth;
  if (state.desktop) {
    delete state.desktop.fileExplorerOpen;
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
  delete state.diffExpandedPathsByWorkspace;
  if (
    version < 12 ||
    typeof state.diffCollapsedFoldersByWorkspace !== "object" ||
    !state.diffCollapsedFoldersByWorkspace
  ) {
    state.diffCollapsedFoldersByWorkspace = {};
  }
  if (
    typeof state.diffCollapsedSubmodulesByWorkspace !== "object" ||
    !state.diffCollapsedSubmodulesByWorkspace
  ) {
    state.diffCollapsedSubmodulesByWorkspace = {};
  }
  if (
    typeof state.collapsedFilePathsByWorkspace !== "object" ||
    !state.collapsedFilePathsByWorkspace
  ) {
    state.collapsedFilePathsByWorkspace = {};
  }
  if (typeof state.explorerShowHiddenFiles !== "boolean") {
    state.explorerShowHiddenFiles = true;
  }
  migrateTreeRailWidth(state, version);
  if (typeof state.fileTreeVisible !== "boolean") {
    state.fileTreeVisible = true;
  }
  if (version < 12) {
    // Compact panel position is transient UI state. Cold starts always begin
    // at content, regardless of what an older version persisted.
    delete state.mobileView;
    delete state.mobilePanel;
  }

  return state;
}

export { buildExplorerCheckoutKey, resolveExplorerTabForCheckout };
export type { ExplorerTab, ExplorerCheckoutContext };
