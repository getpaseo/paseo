import { useCallback, useEffect, useMemo, useRef } from "react";
import { useSidebarPersistentToast } from "@/components/sidebar/sidebar-toast-region";
import type { ToastState } from "@/components/toast-host";
import { useToast } from "@/contexts/toast-context";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useOverlayRegistration } from "@/keyboard";
import type { KeyboardActionId } from "@/keyboard/keyboard-action-dispatcher";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { archiveSelectedWorkspaces, createDefaultBulkArchiveDeps } from "./archive-selected";
import {
  useIsSidebarSelectionMode,
  useSidebarSelectionArchiving,
  useSidebarSelectionCount,
  useSidebarSelectionStore,
} from "./selection-store";
import { WorkspaceSelectionToast } from "./workspace-selection-toast";

const SELECTION_TOAST_ID = -1;
const ESCAPE_OVERLAY_KEYS = ["Escape"] as const;
const WORKSPACE_ARCHIVE_ACTIONS: readonly KeyboardActionId[] = ["workspace.archive"];

/**
 * Coordinates sidebar workspace select mode: reconciles removed workspaces, binds Escape and
 * the archive shortcut, and keeps the persistent selection bar up in `SidebarToastRegion`.
 */
export function SidebarSelectionHost({
  active,
  workspaceEntriesByKey,
}: {
  active: boolean;
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
}): null {
  const toast = useToast();
  const activeWorkspaceSelection = useActiveWorkspaceSelection();
  const selectionMode = useIsSidebarSelectionMode();
  const selectedCount = useSidebarSelectionCount();
  const isArchiving = useSidebarSelectionArchiving();

  const entriesRef = useRef(workspaceEntriesByKey);
  entriesRef.current = workspaceEntriesByKey;
  const activeSelectionRef = useRef(activeWorkspaceSelection);
  activeSelectionRef.current = activeWorkspaceSelection;

  useEffect(() => {
    if (!selectionMode) return;
    useSidebarSelectionStore.getState().reconcile(new Set(workspaceEntriesByKey.keys()));
  }, [selectionMode, workspaceEntriesByKey]);

  useEffect(() => {
    if (active) return;
    const state = useSidebarSelectionStore.getState();
    if (state.active && !state.isArchiving) {
      state.exit();
    }
  }, [active]);

  const handleExit = useCallback(() => {
    const state = useSidebarSelectionStore.getState();
    if (state.isArchiving) return;
    state.exit();
  }, []);

  const handleArchiveSelected = useCallback(() => {
    const store = useSidebarSelectionStore.getState();
    if (!store.active || store.isArchiving || store.selectedKeys.size === 0) return;

    const entries: SidebarWorkspaceEntry[] = [];
    for (const key of store.selectedKeys) {
      const entry = entriesRef.current.get(key);
      if (entry && entry.archivingAt === null) {
        entries.push(entry);
      }
    }
    if (entries.length === 0) {
      store.exit();
      return;
    }

    store.setArchiving(true);
    void archiveSelectedWorkspaces({
      workspaces: entries,
      toast,
      onArchiveStarted: () => {
        useSidebarSelectionStore.getState().exit();
      },
      deps: createDefaultBulkArchiveDeps(activeSelectionRef.current),
    }).finally(() => {
      const current = useSidebarSelectionStore.getState();
      if (current.isArchiving) {
        current.setArchiving(false);
      }
    });
  }, [toast]);

  useOverlayRegistration({
    keys: ESCAPE_OVERLAY_KEYS,
    active: selectionMode && active && !isArchiving,
    layer: 0,
    manageFocus: false,
    onKeyDown: (event) => {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      handleExit();
      return true;
    },
  });

  useKeyboardActionHandler({
    handlerId: "sidebar-selection-archive",
    actions: WORKSPACE_ARCHIVE_ACTIONS,
    enabled: selectionMode && active && selectedCount > 0 && !isArchiving,
    priority: 10,
    handle: () => {
      handleArchiveSelected();
      return true;
    },
  });

  const persistentToast = useMemo<ToastState | null>(() => {
    if (!selectionMode || !active) return null;
    return {
      id: SELECTION_TOAST_ID,
      content: (
        <WorkspaceSelectionToast
          selectedCount={selectedCount}
          isArchiving={isArchiving}
          onArchive={handleArchiveSelected}
          onExit={handleExit}
        />
      ),
      nativeMessage: null,
      variant: "default",
      layout: "action",
      durationMs: null,
      testID: "workspace-selection-toast",
    };
  }, [active, handleArchiveSelected, handleExit, isArchiving, selectedCount, selectionMode]);

  useSidebarPersistentToast(persistentToast);

  return null;
}
