/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserPane } from "@/components/browser-pane.electron";
import {
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import {
  createPaneFindPaneId,
  handlePaneFindKeyboardAction,
  setActivePaneFindPaneId,
} from "@/panels/pane-find-registry";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const updateBrowser = vi.fn();
let browserState = {
  browsersById: {
    "browser-a": {
      id: "browser-a",
      url: "https://example.com",
      title: "",
      faviconUrl: null,
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      lastError: null,
    },
  },
  updateBrowser,
};

const { theme } = vi.hoisted(() => ({
  theme: {
    borderRadius: { md: 6 },
    colors: {
      accent: "#3b82f6",
      border: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      palette: { red: { 500: "#ef4444" } },
      surface0: "#111",
      surface1: "#222",
      surface2: "#333",
    },
    fontSize: { sm: 13, xs: 11 },
    spacing: { 1: 4, 2: 8 },
  },
}));

const desktopBridge = vi.hoisted(() => {
  const foundInPageListeners = new Set<(result: unknown) => void>();
  return {
    foundInPageListeners,
    findInPage: vi.fn<(browserId: string, text: string, options?: unknown) => number>(),
    setActivePane: vi.fn<(browserId: string | null) => Promise<void>>(),
    stopFindInPage: vi.fn<(browserId: string, action: string) => void>(),
    onFoundInPage: vi.fn((_browserId: string, listener: (result: unknown) => void) => {
      const scopedListener = (result: unknown) => listener(result);
      foundInPageListeners.add(scopedListener);
      return () => {
        foundInPageListeners.delete(scopedListener);
      };
    }),
    eventsOn: vi.fn(),
  };
});

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) =>
    function Icon() {
      return React.createElement("span", { "data-icon": name });
    };

  return {
    ArrowLeft: createIcon("ArrowLeft"),
    ArrowRight: createIcon("ArrowRight"),
    ChevronDown: createIcon("ChevronDown"),
    ChevronUp: createIcon("ChevronUp"),
    MousePointer2: createIcon("MousePointer2"),
    RotateCw: createIcon("RotateCw"),
    X: createIcon("X"),
  };
});

vi.mock("react-native", () => {
  const MockView = ({
    children,
    testID,
    style,
  }: {
    children?: React.ReactNode;
    testID?: string;
    style?: unknown;
  }) => React.createElement("div", { "data-testid": testID, style }, children);
  const MockText = ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children);
  const MockPressable = ({
    children,
    disabled,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    disabled?: boolean;
    onPress?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        "data-testid": testID,
        disabled,
        onClick: () => {
          if (!disabled) onPress?.();
        },
        type: "button",
      },
      children,
    );
  const MockTextInput = React.forwardRef<
    HTMLInputElement,
    {
      value?: string;
      onChangeText?: (text: string) => void;
      onFocus?: () => void;
      onKeyPress?: (event: {
        nativeEvent: { key: string; shiftKey?: boolean };
        preventDefault: () => void;
      }) => void;
      onSubmitEditing?: () => void;
      testID?: string;
      placeholder?: string;
    }
  >(function TextInput(
    { value, onChangeText, onFocus, onKeyPress, onSubmitEditing, testID, placeholder },
    ref,
  ) {
    return React.createElement("input", {
      "data-testid": testID,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onChangeText?.(event.currentTarget.value),
      onFocus,
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => {
        onKeyPress?.({
          nativeEvent: { key: event.key, shiftKey: event.shiftKey },
          preventDefault: () => event.preventDefault(),
        });
        if (event.key === "Enter") {
          onSubmitEditing?.();
        }
      },
      placeholder,
      ref,
      value: value ?? "",
    });
  });

  return { Pressable: MockPressable, Text: MockText, TextInput: MockTextInput, View: MockView };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    hairlineWidth: 1,
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/attachments/workspace-attachments-store", () => ({
  buildWorkspaceAttachmentScopeKey: () => "scope-a",
  useWorkspaceAttachments: () => [],
  useWorkspaceAttachmentsStore: (
    selector: (state: { setWorkspaceAttachments: () => void }) => unknown,
  ) => selector({ setWorkspaceAttachments: vi.fn() }),
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => ({
    browser: {
      findInPage: desktopBridge.findInPage,
      onFoundInPage: desktopBridge.onFoundInPage,
      setActivePane: desktopBridge.setActivePane,
      stopFindInPage: desktopBridge.stopFindInPage,
    },
    events: { on: desktopBridge.eventsOn },
  }),
  isElectronRuntime: () => true,
}));

