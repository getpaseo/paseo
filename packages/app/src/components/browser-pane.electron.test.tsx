import { JSDOM } from "jsdom";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPane } from "./browser-pane.electron";
import { paneFindController } from "@/pane-find/pane-find-controller";
import { useBrowserStore } from "@/stores/browser-store";

const { theme, mockDesktopHost, testPaneId } = vi.hoisted(() => ({
  testPaneId: "test-server:test-workspace:test-tab",
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderRadius: { md: 6, lg: 8, sm: 4 },
    fontSize: { sm: 14, xs: 12 },
    colors: {
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      border: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      accent: "#0a84ff",
      palette: { red: { 500: "#f00" } },
    },
  },
  mockDesktopHost: {
    browser: {
      findInPage: vi.fn(),
      stopFindInPage: vi.fn(),
      onFoundInPage: vi.fn(),
      captureElement: vi.fn(),
      copyElement: vi.fn(),
      registerWorkspaceBrowser: vi.fn(),
      unregisterWorkspaceBrowser: vi.fn(),
    },
    events: {
      on: vi.fn(),
    },
  },
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => mockDesktopHost,
  isElectronRuntime: () => true,
}));

// The browser pane reads its find key from pane context; provide a fixed key so
// the test can drive the central find-focus authority directly.
vi.mock("@/panels/pane-context", () => ({
  usePaneFindKey: () => testPaneId,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) => {
      if (key === "paneFind.matchCount") {
        const matchesCount = (options as Record<string, unknown> | undefined)?.count;
        return `${matchesCount} matches`;
      }
      return key;
    },
  }),
}));

vi.mock("lucide-react-native", () => {
  const DummyIcon = () => null;
  return {
    ArrowLeft: DummyIcon,
    ArrowRight: DummyIcon,
    Camera: DummyIcon,
    ChevronDown: DummyIcon,
    ChevronUp: DummyIcon,
    Maximize: DummyIcon,
    Monitor: DummyIcon,
    MousePointer2: DummyIcon,
    RotateCw: DummyIcon,
    Search: DummyIcon,
    Smartphone: DummyIcon,
    Tablet: DummyIcon,
    Wrench: DummyIcon,
    X: DummyIcon,
  };
});

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(),
  getStringAsync: vi.fn(),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({
    show: vi.fn(),
  }),
}));

vi.mock("@/attachments/service", () => ({
  persistAttachmentFromDataUrl: vi.fn(),
}));

vi.mock("@/attachments/workspace-attachments-store", () => ({
  buildWorkspaceAttachmentScopeKey: () => "mock-scope-key",
  useWorkspaceAttachments: () => [],
  useWorkspaceAttachmentsStore: () => vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as Function)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
  withUnistyles:
    (Comp: React.ComponentType<unknown>, mapping?: (t: typeof theme) => Record<string, unknown>) =>
    (props: Record<string, unknown>) =>
      React.createElement(Comp, { ...props, ...mapping?.(theme) }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => children,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => children,
}));

vi.mock("./browser-webview-resident", () => ({
  prepareBrowserWebview: vi.fn(),
  releaseResidentBrowserWebview: vi.fn(),
  takeResidentBrowserWebview: () => null,
}));

