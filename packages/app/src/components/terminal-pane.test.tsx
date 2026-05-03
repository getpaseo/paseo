/**
 * @vitest-environment jsdom
 */
import React, { act, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPane } from "@/components/terminal-pane";
import type { TerminalEmulatorHandle } from "@/components/terminal-emulator";
import {
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
  type PaneContextValue,
} from "@/panels/pane-context";
import {
  clearActivePaneFindPaneId,
  handlePaneFindKeyboardAction,
  setActivePaneFindPaneId,
} from "@/panels/pane-find-registry";

interface FindResultChange {
  resultIndex: number;
  resultCount: number;
}

const { client, findListeners, terminalProps, theme, terminalHandle, resetTerminalHandle } =
  vi.hoisted(() => {
    const listeners: Array<(event: FindResultChange) => void> = [];
    const handle = {
      writeOutput: vi.fn(),
      renderSnapshot: vi.fn(),
      clear: vi.fn(),
      findNext: vi.fn(() => true),
      findPrevious: vi.fn(() => true),
      clearFindDecorations: vi.fn(),
      onFindResultsChanged: vi.fn((listener: (event: FindResultChange) => void) => {
        listeners.push(listener);
        return () => {
          const index = listeners.indexOf(listener);
          if (index >= 0) {
            listeners.splice(index, 1);
          }
        };
      }),
    };
    return {
      client: {
        on: vi.fn(() => () => {}),
        sendTerminalInput: vi.fn(),
      },
      findListeners: listeners,
      terminalProps: {
        current: null as null | {
          onTerminalKey?: (input: {
            key: string;
            ctrl: boolean;
            shift: boolean;
            alt: boolean;
            meta: boolean;
          }) => Promise<void> | void;
        },
      },
      terminalHandle: handle,
      resetTerminalHandle: () => {
        handle.writeOutput.mockClear();
        handle.renderSnapshot.mockClear();
        handle.clear.mockClear();
        handle.findNext.mockClear();
        handle.findPrevious.mockClear();
        handle.clearFindDecorations.mockClear();
        handle.onFindResultsChanged.mockClear();
        listeners.splice(0);
      },
      theme: {
        spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
        fontSize: { xs: 11, sm: 13 },
        fontWeight: { medium: "500" as const },
        borderRadius: { md: 6 },
        colors: {
          background: "#000",
          border: "#333",
          destructive: "#f43f5e",
          foreground: "#fff",
          foregroundMuted: "#aaa",
          primary: "#0a84ff",
          surface0: "#111",
          surface1: "#222",
          surface2: "#333",
          terminal: {
            background: "#000",
            foreground: "#fff",
            cursor: "#fff",
            cursorAccent: "#000",
            selectionBackground: "#444",
            selectionForeground: "#fff",
            black: "#000",
            red: "#f00",
            green: "#0f0",
            yellow: "#ff0",
            blue: "#00f",
            magenta: "#f0f",
            cyan: "#0ff",
            white: "#fff",
            brightBlack: "#555",
            brightRed: "#f55",
            brightGreen: "#5f5",
            brightYellow: "#ff5",
            brightBlue: "#55f",
            brightMagenta: "#f5f",
            brightCyan: "#5ff",
            brightWhite: "#fff",
          },
        },
      },
    };
  });

vi.mock("react-native", () => {
  const MockView = ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children);
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
          if (!disabled) {
            onPress?.();
          }
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
      onKeyPress?: (event: {
        nativeEvent: { key: string; shiftKey?: boolean };
        preventDefault: () => void;
      }) => void;
      testID?: string;
      placeholder?: string;
    }
  >(function TextInput({ value, onChangeText, onKeyPress, testID, placeholder }, ref) {
    return React.createElement("input", {
      "data-testid": testID,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
        onChangeText?.(event.currentTarget.value),
      onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) =>
        onKeyPress?.({
          nativeEvent: { key: event.key, shiftKey: event.shiftKey },
          preventDefault: () => event.preventDefault(),
        }),
      placeholder,
      ref,
      value: value ?? "",
    });
  });

  return {
    ActivityIndicator: () => React.createElement("span", { "data-testid": "activity" }),
    Pressable: MockPressable,
    ScrollView: MockView,
    Text: MockText,
    TextInput: MockTextInput,
    View: MockView,
  };
});

vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("div", null, children),
  },
  runOnJS: (fn: () => void) => fn,
  useAnimatedReaction: vi.fn(),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    absoluteFillObject: {},
    hairlineWidth: 1,
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) =>
    function Icon() {
      return React.createElement("span", { "data-icon": name });
    };
  return {
    ChevronDown: createIcon("ChevronDown"),
    ChevronUp: createIcon("ChevronUp"),
    X: createIcon("X"),
  };
});

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => client,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/hooks/use-app-visible", () => ({
  useAppVisible: () => true,
}));

