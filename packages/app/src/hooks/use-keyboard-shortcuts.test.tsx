/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { navigateToWorkspaceMock, routerMock, pathState } = vi.hoisted(() => ({
  navigateToWorkspaceMock: vi.fn(),
  routerMock: {
    back: vi.fn(),
    push: vi.fn(),
    replace: vi.fn(),
  },
  pathState: {
    pathname: "/h/srv/workspace/ws-2",
  },
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("expo-router", () => ({
  usePathname: () => pathState.pathname,
  useRouter: () => routerMock,
}));

vi.mock("@/constants/layout", () => ({
  getIsElectronRuntime: () => true,
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
}));

vi.mock("@/utils/shortcut-platform", () => ({
  getShortcutOs: () => "mac",
}));

vi.mock("@/hooks/use-active-server-id", () => ({
  useActiveServerId: () => "srv",
}));

vi.mock("@/hooks/use-open-project-picker", () => ({
  useOpenProjectPicker: () => vi.fn(),
}));

vi.mock("@/hooks/use-keyboard-shortcut-overrides", () => ({
  useKeyboardShortcutOverrides: () => ({ overrides: {} }),
}));

vi.mock("@/hooks/use-workspace-navigation", () => ({
  navigateToWorkspace: navigateToWorkspaceMock,
}));

import { useKeyboardShortcuts } from "./use-keyboard-shortcuts";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { useKeyboardShortcutsStore } from "@/stores/keyboard-shortcuts-store";
import {
  activateNavigationWorkspaceSelection,
  syncNavigationActiveWorkspace,
} from "@/stores/navigation-active-workspace-store";

function Probe() {
  useKeyboardShortcuts({
    enabled: true,
    isMobile: false,
    toggleAgentList: vi.fn(),
  });

  return null;
}

describe("useKeyboardShortcuts", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    navigateToWorkspaceMock.mockReset();
    routerMock.back.mockReset();
    routerMock.push.mockReset();
    routerMock.replace.mockReset();
    pathState.pathname = "/h/srv/workspace/ws-2";
    syncNavigationActiveWorkspace({ current: null });
    useKeyboardShortcutsStore.setState({
      capturingShortcut: false,
      commandCenterOpen: false,
      sidebarShortcutWorkspaceTargets: [
        { serverId: "srv", workspaceId: "ws-1" },
        { serverId: "srv", workspaceId: "ws-2" },
        { serverId: "srv", workspaceId: "ws-3" },
        { serverId: "srv", workspaceId: "ws-4" },
        { serverId: "srv", workspaceId: "ws-5" },
      ],
    });

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    syncNavigationActiveWorkspace({ current: null });
  });

  it("uses the retained active workspace instead of stale pathname for bracket navigation", async () => {
    activateNavigationWorkspaceSelection({ serverId: "srv", workspaceId: "ws-4" });

    await act(async () => {
      root?.render(<Probe />);
    });

    const event = new KeyboardEvent("keydown", {
      key: "]",
      code: "BracketRight",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(navigateToWorkspaceMock).toHaveBeenCalledWith("srv", "ws-5", {
      currentPathname: "/h/srv/workspace/ws-2",
    });
    expect(event.defaultPrevented).toBe(true);
  });

  it("dispatches Escape as an agent interrupt action", async () => {
    const handleInterrupt = vi.fn(() => true);
    const unregister = keyboardActionDispatcher.registerHandler({
      handlerId: "test-agent-interrupt",
      actions: ["agent.interrupt"],
      enabled: true,
      priority: 100,
      isActive: () => true,
      handle: handleInterrupt,
    });

    await act(async () => {
      root?.render(<Probe />);
    });

    const event = new KeyboardEvent("keydown", {
      key: "Escape",
      code: "Escape",
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(handleInterrupt).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("returns from desktop settings to the retained workspace without browser history back", async () => {
    syncNavigationActiveWorkspace({
      current: {
        getCurrentRoute: () => ({ path: "/h/srv/workspace/ws-2" }),
      },
    });
    pathState.pathname = "/settings/general";

    await act(async () => {
      root?.render(<Probe />);
    });

    const event = new KeyboardEvent("keydown", {
      key: ",",
      code: "Comma",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    window.dispatchEvent(event);

    expect(routerMock.replace).toHaveBeenCalledWith("/h/srv/workspace/ws-2");
    expect(routerMock.back).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
});
