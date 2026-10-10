import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { StyleSheet, UnistylesRuntime } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { isWeb } from "@/constants/platform";
import { createSidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import { resolveSidebarWorkspacePrimaryLabel } from "@/components/sidebar/sidebar-workspace-title";
import { useAppSettings } from "@/hooks/use-settings";
import { useSessionStore } from "@/stores/session-store";
import { darkTheme, REGISTERED_THEMES } from "@/styles/theme";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";
import {
  groupWorkspaceTabMoveTargets,
  listWorkspaceTabMoveTargets,
  resolveSidebarDropWorkspaceKey,
  SIDEBAR_WORKSPACE_ROW_TESTID_PREFIX,
  workspaceKeyServerId,
  type WorkspaceTabMoveWorkspace,
} from "@/screens/workspace/workspace-tab-move";
import {
  findAgentTabByTestIdentity,
  findAgentTabWorkspaceKey,
  moveAgentTabToWorkspace,
} from "@/screens/workspace/workspace-tab-sync";

/**
 * "Move to workspace…" for agent tabs: a sheet listing the same server's
 * workspaces grouped like the sidebar, plus a drag interaction that drops a
 * tab chip onto a sidebar workspace row. Both land on
 * `moveAgentTabToWorkspace`, which writes the placement label and converges
 * every connected client.
 */

const TAB_CHIP_TESTID_PREFIX = "workspace-tab-";
/** Test-id suffixes used by the chip's own sub-elements, never the chip. */
const NON_CHIP_SUFFIXES = ["tooltip-", "modified-", "context-"];

export function useWorkspaceTabMovePicker() {
  const [movingTab, setMovingTab] = useState<WorkspaceTabDescriptor | null>(null);
  const openMovePicker = useCallback((tab: WorkspaceTabDescriptor) => {
    if (tab.target.kind === "agent") {
      setMovingTab(tab);
    }
  }, []);
  const closeMovePicker = useCallback(() => setMovingTab(null), []);
  return { movingTab, openMovePicker, closeMovePicker };
}

function useMoveTargets(
  tab: WorkspaceTabDescriptor | null,
  serverId: string,
): WorkspaceTabMoveWorkspace[] {
  const session = useSessionStore((state) => state.sessions[serverId]);
  return useMemo(() => {
    if (!tab || tab.target.kind !== "agent" || !session) {
      return [];
    }
    const sourceWorkspaceKey = findAgentTabWorkspaceKey(tab.target.agentId);
    if (!sourceWorkspaceKey) {
      return [];
    }
    const workspaces: WorkspaceTabMoveWorkspace[] = [];
    for (const workspace of session.workspaces.values()) {
      const entry = createSidebarWorkspaceEntry({
        serverId,
        workspace,
        workspaceAgentActivity: session.workspaceAgentActivity,
      });
      workspaces.push({
        workspaceKey: entry.workspaceKey,
        workspaceId: entry.workspaceId,
        projectName: entry.projectName,
        name: entry.name,
        currentBranch: entry.currentBranch,
        workspaceDirectoryLabel: entry.workspaceDirectoryLabel,
        archiving: Boolean(entry.archivingAt),
      });
    }
    return listWorkspaceTabMoveTargets({ sourceWorkspaceKey, workspaces });
  }, [session, serverId, tab]);
}

function WorkspaceMoveTargetRow({
  workspace,
  workspaceTitleSource,
  onSelect,
}: {
  workspace: WorkspaceTabMoveWorkspace;
  workspaceTitleSource: "title" | "branch";
  onSelect: (workspace: WorkspaceTabMoveWorkspace) => void;
}) {
  const handlePress = useCallback(() => onSelect(workspace), [onSelect, workspace]);
  const rowStyle = useCallback(
    ({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => [
      styles.row,
      (pressed || hovered) && styles.rowHovered,
    ],
    [],
  );
  return (
    <Pressable
      style={rowStyle}
      testID={`workspace-tab-move-target-${workspace.workspaceKey}`}
      onPress={handlePress}
    >
      <Text style={styles.rowTitle} numberOfLines={1}>
        {resolveSidebarWorkspacePrimaryLabel({ workspace, workspaceTitleSource })}
      </Text>
      <Text style={styles.rowSubtitle} numberOfLines={1}>
        {workspace.workspaceDirectoryLabel}
      </Text>
    </Pressable>
  );
}

export function WorkspaceTabMoveSheet({
  tab,
  serverId,
  enabled = true,
  onClose,
}: {
  tab: WorkspaceTabDescriptor | null;
  serverId: string;
  /** Held false while the workspace route is unfocused so the sheet stays shut. */
  enabled?: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const {
    settings: { workspaceTitleSource },
  } = useAppSettings();
  const activeTab = enabled ? tab : null;
  const targets = useMoveTargets(activeTab, serverId);
  const groups = useMemo(() => groupWorkspaceTabMoveTargets(targets), [targets]);

  const handleSelect = useCallback(
    (workspace: WorkspaceTabMoveWorkspace) => {
      if (!activeTab || activeTab.target.kind !== "agent") {
        onClose();
        return;
      }
      const sourceWorkspaceKey = findAgentTabWorkspaceKey(activeTab.target.agentId);
      if (sourceWorkspaceKey && sourceWorkspaceKey !== workspace.workspaceKey) {
        moveAgentTabToWorkspace({
          serverId,
          sourceWorkspaceKey,
          targetWorkspaceKey: workspace.workspaceKey,
          targetWorkspaceId: workspace.workspaceId,
          agentId: activeTab.target.agentId,
          tabId: activeTab.tabId,
        });
      }
      onClose();
    },
    [onClose, serverId, activeTab],
  );

  const header = useMemo(
    () => ({
      title: t("workspace.tabs.moveSheet.title"),
      subtitle: t("workspace.tabs.moveSheet.hint"),
    }),
    [t],
  );

  return (
    <AdaptiveModalSheet
      visible={activeTab !== null}
      onClose={onClose}
      header={header}
      testID="workspace-tab-move-sheet"
      desktopMaxWidth={420}
    >
      {groups.length === 0 ? (
        <Text style={styles.empty}>{t("workspace.tabs.moveSheet.empty")}</Text>
      ) : (
        <ScrollView>
          {groups.map((group) => (
            <View key={group.projectName} style={styles.group}>
              <Text style={styles.groupTitle}>{group.projectName}</Text>
              {group.workspaces.map((workspace) => (
                <WorkspaceMoveTargetRow
                  key={workspace.workspaceKey}
                  workspace={workspace}
                  workspaceTitleSource={workspaceTitleSource}
                  onSelect={handleSelect}
                />
              ))}
            </View>
          ))}
        </ScrollView>
      )}
    </AdaptiveModalSheet>
  );
}

/**
 * Drag a tab chip out of the strip and onto a sidebar workspace row to move
 * it there. The app sidebar lives outside the tab strip's dnd-kit context, so
 * this listens at the document level and only takes over after the pointer
 * has traveled — the built-in tab reorder keeps the first few pixels.
 *
 * The gesture stays silent until the pointer is actually over a workspace row
 * the tab can move to: for the first stretch the user is only reordering tabs,
 * so no drop label or highlight should appear. Native drag gestures draw nothing
 * into React's tree; both affordances are fixed overlays appended to `<body>`.
 * Web/desktop only; never installs on native.
 */
export function useWorkspaceTabMoveDnd(workspaceKey?: string | null): void {
  const { t } = useTranslation();
  const tRef = useRef(t);
  tRef.current = t;
  const workspaceKeyRef = useRef(workspaceKey);
  workspaceKeyRef.current = workspaceKey;

  useEffect(() => {
    if (!isWeb || typeof document === "undefined") {
      return;
    }
    // Imperative read: the drag ghost/highlight are raw DOM mutations, so theme
    // colors are fetched at drag time instead of through a subscription.
    const themeColors = () =>
      (UnistylesRuntime.themeName ? REGISTERED_THEMES[UnistylesRuntime.themeName] : darkTheme)
        .colors;
    let pending: { x: number; y: number; suffix: string } | null = null;
    /** Resolved once per gesture; a non-agent tab has nothing to move. */
    let source: { workspaceKey: string; agentId: string; tabId: string } | null = null;
    let dragging = false;
    let ghost: HTMLDivElement | null = null;
    let highlight: HTMLDivElement | null = null;

    const sidebarRows = (): HTMLElement[] =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          `[data-testid^="${SIDEBAR_WORKSPACE_ROW_TESTID_PREFIX}"]`,
        ),
      );

    /**
     * The part of the row that is actually visible. The sidebar list clips its
     * rows, so a row scrolled half out of the list still has a full bounding
     * box; without intersecting the clipping ancestors a drop near the edge
     * would target a workspace the user cannot see.
     */
    const visibleRect = (
      row: HTMLElement,
    ): { top: number; bottom: number; left: number; right: number } | null => {
      const rect = row.getBoundingClientRect();
      let top = rect.top;
      let bottom = rect.bottom;
      let left = rect.left;
      let right = rect.right;
      for (let node = row.parentElement; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        const clipsX = style.overflowX !== "visible";
        const clipsY = style.overflowY !== "visible";
        if (!clipsX && !clipsY) {
          continue;
        }
        const clip = node.getBoundingClientRect();
        if (clipsX) {
          left = Math.max(left, clip.left);
          right = Math.min(right, clip.right);
        }
        if (clipsY) {
          top = Math.max(top, clip.top);
          bottom = Math.min(bottom, clip.bottom);
        }
        if (right <= left || bottom <= top) {
          return null;
        }
      }
      return { top, bottom, left, right };
    };

    // Rect hit-testing instead of `elementFromPoint`: during a tab drag the
    // dnd-kit DragOverlay and our own ghost sit under the cursor, so point
    // hit-testing reports the overlay and the row underneath is never found.
    const rowAt = (x: number, y: number): HTMLElement | null => {
      for (const row of sidebarRows()) {
        const rect = row.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0 || x < rect.left || x > rect.right) {
          continue;
        }
        if (y < rect.top || y > rect.bottom) {
          continue;
        }
        const visible = visibleRect(row);
        if (
          visible &&
          x >= visible.left &&
          x <= visible.right &&
          y >= visible.top &&
          y <= visible.bottom
        ) {
          return row;
        }
      }
      return null;
    };

    /**
     * Workspace key a drop would target: the row's key when it names another
     * workspace on the same host as the dragged tab, otherwise null.
     */
    const dropTargetKey = (row: HTMLElement | null): string | null => {
      if (!row || !source) {
        return null;
      }
      const targetKey = resolveSidebarDropWorkspaceKey(row.getAttribute("data-testid"));
      if (!targetKey || targetKey === source.workspaceKey) {
        return null;
      }
      // A tab stays on the host that owns the agent — dropping onto another
      // server's workspace row would park a foreign agent's tab there.
      return workspaceKeyServerId(targetKey) === workspaceKeyServerId(source.workspaceKey)
        ? targetKey
        : null;
    };

    const clearHighlight = () => {
      if (highlight?.parentNode) {
        highlight.parentNode.removeChild(highlight);
      }
      highlight = null;
    };
    const clearGhost = () => {
      if (ghost?.parentNode) {
        ghost.parentNode.removeChild(ghost);
      }
      ghost = null;
    };
    const reset = () => {
      clearHighlight();
      clearGhost();
      pending = null;
      source = null;
      dragging = false;
    };

    /**
     * Paint the target row as our own overlay. Mutating the row's inline
     * `outline` is not durable: the sidebar re-renders during a drag and React
     * drops styles it does not own, so the frame would flash and vanish.
     */
    const showHighlight = (row: HTMLElement) => {
      const rect = row.getBoundingClientRect();
      if (!highlight) {
        highlight = document.createElement("div");
        highlight.setAttribute("data-testid", "workspace-tab-move-highlight");
        highlight.style.cssText =
          "position:fixed;z-index:2147483000;pointer-events:none;box-sizing:border-box;";
        document.body.appendChild(highlight);
      }
      const colors = themeColors();
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
      highlight.style.border = `2px solid ${colors.accent}`;
      highlight.style.borderRadius = getComputedStyle(row).borderRadius || "8px";
    };

    const showGhost = (x: number, y: number) => {
      if (!ghost) {
        const colors = themeColors();
        ghost = document.createElement("div");
        ghost.setAttribute("data-testid", "workspace-tab-move-ghost");
        ghost.style.cssText =
          "position:fixed;z-index:2147483001;pointer-events:none;padding:4px 10px;" +
          "border-radius:8px;font-size:12px;box-shadow:0 6px 20px rgba(0,0,0,0.35);" +
          `background:${colors.surface1};color:${colors.foreground};` +
          `border:1px solid ${colors.border};` +
          "font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;";
        ghost.textContent = tRef.current("workspace.tabs.menu.moveToWorkspace");
        document.body.appendChild(ghost);
      }
      ghost.style.left = `${x + 12}px`;
      ghost.style.top = `${y + 12}px`;
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0 || !(event.target instanceof Element)) {
        return;
      }
      const chip = event.target.closest(`[data-testid^="${TAB_CHIP_TESTID_PREFIX}"]`);
      const suffix = chip?.getAttribute("data-testid")?.slice(TAB_CHIP_TESTID_PREFIX.length);
      if (!suffix || NON_CHIP_SUFFIXES.some((prefix) => suffix.startsWith(prefix))) {
        return;
      }
      pending = { x: event.clientX, y: event.clientY, suffix };
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!pending) {
        return;
      }
      if (!dragging) {
        const dist = Math.abs(event.clientX - pending.x) + Math.abs(event.clientY - pending.y);
        if (dist < 8) {
          return;
        }
        const resolved = findAgentTabByTestIdentity(pending.suffix, workspaceKeyRef.current);
        if (!resolved) {
          // Terminal / new-tab / launcher chips stay on the built-in reorder.
          reset();
          return;
        }
        source = resolved;
        dragging = true;
      }
      const row = rowAt(event.clientX, event.clientY);
      if (!dropTargetKey(row)) {
        clearGhost();
        clearHighlight();
        return;
      }
      showGhost(event.clientX, event.clientY);
      if (row) {
        showHighlight(row);
      }
    };
    const onMouseUp = (event: MouseEvent) => {
      if (!pending) {
        return;
      }
      const wasDragging = dragging;
      const releasedSuffix = pending.suffix;
      const row = wasDragging ? rowAt(event.clientX, event.clientY) : null;
      reset();
      if (!wasDragging || !row) {
        return;
      }
      const targetWorkspaceKey = resolveSidebarDropWorkspaceKey(row.getAttribute("data-testid"));
      if (!targetWorkspaceKey) {
        return;
      }
      // Resolve the source again at release instead of trusting the drag-start
      // copy: a close or move that landed mid-drag leaves the cached tab stale,
      // and completing the move would reopen a tab the user just closed.
      const releasedSource = findAgentTabByTestIdentity(releasedSuffix, workspaceKeyRef.current);
      const serverId = workspaceKeyServerId(releasedSource?.workspaceKey);
      if (
        !releasedSource ||
        !serverId ||
        serverId !== workspaceKeyServerId(targetWorkspaceKey) ||
        releasedSource.workspaceKey === targetWorkspaceKey
      ) {
        return;
      }
      const separator = targetWorkspaceKey.indexOf(":");
      if (separator <= 0) {
        return;
      }
      moveAgentTabToWorkspace({
        serverId,
        sourceWorkspaceKey: releasedSource.workspaceKey,
        targetWorkspaceKey,
        targetWorkspaceId: targetWorkspaceKey.slice(separator + 1),
        agentId: releasedSource.agentId,
        tabId: releasedSource.tabId,
      });
    };

    document.addEventListener("mousedown", onMouseDown, true);
    document.addEventListener("mousemove", onMouseMove, true);
    document.addEventListener("mouseup", onMouseUp, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown, true);
      document.removeEventListener("mousemove", onMouseMove, true);
      document.removeEventListener("mouseup", onMouseUp, true);
      reset();
    };
  }, []);
}

const styles = StyleSheet.create((theme) => ({
  empty: {
    color: theme.colors.foregroundMuted,
    paddingVertical: theme.spacing[4],
    textAlign: "center",
  },
  group: {
    paddingVertical: theme.spacing[1],
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[1],
  },
  row: {
    borderRadius: theme.borderRadius.sm,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: theme.spacing[2],
  },
  rowHovered: {
    backgroundColor: theme.colors.surface1,
  },
  rowTitle: {
    color: theme.colors.foreground,
  },
  rowSubtitle: {
    color: theme.colors.foregroundMuted,
    fontSize: 12,
  },
}));
