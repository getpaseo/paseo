import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as Clipboard from "expo-clipboard";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import { i18n } from "@/i18n/i18next";
import type { InlinePathTarget } from "./parse";
import { AssistantFileLinkContextMenuContent } from "./file-context-menu";
import type { AssistantFileLinkSource } from "./resolver";

// Closing the menu runs the popover's web exit animation; under headless Chromium,
// reanimated's layout animation unmount hook (_updatePropsJS) throws this one exact
// known TypeError while the surface unmounts. Match only that signature so any other
// error from the menu still fails the run.
function isKnownMenuCloseAnimationError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    error.message === "Cannot convert undefined or null to object" &&
    String(error.stack ?? "").includes("_updatePropsJS")
  );
}

window.addEventListener("unhandledrejection", (event) => {
  if (isKnownMenuCloseAnimationError(event.reason)) {
    event.preventDefault();
  }
});

window.addEventListener("error", (event) => {
  if (isKnownMenuCloseAnimationError(event.error ?? event.message)) {
    event.preventDefault();
  }
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => {}),
}));

// The browser mocker cannot handle importOriginal() partial mocks of this module, so
// replicate its full export surface for a fake Electron-on-web runtime.
vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
  isDev: false,
  getIsElectron: () => true,
  getIsElectronMac: () => false,
}));

const openTarget = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    editor: {
      listTargets: async () => [
        {
          id: "explorer",
          label: "Explorer",
          kind: "file-manager",
          icon: { kind: "symbol", name: "folder" },
        },
      ],
      openTarget: (...args: unknown[]) => openTarget(...(args as [])),
    },
  }),
}));

vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  shouldUseDesktopDaemon: () => true,
  getDesktopDaemonStatus: async () => ({ serverId: "server-1" }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn(), copied: vi.fn(), error: vi.fn() }),
}));

const SOURCE: AssistantFileLinkSource = {
  href: "file:///C:/Users/test/project/docs/report.html:12",
  text: "C:\\Users\\test\\project\\docs\\report.html:12",
  markup: "linkify",
};

const TARGET: InlinePathTarget = {
  raw: SOURCE.href,
  path: "C:/Users/test/project/docs/report.html",
  lineStart: 12,
  lineEnd: undefined,
};

const onOpen = vi.fn();

interface MountedMenu {
  root: Root;
  container: HTMLDivElement;
}

const mountedMenus: MountedMenu[] = [];

function renderMenu(input: { workspaceRoot?: string } = {}): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  act(() => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <ContextMenu>
          <ContextMenuTrigger contextOnly testID="assistant-file-link-toggle">
            <span>report.html</span>
          </ContextMenuTrigger>
          <AssistantFileLinkContextMenuContent
            source={SOURCE}
            target={TARGET}
            serverId="server-1"
            workspaceRoot={input.workspaceRoot}
            onOpen={onOpen}
            testIDPrefix="assistant-file-link"
          />
        </ContextMenu>
      </QueryClientProvider>,
    );
  });
  mountedMenus.push({ root, container });
}

function openContextMenu(): void {
  const trigger = document.querySelector<HTMLElement>('[data-testid="assistant-file-link-toggle"]');
  if (!trigger) throw new Error("Context menu trigger is not rendered");
  act(() => {
    trigger.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 40 }),
    );
  });
}

async function waitForMenuItem(testID: string): Promise<HTMLElement> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const item = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
    if (item) return item;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Menu item "${testID}" did not appear`);
}

async function clickMenuItem(testID: string): Promise<void> {
  const item = await waitForMenuItem(testID);
  act(() => {
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

beforeAll(async () => {
  await i18n;
});

afterEach(() => {
  for (const mounted of mountedMenus) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
  mountedMenus.length = 0;
  vi.mocked(Clipboard.setStringAsync).mockClear();
  openTarget.mockClear();
  onOpen.mockClear();
});

describe("AssistantFileLinkContextMenuContent", () => {
  it("opens the real context menu and copies the absolute native path", async () => {
    renderMenu({ workspaceRoot: "C:/Users/test/project" });
    openContextMenu();

    await clickMenuItem("assistant-file-link-copy-path");

    await vi.waitFor(() => {
      expect(Clipboard.setStringAsync).toHaveBeenCalledWith(
        "C:\\Users\\test\\project\\docs\\report.html",
      );
    });
  });

  it("reveals the file in the file manager through the desktop bridge", async () => {
    renderMenu({ workspaceRoot: "C:/Users/test/project" });
    openContextMenu();

    await clickMenuItem("assistant-file-link-reveal");

    await vi.waitFor(() => {
      expect(openTarget).toHaveBeenCalledWith({
        editorId: "explorer",
        workspacePath: "C:/Users/test/project",
        filePath: "C:\\Users\\test\\project\\docs\\report.html",
      });
    });
  });

  it("opens the file with the default disposition and supports opening to the side", async () => {
    renderMenu({ workspaceRoot: "C:/Users/test/project" });
    openContextMenu();

    await clickMenuItem("assistant-file-link-open-file");
    await vi.waitFor(() => {
      expect(onOpen).toHaveBeenCalledTimes(1);
    });

    // Selecting an item closes the menu, so the second action reopens it.
    openContextMenu();
    await clickMenuItem("assistant-file-link-open-to-side");

    await vi.waitFor(() => {
      expect(onOpen).toHaveBeenCalledTimes(2);
    });
    expect(onOpen).toHaveBeenNthCalledWith(1, SOURCE, "preferred");
    expect(onOpen).toHaveBeenNthCalledWith(2, SOURCE, "side");
  });

  it("hides reveal for remote daemons while copy and open stay available", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    act(() => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ContextMenu>
            <ContextMenuTrigger contextOnly testID="assistant-file-link-toggle">
              <span>report.html</span>
            </ContextMenuTrigger>
            <AssistantFileLinkContextMenuContent
              source={SOURCE}
              target={TARGET}
              serverId="remote-server-9"
              workspaceRoot="C:/Users/test/project"
              onOpen={onOpen}
              testIDPrefix="assistant-file-link"
            />
          </ContextMenu>
        </QueryClientProvider>,
      );
    });
    mountedMenus.push({ root, container });
    openContextMenu();

    await waitForMenuItem("assistant-file-link-copy-path");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(document.querySelector('[data-testid="assistant-file-link-reveal"]')).toBeNull();

    await clickMenuItem("assistant-file-link-copy-path");
    await vi.waitFor(() => {
      expect(Clipboard.setStringAsync).toHaveBeenCalled();
    });
    expect(openTarget).not.toHaveBeenCalled();
  });
});