vi.mock("@/constants/layout", () => ({
  WORKSPACE_SECONDARY_HEADER_HEIGHT: 36,
}));

vi.mock("@/stores/browser-store", () => ({
  normalizeWorkspaceBrowserUrl: (url: string) => url,
  useBrowserStore: (selector: (state: typeof browserState) => unknown) => selector(browserState),
}));

type FakeWebview = HTMLDivElement & {
  getURL: ReturnType<typeof vi.fn<() => string>>;
  canGoBack: ReturnType<typeof vi.fn<() => boolean>>;
  canGoForward: ReturnType<typeof vi.fn<() => boolean>>;
  reload: ReturnType<typeof vi.fn<() => void>>;
  stop: ReturnType<typeof vi.fn<() => void>>;
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let webview: FakeWebview | null = null;
let nextRequestId = 1;
let restoreCreateElement: (() => void) | null = null;

const paneInstanceId = createPaneFindPaneId({
  serverId: "server-a",
  workspaceId: "workspace-a",
  paneId: "pane-a",
});

const paneContextValue: PaneContextValue = {
  serverId: "server-a",
  workspaceId: "workspace-a",
  paneInstanceId,
  tabId: "browser_browser-a",
  target: { kind: "browser", browserId: "browser-a" },
  openTab: vi.fn(),
  closeCurrentTab: vi.fn(),
  retargetCurrentTab: vi.fn(),
  openFileInWorkspace: vi.fn(),
};

function installWebviewElementFactory(): void {
  const originalCreateElement = document.createElement.bind(document);
  const createElementSpy = vi.spyOn(document, "createElement");
  const createElement = ((tagName: string, options?: ElementCreationOptions) => {
    if (tagName.toLowerCase() !== "webview") {
      return originalCreateElement(tagName, options);
    }
    const element = originalCreateElement("div") as FakeWebview;
    element.getURL = vi.fn(() => "https://example.com");
    element.canGoBack = vi.fn(() => false);
    element.canGoForward = vi.fn(() => false);
    element.reload = vi.fn();
    element.stop = vi.fn();
    webview = element;
    return element;
  }) as typeof document.createElement;
  createElementSpy.mockImplementation(createElement);
  restoreCreateElement = () => createElementSpy.mockRestore();
}

function renderBrowserPane(input?: { isInteractive?: boolean }): void {
  act(() => {
    root?.render(
      <PaneProvider value={paneContextValue}>
        <PaneFocusProvider
          value={createPaneFocusContextValue({
            isPaneFocused: input?.isInteractive ?? true,
            isWorkspaceFocused: true,
          })}
        >
          <BrowserPane
            browserId="browser-a"
            serverId="server-a"
            workspaceId="workspace-a"
            cwd="/repo"
            isInteractive={input?.isInteractive ?? true}
          />
        </PaneFocusProvider>
      </PaneProvider>,
    );
  });
}

function openFind(): void {
  act(() => {
    setActivePaneFindPaneId(paneInstanceId);
    handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
  });
}

function markWebviewDomReady(): void {
  act(() => {
    webview?.dispatchEvent(new Event("dom-ready"));
  });
}

function inputElement(): HTMLInputElement {
  const input = container?.querySelector('[data-testid="pane-find-input"]');
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input as HTMLInputElement;
}

function changeInput(value: string): void {
  const input = inputElement();
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    valueSetter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function pressKey(key: string, shiftKey = false): void {
  const input = inputElement();
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });
}

