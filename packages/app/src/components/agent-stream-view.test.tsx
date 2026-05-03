/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { StreamItem } from "@/types/stream";
import {
  PaneFocusProvider,
  PaneProvider,
  type PaneContextValue,
  type PaneFocusContextValue,
} from "@/panels/pane-context";
import {
  clearActivePaneFindPaneId,
  handlePaneFindKeyboardAction,
  setActivePaneFindPaneId,
} from "@/panels/pane-find-registry";
import { AgentStreamView } from "./agent-stream-view";

const assistantMessageCalls = vi.hoisted(
  () =>
    [] as Array<{
      message: string;
      spacing: string | undefined;
      findHighlights: Array<{ id: string; start: number; end: number; isCurrent: boolean }>;
    }>,
);
const userMessageCalls = vi.hoisted(
  () =>
    [] as Array<{
      message: string;
      findHighlights: Array<{ id: string; start: number; end: number; isCurrent: boolean }>;
    }>,
);
const turnCopyButtonCalls = vi.hoisted(() => [] as Array<{ getContent: () => string }>);

const mockSessionState = vi.hoisted(() => ({
  sessions: {
    server: {
      client: null,
      agentStreamHead: new Map<string, StreamItem[]>(),
      workspaces: new Map(),
      agentTimelineCursor: new Map(),
      agentTimelineHasOlder: new Map(),
      agentTimelineOlderFetchInFlight: new Map(),
    },
  },
  setAgentTimelineOlderFetchInFlight: () => {},
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (
      factory: (theme: {
        borderRadius: Record<string, number>;
        borderWidth: Record<number, number>;
        colors: Record<string, string>;
        fontSize: Record<string, number>;
        fontWeight: Record<string, string>;
        shadow: Record<string, object>;
        spacing: Record<number, number>;
      }) => unknown,
    ) =>
      factory({
        borderRadius: {
          full: 9999,
          md: 6,
        },
        borderWidth: {
          1: 1,
        },
        colors: {
          foreground: "#fff",
          foregroundMuted: "#aaa",
          surface0: "#000",
          surface1: "#111",
          surface2: "#222",
          border: "#333",
          borderAccent: "#444",
        },
        fontSize: {
          sm: 14,
          base: 16,
          xs: 12,
        },
        fontWeight: {
          normal: "normal",
        },
        shadow: {
          sm: {},
        },
        spacing: {
          1: 4,
          2: 8,
          3: 12,
          4: 16,
          12: 48,
        },
      }),
  },
  useUnistyles: () => ({
    rt: { breakpoint: "md" },
    theme: {
      colors: {
        foreground: "#fff",
        foregroundMuted: "#aaa",
        surface1: "#111",
        surface2: "#222",
        border: "#333",
      },
      fontSize: {
        xs: 12,
      },
    },
  }),
  withUnistyles: (Component: unknown) => Component,
}));

vi.mock("react-native-reanimated", async () => {
  const ReactModule = await import("react");
  return {
    default: {
      View: ({ children, ...props }: { children?: React.ReactNode }) =>
        ReactModule.createElement("div", props, children),
    },
    Easing: { linear: vi.fn() },
    FadeIn: { duration: vi.fn(() => undefined) },
    FadeOut: { duration: vi.fn(() => undefined) },
    cancelAnimation: vi.fn(),
    useAnimatedStyle: (factory: () => unknown) => factory(),
    useSharedValue: (value: unknown) => ({ value }),
    withRepeat: (value: unknown) => value,
    withTiming: (value: unknown) => value,
  };
});

vi.mock("lucide-react-native", async () => {
  const ReactModule = await import("react");
  const Icon = () => ReactModule.createElement("span");
  return {
    Check: Icon,
    ChevronDown: Icon,
    ChevronUp: Icon,
    X: Icon,
  };
});

