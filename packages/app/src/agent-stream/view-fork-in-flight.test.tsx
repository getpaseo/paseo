/**
 * @vitest-environment jsdom
 *
 * Pins the *call site* of the in-flight turn fork. `turn-footer.test.tsx` proves
 * the menu forwards a bare target, and `use-fork-agent.test.tsx` proves the hook
 * handles the request it is given — but neither renders `AgentStreamView`, so
 * nothing below e2e checks what `handleForkInFlightTurn` actually sends. This
 * file mounts the real view (with the render substrate stubbed) so the real
 * handler and the real `readOnly ? undefined : ...` gate stay in the path.
 */
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
  // react-native-reanimated reads reduced-motion at module scope; jsdom has no
  // matchMedia. Same shim as strategy-web.test.tsx.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({
      addEventListener: () => {},
      addListener: () => {},
      dispatchEvent: () => false,
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: () => {},
      removeListener: () => {},
    }),
  });
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

// The shared unistyles test stub (test-stubs/react-native-unistyles.ts) lacks
// the `opacity`, `shadow`, `borderWidth` and `palette` scales this subtree reads
// at module scope. Same local override `turn-footer.test.tsx` uses, widened for
// the view's own stylesheet.
vi.mock("react-native-unistyles", () => {
  const theme = {
    colorScheme: "light",
    colors: {
      foreground: "#111111",
      foregroundMuted: "#666666",
      border: "#e4e4e7",
      borderAccent: "#d4d4d8",
      surface0: "#ffffff",
      surface1: "#fafafa",
      surface2: "#f4f4f5",
      palette: { amber: { 500: "#f59e0b", 700: "#b45309" } },
    },
    spacing: [0, 4, 8, 12, 16, 20, 24, 28, 32, 36, 40, 44, 48],
    fontSize: { xs: 12, sm: 14, base: 16 },
    fontWeight: { normal: "400", medium: "500" },
    borderRadius: { base: 4, md: 6 },
    borderWidth: [0, 1, 2],
    opacity: { 50: 0.5 },
    shadow: { sm: {} },
  };
  return {
    StyleSheet: {
      create: (styles: unknown) => (typeof styles === "function" ? styles(theme) : styles),
    },
    withUnistyles: (Component: unknown) => Component,
    useUnistyles: () => ({ theme, rt: {}, breakpoint: undefined }),
    UnistylesRuntime: { setTheme: () => undefined, themeName: "light" },
  };
});

const forkAgentMock = vi.hoisted(() => vi.fn(async (_request: Record<string, unknown>) => {}));
vi.mock("@/hooks/use-fork-agent", () => ({
  useForkAgent: () => forkAgentMock,
}));

/**
 * The web strategy virtualizes through a scroll container, which jsdom gives
 * zero height — `strategy-web.test.tsx` has to patch `offsetHeight`/`scrollTo`
 * to get rows to paint. None of that is under test here, so swap the resolver
 * for a strategy whose `render` only emits the live-auxiliary slot (where the
 * turn footer lives). Everything between the view's props and `forkAgent` stays
 * real. `model.ts` resolves the same module, so it gets the same stub.
 */
vi.mock("@/agent-stream/strategy-resolver", async () => {
  const react = await import("react");
  const strategy =
    await vi.importActual<typeof import("@/agent-stream/strategy")>("@/agent-stream/strategy");
  const stub = strategy.createStreamStrategy({
    render: (input) =>
      react.createElement(
        "div",
        { "data-testid": "stream-render" },
        input.renderers.renderLiveAuxiliary(),
      ),
    orderTailReverse: false,
    orderHeadReverse: false,
    assistantTurnTraversalStep: -1,
    edgeSlot: "footer",
    historyLiveBoundaryEdge: "last",
    liveHeadHistoryBoundaryEdge: "last",
    frameChildOrder: "content-then-footer",
    flatListInverted: false,
    overlayScrollbarInverted: false,
    bottomAnchorTransportBehavior: {
      verificationDelayFrames: 1,
      verificationRetryMode: "rescroll",
    },
    disableParentScrollOnInlineDetailsExpansion: false,
    anchorBottomOnContentSizeChange: false,
    animateManualScrollToBottom: false,
    useVirtualizedList: false,
    isNearBottom: () => true,
    getBottomOffset: () => 0,
  });
  return { resolveStreamRenderStrategy: () => stub };
});

vi.mock("@/components/synced-loader", () => ({
  SyncedLoader: () => <div data-testid="synced-loader" />,
}));

vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => true,
}));

// Leaf renderers the view imports but that never mount in this harness (the
// stream is a single in-flight user turn). Stubbing them keeps the module graph
// small without touching the fork path.
vi.mock("@/components/message", () => ({
  AssistantMessage: () => null,
  SpeakMessage: () => null,
  UserMessage: () => null,
  ActivityLog: () => null,
  ToolCall: () => null,
  TodoListCard: () => null,
  CompactionMarker: () => null,
  MessageOuterSpacingProvider: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
  AssistantTurnFooter: ({ onFork }: { onFork?: unknown }) => (
    <div data-testid="assistant-turn-footer" data-can-fork={onFork ? "yes" : "no"} />
  ),
  LiveElapsed: ({ testID }: { testID?: string }) => <div data-testid={testID} />,
  STREAM_METADATA_FONT_SIZE: 12,
}));

vi.mock("@/components/plan-card", () => ({ PlanCard: () => null }));

vi.mock("@/components/tool-call-details", () => ({ ToolCallDetailsContent: () => null }));