function click(testId: string): void {
  const element = container?.querySelector(`[data-testid="${testId}"]`);
  expect(element).toBeInstanceOf(HTMLElement);
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function dispatchFoundInPage(result: {
  requestId?: number;
  activeMatchOrdinal: number;
  matches: number;
}): void {
  act(() => {
    for (const listener of desktopBridge.foundInPageListeners) {
      listener(result);
    }
  });
}

beforeEach(() => {
  updateBrowser.mockClear();
  desktopBridge.findInPage.mockImplementation(() => nextRequestId++);
  desktopBridge.findInPage.mockClear();
  desktopBridge.onFoundInPage.mockClear();
  desktopBridge.setActivePane.mockClear();
  desktopBridge.stopFindInPage.mockClear();
  desktopBridge.eventsOn.mockClear();
  desktopBridge.foundInPageListeners.clear();
  browserState = {
    ...browserState,
    browsersById: {
      "browser-a": {
        id: "browser-a",
        url: "https://example.com",
        title: "",
        faviconUrl: null,
        canGoBack: false,
        canGoForward: false,
        isLoading: false,
        lastError: null,
      },
    },
  };
  nextRequestId = 1;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  installWebviewElementFactory();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  webview = null;
  restoreCreateElement?.();
  restoreCreateElement = null;
});

describe("BrowserPane Electron find", () => {
  it("registers browser find through the shared FindBar and desktop bridge find APIs", () => {
    renderBrowserPane();
    markWebviewDomReady();
    openFind();

    changeInput("needle");

    expect(desktopBridge.onFoundInPage).toHaveBeenCalledWith("browser-a", expect.any(Function));
    expect(desktopBridge.findInPage).toHaveBeenLastCalledWith("browser-a", "needle", {
      forward: true,
      findNext: false,
      matchCase: false,
    });
    expect(container?.textContent).toContain("Searching...");
    dispatchFoundInPage({ requestId: 1, activeMatchOrdinal: 2, matches: 5 });
    expect(container?.textContent).toContain("2 / 5");

    pressKey("Enter");
    expect(desktopBridge.findInPage).toHaveBeenLastCalledWith("browser-a", "needle", {
      forward: true,
      findNext: true,
      matchCase: false,
    });
    dispatchFoundInPage({ requestId: 2, activeMatchOrdinal: 3, matches: 5 });

    pressKey("Enter", true);
    expect(desktopBridge.findInPage).toHaveBeenLastCalledWith("browser-a", "needle", {
      forward: false,
      findNext: true,
      matchCase: false,
    });

    click("pane-find-close");

    expect(desktopBridge.stopFindInPage).toHaveBeenLastCalledWith("browser-a", "clearSelection");
    expect(container?.querySelector('[data-testid="pane-find-input"]')).toBeNull();
  });

  it("cleans browser find selection on empty query, navigation, blur, and unmount", () => {
    renderBrowserPane();
    markWebviewDomReady();
    openFind();
    changeInput("needle");
    dispatchFoundInPage({ requestId: 1, activeMatchOrdinal: 1, matches: 3 });

    changeInput("");
    expect(desktopBridge.stopFindInPage).toHaveBeenLastCalledWith("browser-a", "clearSelection");
    expect(container?.textContent).toContain("0 / 0");
    dispatchFoundInPage({ activeMatchOrdinal: 2, matches: 9 });
    expect(container?.textContent).toContain("0 / 0");

    changeInput("needle");
    expect(container?.textContent).toContain("Searching...");
    act(() => {
      webview?.dispatchEvent(new Event("did-start-loading"));
    });
    expect(desktopBridge.stopFindInPage).toHaveBeenLastCalledWith("browser-a", "clearSelection");
    expect(container?.textContent).toContain("0 / 0");

    act(() => {
      webview?.dispatchEvent(new Event("dom-ready"));
    });
    expect(desktopBridge.findInPage).toHaveBeenLastCalledWith("browser-a", "needle", {
      forward: true,
      findNext: false,
      matchCase: false,
    });

    renderBrowserPane({ isInteractive: false });
    expect(desktopBridge.stopFindInPage).toHaveBeenLastCalledWith("browser-a", "clearSelection");

    act(() => {
      root?.unmount();
    });
    expect(desktopBridge.stopFindInPage).toHaveBeenLastCalledWith("browser-a", "clearSelection");
    expect(desktopBridge.foundInPageListeners.size).toBe(0);
  });

  it("does not call the browser find bridge before dom-ready", () => {
    renderBrowserPane();
    openFind();

    changeInput("needle");
    expect(container?.textContent).toContain("Searching...");
    expect(desktopBridge.findInPage).not.toHaveBeenCalled();

    click("pane-find-close");
    expect(desktopBridge.stopFindInPage).not.toHaveBeenCalled();

    openFind();
    changeInput("needle");
    markWebviewDomReady();
    expect(desktopBridge.findInPage).toHaveBeenLastCalledWith("browser-a", "needle", {
      forward: true,
      findNext: false,
      matchCase: false,
    });
  });
});