vi.mock("./message", async () => {
  const ReactModule = await import("react");
  return {
    ActivityLog: () => null,
    AssistantMessage: (props: {
      message: string;
      spacing?: string;
      findHighlights?: Array<{ id: string; start: number; end: number; isCurrent: boolean }>;
    }) => {
      assistantMessageCalls.push({
        message: props.message,
        spacing: props.spacing,
        findHighlights: props.findHighlights ?? [],
      });
      return ReactModule.createElement("div", {
        "data-message": props.message,
        "data-spacing": props.spacing ?? "",
      });
    },
    CompactionMarker: () => null,
    MessageOuterSpacingProvider: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    SpeakMessage: () => null,
    TodoListCard: () => null,
    ToolCall: () => null,
    TurnCopyButton: (props: { getContent: () => string }) => {
      turnCopyButtonCalls.push(props);
      return ReactModule.createElement("button", {
        "data-testid": "turn-copy-button",
        type: "button",
      });
    },
    UserMessage: (props: {
      message: string;
      findHighlights?: Array<{ id: string; start: number; end: number; isCurrent: boolean }>;
    }) => {
      userMessageCalls.push({
        message: props.message,
        findHighlights: props.findHighlights ?? [],
      });
      return ReactModule.createElement("div", { "data-message": props.message });
    },
  };
});

vi.mock("./tool-call-sheet", async () => {
  const ReactModule = await import("react");
  return {
    ToolCallSheetProvider: ({ children }: { children: React.ReactNode }) =>
      ReactModule.createElement(ReactModule.Fragment, null, children),
    useToolCallSheet: () => ({ open: vi.fn() }),
  };
});

vi.mock("./tool-call-details", () => ({ ToolCallDetailsContent: () => null }));
vi.mock("./use-web-scrollbar", () => ({ useWebElementScrollbar: () => null }));
vi.mock("./question-form-card", () => ({ QuestionFormCard: () => null }));
vi.mock("./plan-card", () => ({ PlanCard: () => null }));
vi.mock("@/hooks/use-file-explorer-actions", () => ({
  useFileExplorerActions: () => ({ requestDirectoryListing: vi.fn() }),
}));
vi.mock("@/stores/panel-store", () => ({
  usePanelStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      openFileExplorerForCheckout: vi.fn(),
      setExplorerTabForCheckout: vi.fn(),
    }),
}));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: Object.assign(
    (selector: (state: typeof mockSessionState) => unknown) => selector(mockSessionState),
    {
      getState: () => mockSessionState,
    },
  ),
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ navigate: vi.fn() }) }));

function assistantBlock(params: {
  id: string;
  text: string;
  blockIndex: number;
}): Extract<StreamItem, { kind: "assistant_message" }> {
  return {
    kind: "assistant_message",
    id: params.id,
    blockGroupId: "group-1",
    blockIndex: params.blockIndex,
    text: params.text,
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
  };
}

function runningToolCall(id: string): Extract<StreamItem, { kind: "tool_call" }> {
  return {
    kind: "tool_call",
    id,
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
    payload: {
      source: "orchestrator",
      data: {
        toolCallId: id,
        toolName: "bash",
        arguments: "npm test",
        result: null,
        status: "executing",
      },
    },
  };
}

function userMessage(id: string, text: string): Extract<StreamItem, { kind: "user_message" }> {
  return {
    kind: "user_message",
    id,
    text,
    timestamp: new Date("2026-05-01T00:00:00.000Z"),
  };
}

