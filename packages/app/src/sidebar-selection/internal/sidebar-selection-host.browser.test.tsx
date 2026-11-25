import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { afterEach, describe, expect, it } from "vitest";
import { SidebarToastRegion } from "@/components/sidebar/sidebar-toast-region";
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
import {
  registerSidebarVisibleWorkspaceKeysReader,
  SidebarSelectionHost,
  useSidebarSelectionStore,
} from "@/sidebar-selection";

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

function mountHost(entries: readonly SidebarWorkspaceEntry[]) {
  const entriesByKey = new Map(entries.map((entry) => [entry.workspaceKey, entry]));
  releaseVisibleKeys = registerSidebarVisibleWorkspaceKeysReader(() =>
    entries.map((entry) => entry.workspaceKey),
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <I18nextProvider i18n={i18n}>
        <SafeAreaProvider>
          <KeyboardActionDispatcherProvider>
            <FallbackArchiveProbe />
            <ToastProvider>
              <SidebarToastRegion active>
                <SidebarToastProbe />
                <SidebarSelectionHost active workspaceEntriesByKey={entriesByKey} />
              </SidebarToastRegion>
            </ToastProvider>
          </KeyboardActionDispatcherProvider>
        </SafeAreaProvider>
      </I18nextProvider>,
    );
  });
}

afterEach(() => {
  capturedDispatcher = null;
  capturedSidebarToast = null;
  fallbackArchiveCount = 0;
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

describe("SidebarSelectionHost", () => {
  it("shows a persistent sidebar toast while selecting, updates without Shift, and exits via button or Escape", async () => {
    mountHost([makeEntry("a"), makeEntry("b"), makeEntry("c")]);
    expect(document.querySelector('[data-testid="workspace-selection-toast"]')).toBeNull();

    // Enter select mode via Shift+click on "a", then plain-click "c" without Shift.
    act(() => {
      useSidebarSelectionStore.getState().pressWorkspace("srv:a", { shiftKey: true });
    });
    expect(document.querySelector('[data-testid="workspace-selection-count"]')?.textContent).toBe(
      "1 selected",
    );

    act(() => {
      useSidebarSelectionStore.getState().pressWorkspace("srv:c", { shiftKey: false });
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
      useSidebarSelectionStore.getState().pressWorkspace("srv:a", { shiftKey: true });
      useSidebarSelectionStore.getState().pressWorkspace("srv:c", { shiftKey: true });
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
      useSidebarSelectionStore.getState().pressWorkspace("srv:a", { shiftKey: false });
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

    // Same while a worktree safety check is in progress.
    act(() => {
      useSidebarSelectionStore.getState().enter("srv:a");
      useSidebarSelectionStore.getState().setArchiving(true);
    });
    act(() => {
      expect(capturedDispatcher?.dispatch({ id: "workspace.archive", scope: "sidebar" })).toBe(
        true,
      );
    });
    expect(fallbackArchiveCount).toBe(1);
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
});
