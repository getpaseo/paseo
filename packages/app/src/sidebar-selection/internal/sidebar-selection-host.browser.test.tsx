import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React, { act, useCallback } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { Text } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";
import { SidebarToastRegion } from "@/components/sidebar/sidebar-toast-region";
import { SidebarWorkspaceContextMenu } from "@/components/sidebar/sidebar-workspace-menu";
import { ToastProvider, useToast } from "@/contexts/toast-context";
import type { ToastApi } from "@/components/toast-host";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { i18n } from "@/i18n/i18next";
import { dispatchTopOverlayKeyDown } from "@/keyboard";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useLongPressDragInteraction } from "@/components/sidebar/use-long-press-drag-interaction";
import {
  registerSidebarVisibleWorkspaceKeysReader,
  SidebarSelectionHost,
  useIsSidebarSelectionMode,
  useIsWorkspaceBulkSelected,
  useSidebarSelectionStore,
  useWorkspaceSelectionPress,
} from "@/sidebar-selection";
import { getShortcutOs } from "@/utils/shortcut-platform";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let releaseVisibleKeys: (() => void) | null = null;

function makeEntry(id: string): SidebarWorkspaceEntry {
  return {
    workspaceKey: `srv:${id}`,
    workspaceId: id,
    serverId: "srv",
    projectViewKey: "prj-view",
    projectName: "Repo",
    projectRootPath: "/repo",
    workspaceDirectory: `/repo/${id}`,
    workspaceDirectoryLabel: id,
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: id,
    title: null,
    currentBranch: id,
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    pinnedAt: null,
    background: false,
    labels: [],
    scripts: [],
    hasRunningScripts: false,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
  };
}

let capturedDispatcher: ReturnType<typeof useKeyboardActionDispatcher> | null = null;
let capturedSidebarToast: ToastApi | null = null;
let fallbackArchiveCount = 0;

function FallbackArchiveProbe() {
  capturedDispatcher = useKeyboardActionDispatcher();
  useKeyboardActionHandler({
    handlerId: "test-global-workspace-archive-fallback",
    actions: ["workspace.archive"],
    enabled: true,
    priority: 0,
    handle: () => {
      fallbackArchiveCount += 1;
      return true;
    },
  });
  return null;
}

function SidebarToastProbe() {
  capturedSidebarToast = useToast();
  return null;
}

const noop = () => {};
let navigatedKeys: string[] = [];
const rowLongPressRefs = new Map<string, { current: boolean }>();

function SelectableRowProbe({ entry }: { entry: SidebarWorkspaceEntry }) {
  const isSelectionMode = useIsSidebarSelectionMode();
  const isBulkSelected = useIsWorkspaceBulkSelected(entry.workspaceKey);
  const handleNavigate = useCallback(() => {
    navigatedKeys.push(entry.workspaceKey);
  }, [entry.workspaceKey]);
  // The row's gesture state, wired the way sidebar rows wire it.
  const interaction = useLongPressDragInteraction({ drag: noop, menuController: null });
  rowLongPressRefs.set(entry.workspaceKey, interaction.didLongPressRef);
  const { onPress, onPressIn } = useWorkspaceSelectionPress({
    workspaceKey: entry.workspaceKey,
    onNavigate: handleNavigate,
    onPressIn: interaction.handlePressIn,
  });
  return (
    <SidebarWorkspaceContextMenu
      contextMenuOpen={false}
      onContextMenuOpenChange={noop}
      workspace={entry}
      workspaceKey={entry.workspaceKey}
      enabled={!isSelectionMode}
      accessibilityRole={isSelectionMode ? "checkbox" : "button"}
      aria-checked={isSelectionMode ? isBulkSelected : undefined}
      highlightStyle={undefined}
      onPress={onPress}
      onPressIn={onPressIn}
      testID={`sidebar-workspace-row-${entry.workspaceKey}`}
    >
      <Text>{entry.name}</Text>
    </SidebarWorkspaceContextMenu>
  );
}

