/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Text, View } from "react-native";
import {
  FindBar,
  usePaneFind,
  type PaneFindCommandResult,
  type PaneFindMatchState,
} from "@/panels/pane-find";
import {
  PaneFocusProvider,
  PaneProvider,
  createPaneFocusContextValue,
  usePaneContext,
  type PaneContextValue,
} from "@/panels/pane-context";
import {
  clearActivePaneFindPaneId,
  createPaneFindPaneId,
  handlePaneFindKeyboardAction,
  setActivePaneFindPaneId,
} from "@/panels/pane-find-registry";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

const { theme } = vi.hoisted(() => ({
  theme: {
    colors: {
      border: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#111",
      surface1: "#222",
    },
  },
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

vi.mock("@/panels/register-panels", () => ({
  ensurePanelsRegistered: vi.fn(),
}));

vi.mock("@/panels/panel-registry", () => ({
  getPanelRegistration: () => ({
    kind: "agent",
    component: FakeFindPanel,
    useDescriptor: vi.fn(),
  }),
}));

interface FakeSearchController {
  query: ReturnType<typeof vi.fn<(query: string) => PaneFindCommandResult>>;
  next: ReturnType<typeof vi.fn<() => PaneFindCommandResult>>;
  prev: ReturnType<typeof vi.fn<() => PaneFindCommandResult>>;
  close: ReturnType<typeof vi.fn<() => void>>;
}

const controllers = new Map<string, FakeSearchController>();

function createController(): FakeSearchController {
  return {
    query: vi.fn((query: string) =>
      query === "missing" ? { status: "no-match" } : { status: "matched", current: 1, total: 3 },
    ),
    next: vi.fn(() => ({ status: "matched", current: 2, total: 3 })),
    prev: vi.fn(() => ({ status: "matched", current: 3, total: 3 })),
    close: vi.fn(),
  };
}

function FakeFindPanel() {
  const paneContext = usePaneContext();
  const controller = controllers.get(paneContext.paneInstanceId ?? "");
  const paneFind = usePaneFind({
    onQuery: controller?.query ?? createController().query,
    onNext: controller?.next ?? createController().next,
    onPrev: controller?.prev ?? createController().prev,
    onClose: controller?.close ?? createController().close,
  });

  return (
    <View>
      {paneFind.isOpen ? <FindBar {...paneFind.findBarProps} /> : null}
      <Text>Pane body</Text>
    </View>
  );
}

function AsyncFindPanel({
  matchState,
  onQuery,
}: {
  matchState: PaneFindMatchState;
  onQuery: (query: string) => PaneFindCommandResult;
}) {
  const paneFind = usePaneFind({
    matchState,
    onQuery,
    onNext: () => undefined,
    onPrev: () => undefined,
    onClose: vi.fn(),
  });

  return (
    <View>
      {paneFind.isOpen ? <FindBar {...paneFind.findBarProps} /> : null}
      <Text>Pane body</Text>
    </View>
  );
}

const tab: WorkspaceTabDescriptor = {
  key: "agent_agent-a",
  tabId: "agent_agent-a",
  kind: "agent",
  target: { kind: "agent", agentId: "agent-a" },
};
const leftPaneInstanceId = createPaneFindPaneId({
  serverId: "server-a",
  workspaceId: "workspace-a",
  paneId: "left",
});
const harnessPaneContext: PaneContextValue = {
  serverId: "server-a",
  workspaceId: "workspace-a",
  paneInstanceId: leftPaneInstanceId,
  tabId: "agent_agent-a",
  target: tab.target,
  openTab: () => {},
  closeCurrentTab: () => {},
  retargetCurrentTab: () => {},
  openFileInWorkspace: () => {},
};
const harnessPaneFocus = createPaneFocusContextValue({
  isPaneFocused: true,
  isWorkspaceFocused: true,
  onFocusPane: () => {},
});

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  clearActivePaneFindPaneId("server-a:workspace-a:left");
  clearActivePaneFindPaneId("server-a:workspace-a:right");
  controllers.clear();
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
});

function renderFindHarness(controller: FakeSearchController = createController()) {
  controllers.set(leftPaneInstanceId, controller);

  act(() => {
    root?.render(
      <PaneProvider value={harnessPaneContext}>
        <PaneFocusProvider value={harnessPaneFocus}>
          <FakeFindPanel />
        </PaneFocusProvider>
      </PaneProvider>,
    );
  });

  setActivePaneFindPaneId(leftPaneInstanceId);
}

function inputElement(): HTMLInputElement {
  const input = container?.querySelector('[data-testid="pane-find-input"]');
  expect(input).toBeInstanceOf(HTMLInputElement);
  return input as HTMLInputElement;
}

function button(testId: string): HTMLElement {
  const element = container?.querySelector(`[data-testid="${testId}"]`);
  expect(element).toBeInstanceOf(HTMLElement);
  return element as HTMLElement;
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

describe("FindBar", () => {
  it("opens through pane registration and focuses the query input", () => {
    renderFindHarness();

    expect(container?.querySelector('[data-testid="pane-find-input"]')).toBeNull();

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });

    expect(inputElement()).toBe(document.activeElement);
    expect(container?.textContent).toContain("Find");
  });

  it("dispatches query changes and renders match, empty, and no-match states", () => {
    const controller = createController();
    renderFindHarness(controller);

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });

    expect(container?.textContent).toContain("0 / 0");

    changeInput("abc");
    expect(controller.query).toHaveBeenLastCalledWith("abc");
    expect(container?.textContent).toContain("1 / 3");

    changeInput("missing");
    expect(container?.textContent).toContain("No matches");

    changeInput("");
    expect(container?.textContent).toContain("0 / 0");
  });

  it("handles next, previous, Escape, Enter, Shift+Enter, and close", () => {
    const controller = createController();
    renderFindHarness(controller);

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    changeInput("abc");

    pressKey("Enter");
    expect(controller.next).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("2 / 3");

    pressKey("Enter", true);
    expect(controller.prev).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("3 / 3");

    act(() => {
      button("pane-find-next").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(controller.next).toHaveBeenCalledTimes(2);

    act(() => {
      button("pane-find-prev").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(controller.prev).toHaveBeenCalledTimes(2);

    pressKey("Escape");
    expect(controller.close).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('[data-testid="pane-find-input"]')).toBeNull();

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    act(() => {
      button("pane-find-close").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(controller.close).toHaveBeenCalledTimes(2);
  });

  it("cleans up the active find adapter on pane deactivation and unmount", () => {
    const controller = createController();
    renderFindHarness(controller);

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    changeInput("abc");

    act(() => {
      clearActivePaneFindPaneId(leftPaneInstanceId);
    });
    expect(controller.close).toHaveBeenCalledTimes(1);
    expect(container?.querySelector('[data-testid="pane-find-input"]')).toBeNull();

    act(() => {
      setActivePaneFindPaneId(leftPaneInstanceId);
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    changeInput("abc");
    act(() => {
      root?.unmount();
    });
    expect(controller.close).toHaveBeenCalledTimes(2);
    root = null;
  });

  it("shows pending match metadata until an adapter-owned async result arrives", () => {
    const onQuery = vi.fn(() => undefined);
    let setExternalMatchState: ((matchState: PaneFindMatchState) => void) | null = null;

    function Harness() {
      const [externalMatchState, setMatchState] = React.useState<PaneFindMatchState>({
        status: "empty",
      });
      setExternalMatchState = setMatchState;
      return (
        <PaneProvider value={harnessPaneContext}>
          <PaneFocusProvider value={harnessPaneFocus}>
            <AsyncFindPanel matchState={externalMatchState} onQuery={onQuery} />
          </PaneFocusProvider>
        </PaneProvider>
      );
    }

    act(() => {
      root?.render(<Harness />);
    });
    setActivePaneFindPaneId(leftPaneInstanceId);

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });
    changeInput("needle");

    expect(onQuery).toHaveBeenCalledWith("needle");
    expect(container?.textContent).toContain("Searching...");

    act(() => {
      setExternalMatchState?.({ status: "matched", current: 2, total: 4 });
    });

    expect(container?.textContent).toContain("2 / 4");
  });

  it("routes open find through the focused workspace pane without replacing pane focus", () => {
    const left = createController();
    const right = createController();
    const leftContent = buildWorkspacePaneContentModel({
      tab,
      paneId: "left",
      normalizedServerId: "server-a",
      normalizedWorkspaceId: "workspace-a",
      onOpenTab: vi.fn(),
      onCloseCurrentTab: vi.fn(),
      onRetargetCurrentTab: vi.fn(),
      onOpenWorkspaceFile: vi.fn(),
    });

    const rightContent = buildWorkspacePaneContentModel({
      tab,
      paneId: "right",
      normalizedServerId: "server-a",
      normalizedWorkspaceId: "workspace-a",
      onOpenTab: vi.fn(),
      onCloseCurrentTab: vi.fn(),
      onRetargetCurrentTab: vi.fn(),
      onOpenWorkspaceFile: vi.fn(),
    });
    const focusLeft = vi.fn();
    const focusRight = vi.fn();
    controllers.set("server-a:workspace-a:left", left);
    controllers.set("server-a:workspace-a:right", right);

    act(() => {
      root?.render(
        <View>
          <WorkspacePaneContent
            content={leftContent}
            isPaneFocused={false}
            isWorkspaceFocused
            onFocusPane={focusLeft}
          />
          <WorkspacePaneContent
            content={rightContent}
            isPaneFocused
            isWorkspaceFocused
            onFocusPane={focusRight}
          />
        </View>,
      );
    });

    act(() => {
      handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" });
    });

    changeInput("abc");
    expect(left.query).not.toHaveBeenCalled();
    expect(right.query).toHaveBeenCalledWith("abc");
    expect(focusLeft).not.toHaveBeenCalled();
    expect(focusRight).not.toHaveBeenCalled();
  });
});