describe("BrowserPane Electron find", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let originalCreateElement: typeof document.createElement;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
    Object.defineProperty(dom.window.document, "documentMode", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(dom.window.HTMLInputElement.prototype, "attachEvent", {
      value: undefined,
      writable: true,
      configurable: true,
    });
    if (globalThis.document) {
      Object.defineProperty(globalThis.document, "documentMode", {
        value: undefined,
        writable: true,
        configurable: true,
      });
    }
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("HTMLInputElement", dom.window.HTMLInputElement);
    vi.stubGlobal("KeyboardEvent", dom.window.KeyboardEvent);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("navigator", dom.window.navigator);

    originalCreateElement = document.createElement;
    document.createElement = function (tagName: string, options?: ElementCreationOptions) {
      const el = (
        originalCreateElement as (
          this: Document,
          tag: string,
          opts?: ElementCreationOptions,
        ) => HTMLElement
      ).call(document, tagName, options);
      if (tagName === "webview") {
        const webviewEl = el as unknown as Record<string, unknown>;
        webviewEl.getURL = () => "https://example.com";
        webviewEl.canGoBack = () => false;
        webviewEl.canGoForward = () => false;
      }
      return el;
    } as unknown as typeof document.createElement;

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    mockDesktopHost.browser.findInPage.mockReset();
    mockDesktopHost.browser.findInPage.mockResolvedValue(1);
    mockDesktopHost.browser.stopFindInPage.mockReset();
    mockDesktopHost.browser.onFoundInPage.mockReset();
    mockDesktopHost.browser.onFoundInPage.mockReturnValue(vi.fn());

    useBrowserStore.setState({
      browsersById: {
        "test-browser": {
          browserId: "test-browser",
          createdAt: 0,
          url: "https://example.com",
          title: "Example",
          isLoading: false,
          canGoBack: false,
          canGoForward: false,
          lastError: null,
          faviconUrl: null,
        },
      },
    });
  });

  afterEach(() => {
    paneFindController.clearFocusedPaneIfCurrent(testPaneId);
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container = null;
    document.createElement = originalCreateElement;
    vi.unstubAllGlobals();
  });

  function renderPane(isInteractive = true) {
    act(() => {
      root?.render(
        <BrowserPane
          browserId="test-browser"
          serverId="test-server"
          workspaceId="test-workspace"
          cwd="/mock/cwd"
          isInteractive={isInteractive}
        />,
      );
    });
    // Simulate the central find-focus authority (WorkspacePaneContent) marking
    // this pane's slot as focused.
    act(() => {
      paneFindController.setFocusedPane(testPaneId);
    });
  }

  it("registers browser find adapter and routes commands", async () => {
    renderPane(true);

    expect(paneFindController.getFocusedPane()).toBe(testPaneId);
    expect(paneFindController.getActiveAdapter()).not.toBeNull();

    // 1. Find Initialization
    act(() => {
      paneFindController.openActive();
    });

    const input = container?.querySelector(
      '[data-testid="pane-find-input"]',
    ) as HTMLInputElement | null;
    expect(input).not.toBeNull();

    // 2. IPC Delegation
    act(() => {
      paneFindController.setQueryActive("hello");
    });
    expect(mockDesktopHost.browser.findInPage).toHaveBeenCalledWith("test-browser", "hello", {
      findNext: false,
      forward: true,
    });

    // 3. Paging Cycle
    act(() => {
      paneFindController.selectNextActive();
    });
    expect(mockDesktopHost.browser.findInPage).toHaveBeenLastCalledWith("test-browser", "hello", {
      findNext: true,
      forward: true,
    });

    act(() => {
      paneFindController.selectPrevActive();
    });
    expect(mockDesktopHost.browser.findInPage).toHaveBeenLastCalledWith("test-browser", "hello", {
      findNext: true,
      forward: false,
    });

    // 4. Counter States
    await act(async () => {
      await Promise.resolve();
    });
    const onFoundInPageMock = mockDesktopHost.browser.onFoundInPage;
    expect(onFoundInPageMock).toHaveBeenCalled();
    const listener = onFoundInPageMock.mock.calls[0][1];

    // Simulating counter states
    act(() => {
      listener({
        requestId: 1,
        activeMatchOrdinal: 2,
        matches: 5,
        finalUpdate: true,
      });
    });

    // Verify counter matches text rendering
    const textNodes = Array.from(container?.querySelectorAll("span, div") ?? []);
    const matchCountNode = textNodes.find((node) => node.textContent === "5 matches");
    expect(matchCountNode?.textContent).toBe("5 matches");

    // 5. Cleanups
    act(() => {
      paneFindController.closeActive();
    });
    expect(mockDesktopHost.browser.stopFindInPage).toHaveBeenCalledWith(
      "test-browser",
      "clearSelection",
    );
  });

  it("ignores found-in-page results from superseded requests", async () => {
    mockDesktopHost.browser.findInPage.mockResolvedValueOnce(1).mockResolvedValueOnce(2);
    renderPane(true);
    act(() => {
      paneFindController.openActive();
      paneFindController.setQueryActive("foo");
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      paneFindController.setQueryActive("foobar");
    });
    await act(async () => {
      await Promise.resolve();
    });

    const listener = mockDesktopHost.browser.onFoundInPage.mock.calls[0][1];
    act(() => {
      listener({
        requestId: 1,
        activeMatchOrdinal: 1,
        matches: 2,
        finalUpdate: true,
      });
    });
    expect(container?.textContent).not.toContain("2 matches");

    act(() => {
      listener({
        requestId: 2,
        activeMatchOrdinal: 2,
        matches: 3,
        finalUpdate: true,
      });
    });
    expect(container?.textContent).toContain("3 matches");
  });

  it("clears pending find state when browser IPC returns null", async () => {
    mockDesktopHost.browser.findInPage.mockResolvedValue(null);
    renderPane(true);

    act(() => {
      paneFindController.openActive();
      paneFindController.setQueryActive("foo");
    });

    await act(async () => {
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("paneFind.noMatches");
  });
});