function mountHost(entries: readonly SidebarWorkspaceEntry[]) {
  const entriesByKey = new Map(entries.map((entry) => [entry.workspaceKey, entry]));
  releaseVisibleKeys = registerSidebarVisibleWorkspaceKeysReader(() =>
    entries.map((entry) => entry.workspaceKey),
  );
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  // Give the sidebar room so the floating selection bar sits below the rows instead of on them.
  container.style.cssText = "display:flex;flex-direction:column;width:320px;height:640px;";
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <SafeAreaProvider>
            <KeyboardActionDispatcherProvider>
              <FallbackArchiveProbe />
              <ToastProvider>
                <SidebarToastRegion active>
                  <SidebarToastProbe />
                  {entries.map((entry) => (
                    <SelectableRowProbe key={entry.workspaceKey} entry={entry} />
                  ))}
                  <SidebarSelectionHost active workspaceEntriesByKey={entriesByKey} />
                </SidebarToastRegion>
              </ToastProvider>
            </KeyboardActionDispatcherProvider>
          </SafeAreaProvider>
        </I18nextProvider>
      </QueryClientProvider>,
    );
  });
}

afterEach(() => {
  capturedDispatcher = null;
  capturedSidebarToast = null;
  fallbackArchiveCount = 0;
  navigatedKeys = [];
  rowLongPressRefs.clear();
  act(() => {
    useSidebarSelectionStore.getState().exit();
  });
  releaseVisibleKeys?.();
  releaseVisibleKeys = null;
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function row(id: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    `[data-testid="sidebar-workspace-row-srv:${id}"]`,
  );
  if (!element) throw new Error(`Row ${id} is not mounted`);
  return element;
}

function selectedIds(): string[] {
  const state = useSidebarSelectionStore.getState();
  if (!state.active) return [];
  return [...state.selectedKeys].map((key) => key.replace("srv:", "")).sort();
}

function markGestureCanceled(id: string) {
  const ref = rowLongPressRefs.get(`srv:${id}`);
  if (!ref) throw new Error(`Row ${id} is not mounted`);
  ref.current = true;
}

/** Holds the primary mouse button on a row past the long-press delay, then releases it. */
async function slowClick(element: HTMLElement) {
  const box = element.getBoundingClientRect();
  const init = {
    bubbles: true,
    cancelable: true,
    button: 0,
    clientX: box.left + box.width / 2,
    clientY: box.top + box.height / 2,
  };
  element.dispatchEvent(new MouseEvent("mousedown", { ...init, buttons: 1 }));
  await new Promise((resolve) => setTimeout(resolve, 700));
  element.dispatchEvent(new MouseEvent("mouseup", init));
  element.dispatchEvent(new MouseEvent("click", init));
}

// Cmd on macOS, Ctrl on Windows and Linux, matching the shortcut layer's `mod`.
const MOD_KEY = getShortcutOs() === "mac" ? "Meta" : "Control";

describe("sidebar workspace row presses", () => {
  it("enters select mode on the Cmd/Ctrl+clicked row alone and toggles rows without navigating", async () => {
    mountHost(["a", "b", "c", "d"].map(makeEntry));

    await userEvent.click(row("a"));
    expect(navigatedKeys).toEqual(["srv:a"]);
    expect(useSidebarSelectionStore.getState().active).toBe(false);

    await userEvent.click(row("c"), { modifiers: [MOD_KEY] });
    expect(selectedIds()).toEqual(["c"]);

    await userEvent.click(row("b"), { modifiers: [MOD_KEY] });
    await userEvent.click(row("d"), { modifiers: [MOD_KEY] });
    expect(selectedIds()).toEqual(["b", "c", "d"]);

    await userEvent.click(row("c"), { modifiers: [MOD_KEY] });
    expect(selectedIds()).toEqual(["b", "d"]);

    // Plain clicks keep toggling while select mode is on.
    await userEvent.click(row("a"));
    expect(selectedIds()).toEqual(["a", "b", "d"]);
    expect(navigatedKeys).toEqual(["srv:a"]);
  });

  it("selects on the first modifier or select-mode click after an earlier gesture ended as a long press", async () => {
    mountHost(["a", "b"].map(makeEntry));

    // A scroll, swipe, drag, or long-press menu leaves the flag set without firing onPress.
    // Ctrl+click on Windows/Linux gets no press-in on web, so nothing clears it first.
    markGestureCanceled("a");
    await userEvent.click(row("a"), { modifiers: [MOD_KEY] });
    expect(selectedIds()).toEqual(["a"]);

    markGestureCanceled("b");
    await userEvent.click(row("b"));
    expect(selectedIds()).toEqual(["a", "b"]);
  });

  it("opens a row on a slow click and still selects it on the next Cmd/Ctrl+click", async () => {
    mountHost(["a", "b"].map(makeEntry));

    await act(() => slowClick(row("a")));
    expect(navigatedKeys).toEqual(["srv:a"]);

    await userEvent.click(row("a"), { modifiers: [MOD_KEY] });
    expect(selectedIds()).toEqual(["a"]);
  });

  it("enters select mode on the Shift+clicked row alone, then extends and shrinks the range", async () => {
    mountHost(["a", "b", "c", "d", "e", "f"].map(makeEntry));

    await userEvent.click(row("b"), { modifiers: ["Shift"] });
    expect(selectedIds()).toEqual(["b"]);

    await userEvent.click(row("e"), { modifiers: ["Shift"] });
    expect(selectedIds()).toEqual(["b", "c", "d", "e"]);

    await userEvent.click(row("c"), { modifiers: ["Shift"] });
    expect(selectedIds()).toEqual(["b", "c"]);

    // Cmd/Ctrl+click moves the anchor; the next Shift range grows from there and keeps b..c.
    await userEvent.click(row("f"), { modifiers: [MOD_KEY] });
    await userEvent.click(row("e"), { modifiers: ["Shift"] });
    expect(selectedIds()).toEqual(["b", "c", "e", "f"]);
    expect(navigatedKeys).toEqual([]);
  });
});

describe("SidebarSelectionHost", () => {
  it("shows a persistent sidebar toast while selecting, updates without Shift, and exits via button or Escape", async () => {
    mountHost([makeEntry("a"), makeEntry("b"), makeEntry("c")]);
    expect(document.querySelector('[data-testid="workspace-selection-toast"]')).toBeNull();

    // Enter select mode via Shift+click on "a", then plain-click "c" without Shift.
    act(() => {
      useSidebarSelectionStore.getState().pressWorkspace("srv:a", { range: true });
    });
    expect(document.querySelector('[data-testid="workspace-selection-count"]')?.textContent).toBe(
      "1 selected",
    );

    act(() => {
      useSidebarSelectionStore.getState().pressWorkspace("srv:c", { range: false });
    });
    expect(document.querySelector('[data-testid="workspace-selection-count"]')?.textContent).toBe(
      "2 selected",
    );

    // Clicking the Exit button leaves select mode and fades the persistent toast out.
    const exitButton = document.querySelector<HTMLElement>(
      '[data-testid="workspace-selection-exit"]',
    );
    expect(exitButton).not.toBeNull();
    act(() => {
      exitButton?.click();
    });
    expect(useSidebarSelectionStore.getState().active).toBe(false);
    await expect
      .poll(() => document.querySelector('[data-testid="workspace-selection-toast"]'))
      .toBeNull();

    // Re-enter with Shift+click, then Shift+click "c" for a range of 3, and exit with Escape.
    act(() => {
      useSidebarSelectionStore.getState().pressWorkspace("srv:a", { range: true });
      useSidebarSelectionStore.getState().pressWorkspace("srv:c", { range: true });
    });
    expect(document.querySelector('[data-testid="workspace-selection-count"]')?.textContent).toBe(
      "3 selected",
    );

    let prevented = false;
    act(() => {
      const handled = dispatchTopOverlayKeyDown({
        key: "Escape",
        code: "Escape",
        altKey: false,
        ctrlKey: false,
        metaKey: false,
        shiftKey: false,
        repeat: false,
        preventDefault: () => {
          prevented = true;
        },
        stopPropagation: () => {},
      });
      expect(handled).toBe(true);
    });
    expect(prevented).toBe(true);
    expect(useSidebarSelectionStore.getState().active).toBe(false);
    await expect
      .poll(() => document.querySelector('[data-testid="workspace-selection-toast"]'))
      .toBeNull();
  });

  it("consumes workspace.archive while in select mode even with zero rows selected or while archiving", () => {
    mountHost([makeEntry("a"), makeEntry("b")]);

    // Outside select mode, the global fallback receives workspace.archive.
    act(() => {
      expect(capturedDispatcher?.dispatch({ id: "workspace.archive", scope: "sidebar" })).toBe(
        true,
      );
    });
    expect(fallbackArchiveCount).toBe(1);

    // Enter select mode then deselect the only row -> 0 selected.
    act(() => {
      useSidebarSelectionStore.getState().enter("srv:a");
      useSidebarSelectionStore.getState().pressWorkspace("srv:a", { range: false });
    });
    expect(document.querySelector('[data-testid="workspace-selection-count"]')?.textContent).toBe(
      "0 selected",
    );

    // The archive shortcut must be absorbed by select mode rather than archiving the open workspace.
    act(() => {
      expect(capturedDispatcher?.dispatch({ id: "workspace.archive", scope: "sidebar" })).toBe(
        true,
      );
    });
    expect(fallbackArchiveCount).toBe(1);

    // Same while a worktree safety check is in progress (both archive shortcut and Escape stay owned).
    act(() => {
      useSidebarSelectionStore.getState().enter("srv:a");
      useSidebarSelectionStore.getState().setArchiving(true);
    });
    act(() => {
      expect(capturedDispatcher?.dispatch({ id: "workspace.archive", scope: "sidebar" })).toBe(
        true,
      );
      expect(
        dispatchTopOverlayKeyDown({
          key: "Escape",
          code: "Escape",
          altKey: false,
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          repeat: false,
          preventDefault: () => {},
          stopPropagation: () => {},
        }),
      ).toBe(true);
    });
    expect(fallbackArchiveCount).toBe(1);
    expect(useSidebarSelectionStore.getState().active).toBe(true);
  });

  it("keeps the selection bar visible when an Undo toast is already displayed in the sidebar", () => {
    mountHost([makeEntry("a"), makeEntry("b")]);

    let dismissUndo: (() => void) | undefined;
    act(() => {
      dismissUndo = capturedSidebarToast?.show("Workspace archived", {
        durationMs: 6000,
        testID: "workspace-archived-toast",
      });
    });
    expect(document.querySelector('[data-testid="workspace-archived-toast"]')).not.toBeNull();

    act(() => {
      useSidebarSelectionStore.getState().enter("srv:a");
    });

    // Both the Undo toast and the selection bar (count, Archive, Exit) must remain visible.
    expect(document.querySelector('[data-testid="workspace-archived-toast"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workspace-selection-toast"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workspace-selection-count"]')?.textContent).toBe(
      "1 selected",
    );
    expect(document.querySelector('[data-testid="workspace-selection-archive"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="workspace-selection-exit"]')).not.toBeNull();

    act(() => {
      dismissUndo?.();
    });
  });

  it("toggles focused workspace checkboxes when pressing Space in select mode", () => {
    mountHost([makeEntry("a"), makeEntry("b")]);

    act(() => {
      useSidebarSelectionStore.getState().enter("srv:a");
    });

    const rowB = document.querySelector<HTMLElement>('[data-testid="sidebar-workspace-row-srv:b"]');
    expect(rowB?.getAttribute("role")).toBe("checkbox");
    expect(rowB?.getAttribute("aria-checked")).toBe("false");

    act(() => {
      rowB?.focus();
      rowB?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
      rowB?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", repeat: true, bubbles: true, cancelable: true }),
      );
    });
    expect(rowB?.getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[data-testid="workspace-selection-count"]')?.textContent).toBe(
      "2 selected",
    );

    act(() => {
      rowB?.dispatchEvent(
        new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
      );
    });
    expect(rowB?.getAttribute("aria-checked")).toBe("false");
    expect(document.querySelector('[data-testid="workspace-selection-count"]')?.textContent).toBe(
      "1 selected",
    );
  });
});