vi.mock("@/hooks/use-keyboard-shift-style", () => ({
  useKeyboardShiftStyle: () => ({
    shift: { value: 0 },
    style: null,
  }),
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("@/stores/panel-store", () => ({
  usePanelStore: (
    selector: (state: { mobileView: string; showMobileAgentList: () => void }) => unknown,
  ) => selector({ mobileView: "agent", showMobileAgentList: vi.fn() }),
}));

vi.mock("@/terminal/runtime/workspace-terminal-session", () => ({
  getWorkspaceTerminalSession: () => ({
    snapshots: {
      clear: vi.fn(),
      get: vi.fn(() => null),
      set: vi.fn(),
    },
  }),
}));

vi.mock("@/terminal/runtime/terminal-stream-controller", () => ({
  TerminalStreamController: class {
    dispose() {}
    setTerminal() {}
  },
}));

vi.mock("@/components/terminal-emulator", () => ({
  default: React.forwardRef<TerminalEmulatorHandle, { testId?: string; onTerminalKey?: unknown }>(
    function TerminalEmulator(props, ref) {
      terminalProps.current = props as typeof terminalProps.current;
      useImperativeHandle(ref, () => terminalHandle);
      return React.createElement("div", { "data-testid": props.testId ?? "terminal-surface" });
    },
  ),
}));

const paneInstanceId = "server-a:workspace-a:left";
const paneContext: PaneContextValue = {
  serverId: "server-a",
  workspaceId: "workspace-a",
  paneInstanceId,
  tabId: "terminal",
  target: { kind: "terminal", terminalId: "terminal-a" },
  openTab: () => {},
  closeCurrentTab: () => {},
  retargetCurrentTab: () => {},
  openFileInWorkspace: () => {},
};
const paneFocus = createPaneFocusContextValue({
  isPaneFocused: true,
  isWorkspaceFocused: true,
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resetTerminalHandle();
  client.sendTerminalInput.mockClear();
  client.on.mockClear();
  terminalProps.current = null;
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
  clearActivePaneFindPaneId(paneInstanceId);
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

function renderTerminalPane(): void {
  act(() => {
    root?.render(
      <PaneProvider value={paneContext}>
        <PaneFocusProvider value={paneFocus}>
          <TerminalPane
            serverId="server-a"
            cwd="/repo"
            terminalId="terminal-a"
            isWorkspaceFocused
            isPaneFocused
            onOpenFileExplorer={vi.fn()}
          />
        </PaneFocusProvider>
      </PaneProvider>,
    );
  });
  setActivePaneFindPaneId(paneInstanceId);
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

function pressFindKey(key: string, shiftKey = false): void {
  act(() => {
    inputElement().dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey, bubbles: true }));
  });
}

function click(testId: string): void {
  const element = container?.querySelector(`[data-testid="${testId}"]`);
  expect(element).toBeInstanceOf(HTMLElement);
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function emitFindResults(event: FindResultChange): void {
  act(() => {
    for (const listener of findListeners) {
      listener(event);
    }
  });
}

describe("TerminalPane find", () => {
  it("searches through xterm, navigates matches, and clears decorations", () => {
    renderTerminalPane();

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    changeInput("needle");
    expect(container?.textContent).toContain("Searching...");
    emitFindResults({ resultIndex: 2, resultCount: 7 });

    expect(terminalHandle.findNext).toHaveBeenCalledWith({ query: "needle" });
    expect(container?.textContent).toContain("3 / 7");

    click("pane-find-next");
    expect(terminalHandle.findNext).toHaveBeenLastCalledWith({ query: "needle" });
    expect(container?.textContent).toContain("Searching...");
    emitFindResults({ resultIndex: 3, resultCount: 7 });

    click("pane-find-prev");
    expect(terminalHandle.findPrevious).toHaveBeenLastCalledWith({ query: "needle" });
    emitFindResults({ resultIndex: 2, resultCount: 7 });

    pressFindKey("Enter");
    expect(terminalHandle.findNext).toHaveBeenLastCalledWith({ query: "needle" });
    emitFindResults({ resultIndex: 3, resultCount: 7 });

    pressFindKey("Enter", true);
    expect(terminalHandle.findPrevious).toHaveBeenLastCalledWith({ query: "needle" });

    changeInput("");
    expect(terminalHandle.clearFindDecorations).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("0 / 0");

    changeInput("needle");
    click("pane-find-close");
    expect(terminalHandle.clearFindDecorations).toHaveBeenCalledTimes(2);
    expect(container?.querySelector('[data-testid="pane-find-input"]')).toBeNull();
  });

  it("keeps terminal key input flowing while the find bar is open", async () => {
    renderTerminalPane();

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    await act(async () => {
      await terminalProps.current?.onTerminalKey?.({
        key: "c",
        ctrl: true,
        shift: false,
        alt: false,
        meta: false,
      });
    });

    expect(client.sendTerminalInput).toHaveBeenCalledWith("terminal-a", {
      type: "input",
      data: "\u0003",
    });
  });
});
