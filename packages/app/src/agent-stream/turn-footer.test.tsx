/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The shared unistyles test stub has no `opacity` scale, which
// `assistant-fork-menu` reads at module scope.
vi.mock("react-native-unistyles", () => {
  const theme = {
    colorScheme: "light",
    colors: { foreground: "#111111", foregroundMuted: "#666666", palette: { amber: {} } },
    spacing: [0, 4, 8, 12, 16, 20, 24],
    fontSize: { xs: 12 },
    opacity: { 50: 0.5 },
  };
  return {
    StyleSheet: {
      create: (styles: unknown) => (typeof styles === "function" ? styles(theme) : styles),
    },
    withUnistyles: (Component: unknown) => Component,
  };
});

vi.mock("@/components/retained-panel", () => ({
  useRetainedPanelActive: () => true,
}));

vi.mock("@/components/synced-loader", () => ({
  SyncedLoader: () => <div data-testid="synced-loader" />,
}));

// `AssistantTurnFooter` is the completed-turn affordance cluster (copy button +
// duration label). Stubbing it lets the test assert *which* footer composition
// rendered without pulling in the whole message module.
vi.mock("@/components/message", () => ({
  AssistantTurnFooter: ({ onFork }: { onFork?: unknown }) => (
    <div data-testid="assistant-turn-footer" data-can-fork={onFork ? "yes" : "no"} />
  ),
  LiveElapsed: ({ testID }: { testID?: string }) => <div data-testid={testID} />,
  STREAM_METADATA_FONT_SIZE: 12,
}));

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
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children:
      | React.ReactNode
      | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
      {typeof children === "function"
        ? children({ hovered: false, pressed: false, open: false })
        : children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children as React.ReactElement,
  TooltipContent: () => null,
}));

import { TurnFooter, type InFlightTurnForkHandler } from "@/agent-stream/turn-footer";
import type { StreamStrategy } from "@/agent-stream/strategy";

// Vitest compiles some app components (`assistant-fork-menu` among them) with
// the classic JSX runtime, so their `React.createElement` calls need a global
// `React`. Same shape as the `globalThis` shims in vitest.setup.ts.
(globalThis as unknown as { React: unknown }).React = React;

const strategy = {
  getNeighborIndex: (index: number, direction: "above" | "below") =>
    direction === "above" ? index - 1 : index + 1,
  getLatestItemIndex: (items: unknown[]) => (items.length > 0 ? items.length - 1 : null),
} as unknown as StreamStrategy;

const assistantItem = {
  id: "assistant-1",
  kind: "assistant_message",
  timestamp: new Date(0).toISOString(),
} as never;
const completedHost = {
  itemId: "assistant-1",
  items: [assistantItem],
  startIndex: 0,
  timing: undefined,
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function render(element: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(element);
  });
  if (!container) {
    throw new Error("container missing");
  }
  return container;
}

const query = (testID: string) =>
  container?.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("TurnFooter running turn", () => {
  it("renders the fork menu beside the progress loader and elapsed timer", async () => {
    const onForkInFlightTurn: InFlightTurnForkHandler = vi.fn();
    await render(
      <TurnFooter
        isRunning
        inFlightTurnStartedAt={new Date(0)}
        host={null}
        strategy={strategy}
        supportsTimelineCursor={false}
        onForkInFlightTurn={onForkInFlightTurn}
      />,
    );

    // The loader, the elapsed timer and the fork trigger share one row.
    expect(query("turn-working-indicator")).not.toBeNull();
    expect(query("synced-loader")).not.toBeNull();
    expect(query("turn-working-elapsed")).not.toBeNull();
    const trigger = query("assistant-fork-menu-trigger");
    expect(trigger).not.toBeNull();
    const row = query("turn-working-elapsed")?.parentElement;
    expect(row?.contains(trigger as Node)).toBe(true);

    // The running footer must not grow the completed-turn copy/duration cluster.
    expect(query("assistant-turn-footer")).toBeNull();
  });

  it("forks with only a target — the handler signature admits no boundary", async () => {
    const onForkInFlightTurn = vi.fn();
    await render(
      <TurnFooter
        isRunning
        inFlightTurnStartedAt={new Date(0)}
        host={null}
        strategy={strategy}
        supportsTimelineCursor
        onForkInFlightTurn={onForkInFlightTurn}
      />,
    );

    await act(async () => {
      fireEvent.click(query("assistant-fork-menu-new-tab") as HTMLElement);
    });
    expect(onForkInFlightTurn).toHaveBeenCalledTimes(1);
    expect(onForkInFlightTurn.mock.calls[0]).toEqual(["tab"]);

    await act(async () => {
      fireEvent.click(query("assistant-fork-menu-new-workspace") as HTMLElement);
    });
    expect(onForkInFlightTurn).toHaveBeenCalledTimes(2);
    expect(onForkInFlightTurn.mock.calls[1]).toEqual(["workspace"]);
  });

  it("hides the fork menu when no in-flight fork handler is supplied (read-only panes)", async () => {
    await render(
      <TurnFooter
        isRunning
        inFlightTurnStartedAt={new Date(0)}
        host={null}
        strategy={strategy}
        supportsTimelineCursor={false}
      />,
    );

    expect(query("turn-working-indicator")).not.toBeNull();
    expect(query("assistant-fork-menu-trigger")).toBeNull();
  });

  it("still renders the loader row when the turn has no start time", async () => {
    await render(
      <TurnFooter
        isRunning
        inFlightTurnStartedAt={null}
        host={null}
        strategy={strategy}
        supportsTimelineCursor={false}
        onForkInFlightTurn={vi.fn()}
      />,
    );

    expect(query("turn-working-elapsed")).toBeNull();
    expect(query("assistant-fork-menu-trigger")).not.toBeNull();
  });
});

describe("TurnFooter completed turn", () => {
  it("keeps the completed-turn cluster and does not render the in-flight fork menu", async () => {
    await render(
      <TurnFooter
        isRunning={false}
        inFlightTurnStartedAt={null}
        host={completedHost}
        strategy={strategy}
        supportsTimelineCursor={false}
        onForkAssistantTurn={vi.fn()}
        onForkInFlightTurn={vi.fn()}
      />,
    );

    expect(query("assistant-turn-footer")).not.toBeNull();
    expect(query("turn-working-indicator")).toBeNull();
    // The in-flight (boundary-less) menu belongs to the running footer only.
    expect(query("assistant-fork-menu-trigger")).toBeNull();
  });
});