vi.mock("@/components/question-form-card", () => ({ QuestionFormCard: () => null }));

vi.mock("@/tool-calls/detail-level/overview/view", () => ({
  OverviewToolCallGroupView: () => null,
}));

vi.mock("@/components/tool-call-sheet", () => ({
  ToolCallSheetProvider: ({ children }: { children: React.ReactNode }) =>
    children as React.ReactElement,
}));

// The dropdown is a portal/overlay on the real path; flattening it puts the menu
// items in the DOM so a click can reach `handleForkInFlightTurn`.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuItem: ({
    children,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({ children, testID }: { children: unknown; testID?: string }) => (
    <button type="button" data-testid={testID}>
      {typeof children === "function"
        ? (children as (state: unknown) => React.ReactNode)({
            hovered: false,
            pressed: false,
            open: false,
          })
        : (children as React.ReactNode)}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
  TooltipContent: () => null,
}));

vi.mock("@/hooks/use-file-explorer-actions", () => ({
  useFileExplorerActions: () => ({ requestDirectoryListing: vi.fn() }),
}));

vi.mock("@/hooks/use-load-older-agent-history", () => ({
  useLoadOlderAgentHistory: () => ({
    isLoadingOlder: false,
    hasOlder: false,
    progressKey: null,
    loadOlder: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-settings", () => ({
  useSettings: (selector: (settings: unknown) => unknown) =>
    selector({ autoExpandReasoning: false, toolCallDetailLevel: "detailed" }),
}));

vi.mock("@/stores/panel-store", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({ openFileExplorerForCheckout: vi.fn(), setExplorerTabForCheckout: vi.fn() }),
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) => selector({ sessions: {} }),
}));

import { AgentStreamView, type AgentStreamViewProps } from "@/agent-stream/view";
import type { StreamItem } from "@/types/stream";

// Vitest compiles some app components (`assistant-fork-menu` among them) with
// the classic JSX runtime, so their `React.createElement` calls need a global
// `React`. Same shape as the `globalThis` shims in vitest.setup.ts.
(globalThis as unknown as { React: unknown }).React = React;

const AGENT_ID = "agent-1";
const WORKSPACE_ID = "workspace-7";

const runningAgent = {
  id: AGENT_ID,
  serverId: "server-1",
  workspaceId: WORKSPACE_ID,
  status: "running",
  provider: "claude",
  cwd: "/repo",
} as unknown as AgentStreamViewProps["context"];

const userTurn: StreamItem = {
  kind: "user_message",
  id: "user-1",
  text: "do the thing",
  timestamp: new Date("2026-04-20T00:00:00.000Z"),
} as unknown as StreamItem;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderView(overrides: Partial<AgentStreamViewProps> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <AgentStreamView
        agentId={AGENT_ID}
        serverId="server-1"
        context={runningAgent}
        streamItems={[userTurn]}
        pendingPermissions={new Map()}
        {...overrides}
      />,
    );
  });
  if (!container) {
    throw new Error("container missing");
  }
  return container;
}

const query = (testID: string) =>
  container?.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

beforeEach(() => {
  forkAgentMock.mockClear();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("AgentStreamView in-flight turn fork", () => {
  it("sends no boundary field at all when forking the streaming turn", async () => {
    await renderView();

    // Guard against a vacuous pass: the running footer really did mount.
    expect(query("turn-working-indicator")).not.toBeNull();
    const trigger = query("assistant-fork-menu-trigger");
    expect(trigger).not.toBeNull();

    await act(async () => {
      fireEvent.click(query("assistant-fork-menu-new-tab") as HTMLElement);
    });

    expect(forkAgentMock).toHaveBeenCalledTimes(1);
    const request = forkAgentMock.mock.calls[0][0];
    expect(request.agentId).toBe(AGENT_ID);
    expect(request.agent).toBe(runningAgent);
    expect(request.workspaceId).toBe(WORKSPACE_ID);
    expect(request.target).toBe("tab");
    // Absence, not `undefined`. `selectForkContextRows` projects the whole
    // timeline only when the field is missing, and the wire payload must not
    // carry the key at all — a present-but-undefined `boundary` is a different
    // (and wrong) contract.
    expect("boundary" in request).toBe(false);
    expect(Object.keys(request).toSorted()).toEqual(["agent", "agentId", "target", "workspaceId"]);
  });

  it("forks to a new workspace with the same boundary-less request", async () => {
    await renderView();

    await act(async () => {
      fireEvent.click(query("assistant-fork-menu-new-workspace") as HTMLElement);
    });

    expect(forkAgentMock).toHaveBeenCalledTimes(1);
    const request = forkAgentMock.mock.calls[0][0];
    expect(request.target).toBe("workspace");
    expect("boundary" in request).toBe(false);
  });

  it("withholds the in-flight fork trigger on read-only panes", async () => {
    await renderView({ readOnly: true });

    // Positive control: the running footer still renders, so the missing
    // trigger below is the read-only gate and not an empty tree.
    expect(query("turn-working-indicator")).not.toBeNull();
    expect(query("synced-loader")).not.toBeNull();
    expect(query("assistant-fork-menu-trigger")).toBeNull();
    expect(query("assistant-fork-menu-new-tab")).toBeNull();
  });

  it("offers the in-flight fork trigger on writable panes", async () => {
    await renderView({ readOnly: false });

    expect(query("turn-working-indicator")).not.toBeNull();
    expect(query("assistant-fork-menu-trigger")).not.toBeNull();
  });
});