const paneInstanceId = "server:workspace:agent";
const paneContext: PaneContextValue = {
  serverId: "server",
  workspaceId: "workspace",
  paneInstanceId,
  tabId: "tab",
  target: { kind: "agent", agentId: "agent-1" },
  openTab: vi.fn(),
  closeCurrentTab: vi.fn(),
  retargetCurrentTab: vi.fn(),
  openFileInWorkspace: vi.fn(),
};
const paneFocus: PaneFocusContextValue = {
  isWorkspaceFocused: true,
  isPaneFocused: true,
  isInteractive: true,
  focusPane: vi.fn(),
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let originalScrollTo: HTMLElement["scrollTo"] | undefined;
let originalScrollIntoView: HTMLElement["scrollIntoView"] | undefined;

function renderAgentStreamView(props: React.ComponentProps<typeof AgentStreamView>) {
  act(() => {
    root?.render(
      <PaneProvider value={paneContext}>
        <PaneFocusProvider value={paneFocus}>
          <AgentStreamView {...props} />
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

function click(testId: string): void {
  const element = container?.querySelector(`[data-testid="${testId}"]`);
  expect(element).toBeInstanceOf(HTMLElement);
  act(() => {
    element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function openFind(): void {
  act(() => {
    expect(handlePaneFindKeyboardAction({ id: "workspace.find.open", scope: "workspace" })).toBe(
      true,
    );
  });
}

function findLastCall<T>(calls: T[], predicate: (call: T) => boolean): T | undefined {
  return calls.toReversed().find(predicate);
}

describe("AgentStreamView", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
      value: true,
      configurable: true,
    });
    originalScrollTo = HTMLElement.prototype.scrollTo;
    HTMLElement.prototype.scrollTo = vi.fn();
    originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = vi.fn();
    assistantMessageCalls.length = 0;
    userMessageCalls.length = 0;
    turnCopyButtonCalls.length = 0;
    mockSessionState.sessions.server.agentStreamHead = new Map();
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
    clearActivePaneFindPaneId(paneInstanceId);
    if (originalScrollTo) {
      HTMLElement.prototype.scrollTo = originalScrollTo;
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollTo");
    }
    if (originalScrollIntoView) {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    vi.restoreAllMocks();
  });

  it("compacts assistant block spacing across the history/live-head boundary", () => {
    const tailBlock = assistantBlock({
      id: "group-1:block:0",
      text: "First paragraph",
      blockIndex: 0,
    });
    const headBlock = assistantBlock({
      id: "group-1:head",
      text: "Second paragraph",
      blockIndex: 1,
    });
    mockSessionState.sessions.server.agentStreamHead.set("agent-1", [headBlock]);
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "idle",
      cwd: "/tmp/project",
    } as never;
    const streamItems = [tailBlock];
    const pendingPermissions = new Map();

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems,
      pendingPermissions,
    });

    const tailCalls = assistantMessageCalls.filter((call) => call.message === "First paragraph");
    const headCalls = assistantMessageCalls.filter((call) => call.message === "Second paragraph");

    expect(tailCalls.length).toBeGreaterThan(0);
    expect(headCalls.length).toBeGreaterThan(0);
    expect(tailCalls.map((call) => call.spacing)).toEqual(
      Array.from({ length: tailCalls.length }, () => "compactBottom"),
    );
    expect(headCalls.map((call) => call.spacing)).toEqual(
      Array.from({ length: headCalls.length }, () => "compactTop"),
    );
  });

  it("renders running dots in the assistant turn footer when live text is streaming", () => {
    const headBlock = assistantBlock({
      id: "group-1:head",
      text: "Streaming paragraph",
      blockIndex: 0,
    });
    mockSessionState.sessions.server.agentStreamHead.set("agent-1", [headBlock]);
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "running",
      cwd: "/tmp/project",
    } as never;

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [],
      pendingPermissions: new Map(),
    });

    expect(container?.querySelector('[data-testid="turn-working-indicator"]')).not.toBeNull();
    expect(
      container?.querySelector('[data-testid="stream-working-indicator-auxiliary"]'),
    ).toBeNull();
    expect(container?.querySelector('[data-testid="turn-copy-button"]')).toBeNull();
  });

  it("only renders running dots on the live assistant row", () => {
    const tailBlock = assistantBlock({
      id: "group-1:block:0",
      text: "History paragraph",
      blockIndex: 0,
    });
    const headBlock = assistantBlock({
      id: "group-2:head",
      text: "Streaming paragraph",
      blockIndex: 0,
    });
    mockSessionState.sessions.server.agentStreamHead.set("agent-1", [headBlock]);
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "running",
      cwd: "/tmp/project",
    } as never;

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [tailBlock],
      pendingPermissions: new Map(),
    });

    expect(container?.querySelectorAll('[data-testid="turn-working-indicator"]')).toHaveLength(1);
    expect(
      container?.querySelector('[data-testid="stream-working-indicator-auxiliary"]'),
    ).toBeNull();
  });

  it("keeps the auxiliary running dots when there is no live assistant row", () => {
    mockSessionState.sessions.server.agentStreamHead.set("agent-1", [runningToolCall("tool-1")]);
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "running",
      cwd: "/tmp/project",
    } as never;

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [],
      pendingPermissions: new Map(),
    });

    expect(container?.querySelector('[data-testid="turn-working-indicator"]')).toBeNull();
    expect(
      container?.querySelector('[data-testid="stream-working-indicator-auxiliary"]'),
    ).not.toBeNull();
  });

  it("replaces the running footer with the copy button when the assistant turn idles", () => {
    const headBlock = assistantBlock({
      id: "group-1:head",
      text: "Complete paragraph",
      blockIndex: 0,
    });
    mockSessionState.sessions.server.agentStreamHead.set("agent-1", [headBlock]);
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "idle",
      cwd: "/tmp/project",
    } as never;

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [],
      pendingPermissions: new Map(),
    });

    expect(container?.querySelector('[data-testid="turn-working-indicator"]')).toBeNull();
    expect(container?.querySelector('[data-testid="turn-copy-button"]')).not.toBeNull();
    expect(turnCopyButtonCalls.length).toBeGreaterThan(0);
    expect(turnCopyButtonCalls.map((call) => call.getContent())).toEqual(
      Array.from({ length: turnCopyButtonCalls.length }, () => "Complete paragraph"),
    );
  });

  it("registers chat find and navigates mounted history plus live head matches", () => {
    const liveBlock = assistantBlock({
      id: "live-match",
      text: "needle in live head",
      blockIndex: 0,
    });
    mockSessionState.sessions.server.agentStreamHead.set("agent-1", [liveBlock]);
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "idle",
      cwd: "/tmp/project",
    } as never;

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [userMessage("history-match", "needle in mounted history")],
      pendingPermissions: new Map(),
    });

    openFind();
    changeInput("needle");

    expect(container?.querySelector('[data-testid="pane-find-bar"]')?.textContent).toContain(
      "1 / 2",
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenLastCalledWith({
      block: "center",
      behavior: "auto",
    });

    click("pane-find-next");

    expect(container?.querySelector('[data-testid="pane-find-bar"]')?.textContent).toContain(
      "2 / 2",
    );
    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(2);
  });

  it("updates match state after loaded history changes without scrolling until navigation", () => {
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "idle",
      cwd: "/tmp/project",
    } as never;

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [userMessage("current", "needle current history")],
      pendingPermissions: new Map(),
    });

    openFind();
    changeInput("needle");
    expect(container?.querySelector('[data-testid="pane-find-bar"]')?.textContent).toContain(
      "1 / 1",
    );
    vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
    vi.mocked(HTMLElement.prototype.scrollTo).mockClear();

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [
        userMessage("older", "needle older loaded history"),
        userMessage("current", "needle current history"),
      ],
      pendingPermissions: new Map(),
    });

    expect(container?.querySelector('[data-testid="pane-find-bar"]')?.textContent).toContain(
      "2 / 2",
    );
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    expect(HTMLElement.prototype.scrollTo).not.toHaveBeenCalled();

    click("pane-find-next");

    expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  });

  it("passes current and non-current find highlights to user and assistant text rows", () => {
    const assistant = assistantBlock({
      id: "assistant-match",
      text: "assistant needle text",
      blockIndex: 0,
    });
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "idle",
      cwd: "/tmp/project",
    } as never;

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [userMessage("user-match", "user needle text"), assistant],
      pendingPermissions: new Map(),
    });

    openFind();
    changeInput("needle");

    const userCall = findLastCall(userMessageCalls, (call) => call.message === "user needle text");
    const assistantCall = findLastCall(
      assistantMessageCalls,
      (call) => call.message === "assistant needle text",
    );

    expect(userCall?.findHighlights).toEqual([
      expect.objectContaining({
        id: "user-match:text:0:5:11",
        start: 5,
        end: 11,
        isCurrent: true,
      }),
    ]);
    expect(assistantCall?.findHighlights).toEqual([
      expect.objectContaining({
        id: "assistant-match:text:0:10:16",
        start: 10,
        end: 16,
        isCurrent: false,
      }),
    ]);

    click("pane-find-next");

    const latestAssistantCall = findLastCall(
      assistantMessageCalls,
      (call) => call.message === "assistant needle text",
    );
    expect(latestAssistantCall?.findHighlights).toEqual([
      expect.objectContaining({
        id: "assistant-match:text:0:10:16",
        isCurrent: true,
      }),
    ]);
  });

  it("clears chat find highlights on empty query and close", () => {
    const agent = {
      id: "agent-1",
      serverId: "server",
      status: "idle",
      cwd: "/tmp/project",
    } as never;

    renderAgentStreamView({
      agentId: "agent-1",
      serverId: "server",
      agent,
      streamItems: [userMessage("user-match", "user needle text")],
      pendingPermissions: new Map(),
    });

    openFind();
    changeInput("needle");
    expect(userMessageCalls.at(-1)?.findHighlights).toHaveLength(1);

    changeInput("");
    expect(userMessageCalls.at(-1)?.findHighlights).toEqual([]);

    changeInput("needle");
    expect(userMessageCalls.at(-1)?.findHighlights).toHaveLength(1);
    click("pane-find-close");
    expect(userMessageCalls.at(-1)?.findHighlights).toEqual([]);
  });
});
