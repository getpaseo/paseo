// The classic-JSX global must exist before the sidebar module graph evaluates (module-scope JSX
// in the menu), so this side-effect import runs first, ahead of the component import below.
import * as reactClassicGlobal from "../../../test-stubs/react-classic-global";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { within } from "@testing-library/dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarSelectionStore } from "@/stores/sidebar-selection-store";
import { WorkspaceRowInner } from "../sidebar-workspace-list";

// Keep the side-effect import's module in the file (see above) without an unused-var warning.
void reactClassicGlobal;

// App sources compile against the classic JSX runtime, which expects React on the global.
beforeEach(() => vi.stubGlobal("React", React));

/**
 * Real browser, real production row: react-native-web's responder system never delivers a press
 * for a Ctrl-keyed click (`isPrimaryPointerDown` rejects it), so the row applies modifier
 * intents from its own `onPointerDown`/`onPointerUp` pair. This mounts the production
 * `WorkspaceRowInner` and replays the user's sequence through its actual handlers — first
 * ctrl+click, joining clicks, shift range, right-click neutrality.
 */

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const mountedEntry of mounted.splice(0)) {
    act(() => mountedEntry.root.unmount());
    mountedEntry.container.remove();
  }
  act(() => useSidebarSelectionStore.getState().clear());
});

function entry(key: string, serverId = "s1"): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${serverId}:${key}`,
    serverId,
    workspaceId: key,
    projectViewKey: `p-${serverId}`,
    projectName: "project",
    projectRootPath: "/tmp/project",
    workspaceDirectory: "/tmp/project",
    workspaceDirectoryLabel: key,
    projectKind: "git",
    workspaceKind: "worktree",
    background: false,
    name: key,
    title: null,
    pinnedAt: null,
    labels: [],
    currentBranch: null,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  } as unknown as SidebarWorkspaceEntry;
}

function selectionKeys(): string[] {
  return useSidebarSelectionStore.getState().selected.map((target) => target.workspaceKey);
}

function registerOrder(keys: readonly string[]): void {
  useSidebarSelectionStore.getState().setOrder(
    keys.map((key) => {
      const [serverId, workspaceId] = key.split(":");
      return { serverId, workspaceId, workspaceKey: key };
    }),
  );
}

function mountRow(
  workspace: SidebarWorkspaceEntry,
  onPress: () => void = vi.fn(),
): (modifiers?: { ctrlKey?: boolean; shiftKey?: boolean; button?: number }) => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    // createElement rather than JSX: the react-perf lint rule flags function props on JSX, and a
    // test harness's throwaway callbacks are exactly what that rule is not for.
    root.render(
      React.createElement(
        QueryClientProvider,
        { client: queryClient },
        React.createElement(WorkspaceRowInner, {
          workspace,
          selected: false,
          shortcutNumber: null,
          showShortcutBadge: false,
          onPress,
          drag: () => undefined,
          isDragging: false,
          isArchiving: false,
          menuController: null,
          archiveLabel: "Archive",
          archiveStatus: "idle",
          archivePendingLabel: "Archiving...",
          onArchive: () => undefined,
          onCopyPath: () => undefined,
          onRename: () => undefined,
          archiveShortcutKeys: null,
          isPinned: false,
        }),
      ),
    );
  });
  mounted.push({ root, container });

  const row = within(container).getByTestId(`sidebar-workspace-row-${workspace.workspaceKey}`);
  return (modifiers: { ctrlKey?: boolean; shiftKey?: boolean; button?: number } = {}) => {
    const rect = row.getBoundingClientRect();
    const init = {
      bubbles: true,
      composed: true,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      ...modifiers,
    };
    act(() => {
      row.dispatchEvent(
        new PointerEvent("pointerdown", { ...init, button: modifiers.button ?? 0 }),
      );
      row.dispatchEvent(new PointerEvent("pointerup", { ...init, button: modifiers.button ?? 0 }));
    });
  };
}

describe("production workspace row multi-select presses", () => {
  beforeEach(() => {
    registerOrder(["s1:a", "s1:b", "s1:c", "s1:d"]);
  });

  it("counts the first ctrl+click as a selection and does not navigate", () => {
    const onPress = vi.fn();
    const press = mountRow(entry("a"), onPress);
    press({ ctrlKey: true });
    expect(selectionKeys()).toEqual(["s1:a"]);
    expect(onPress).not.toHaveBeenCalled();
  });

  it("a second ctrl+click joins the selection", () => {
    mountRow(entry("a"), vi.fn())({ ctrlKey: true });
    mountRow(entry("b"), vi.fn())({ ctrlKey: true });
    expect(selectionKeys()).toEqual(["s1:a", "s1:b"]);
  });

  it("shift+click extends a range from the anchor across rows", () => {
    mountRow(entry("a"), vi.fn())({ ctrlKey: true });
    mountRow(entry("c"), vi.fn())({ shiftKey: true });
    expect(selectionKeys()).toEqual(["s1:a", "s1:b", "s1:c"]);
  });

  it("a right-click never edits the selection", () => {
    mountRow(entry("a"), vi.fn())({ ctrlKey: true });
    mountRow(entry("b"), vi.fn())({ ctrlKey: true, button: 2 });
    expect(selectionKeys()).toEqual(["s1:a"]);
  });
});
