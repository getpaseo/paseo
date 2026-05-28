/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentsTrack } from "./track";
import type { SubagentRow } from "./select";

const { theme } = vi.hoisted(() => ({
  theme: {
    colorScheme: "dark",
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, md: 6, lg: 8, "2xl": 16, full: 999 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500" },
    iconSize: { sm: 14, md: 18 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
      accent: "#0a84ff",
      palette: {
        amber: { 500: "#ffbf00", 700: "#aa8000" },
        blue: { 500: "#0a84ff" },
        red: { 500: "#ff453a" },
        green: { 500: "#30d158" },
      },
    },
  },
}));

vi.hoisted(() => {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = false;
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "lg" } }),
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("@/panels/register-panels", () => ({
  ensurePanelsRegistered: () => {},
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}));

vi.mock("react-native-reanimated", () => ({
  default: {
    View: "div",
  },
  runOnJS: (fn: (...args: unknown[]) => unknown) => fn,
  useSharedValue: (value: unknown) => ({ value }),
  useAnimatedStyle: (factory: () => unknown) => factory(),
  withTiming: (value: unknown) => value,
  withRepeat: (value: unknown) => value,
  cancelAnimation: () => {},
  Easing: {
    inOut: () => () => 0,
    linear: () => 0,
    ease: () => 0,
    bezier: () => () => 0,
  },
  ReduceMotion: { System: "system", Never: "never", Always: "always" },
}));

vi.mock("@/components/provider-icons", () => ({
  getProviderIcon: (provider: unknown) =>
    function ProviderIconStub(props: { size: number; color: string }) {
      return React.createElement("span", {
        "data-testid": "subagents-provider-icon",
        "data-provider": String(provider ?? "none"),
        "data-size": String(props.size),
      });
    },
}));

vi.mock("@/components/synced-loader", () => ({
  SyncedLoader: (props: { size: number; color: string }) =>
    React.createElement("span", {
      "data-testid": "subagents-synced-loader",
      "data-size": String(props.size),
    }),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) =>
    function IconStub(props: Record<string, unknown>) {
      return React.createElement("span", { ...props, "data-icon": name });
    };
  return {
    Archive: createIcon("Archive"),
    Check: createIcon("Check"),
    ChevronDown: createIcon("ChevronDown"),
    ChevronRight: createIcon("ChevronRight"),
  };
});

function row(overrides: Partial<SubagentRow> & Pick<SubagentRow, "id">): SubagentRow {
  return {
    id: overrides.id,
    provider: overrides.provider ?? "codex",
    title: overrides.title ?? `Agent ${overrides.id}`,
    status: overrides.status ?? "idle",
    requiresAttention: overrides.requiresAttention ?? false,
    createdAt: overrides.createdAt ?? new Date("2026-04-20T00:00:00.000Z"),
  };
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function queryByTestId(testID: string): HTMLElement | null {
  return document.querySelector(`[data-testid="${testID}"]`);
}

function queryRowIds(): string[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="subagents-track-row-"]'),
  ).map((node) => node.getAttribute("data-testid")?.replace("subagents-track-row-", "") ?? "");
}

type SubagentAction = (id: string) => void;

describe("SubagentsTrack", () => {
  let container: HTMLElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class ResizeObserver {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
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
    vi.unstubAllGlobals();
  });

  function render(
    rows: SubagentRow[],
    onOpenSubagent: SubagentAction = vi.fn<SubagentAction>(),
    onArchiveSubagent: SubagentAction = vi.fn<SubagentAction>(),
  ): SubagentAction {
    act(() => {
      root?.render(
        <SubagentsTrack
          rows={rows}
          onOpenSubagent={onOpenSubagent}
          onArchiveSubagent={onArchiveSubagent}
        />,
      );
    });
    return onOpenSubagent;
  }

  it("renders nothing when rows is empty", () => {
    render([]);
    expect(queryByTestId("subagents-track")).toBeNull();
    expect(queryByTestId("subagents-track-header")).toBeNull();
    expect(queryRowIds()).toEqual([]);
  });

  it("shows only the collapsed header and no rows initially", () => {
    render([row({ id: "child-a" }), row({ id: "child-b" })]);
    expect(queryByTestId("subagents-track-header")).not.toBeNull();
    expect(queryRowIds()).toEqual([]);
  });

  it("expands rows in the given order when the header is pressed", () => {
    render([row({ id: "child-b" }), row({ id: "child-a" }), row({ id: "child-c" })]);
    click(queryByTestId("subagents-track-header")!);
    expect(queryRowIds()).toEqual(["child-b", "child-a", "child-c"]);
  });

  it("calls onOpenSubagent with the row id when a row is pressed", () => {
    const onOpenSubagent = render([row({ id: "child-a" }), row({ id: "child-b" })]);
    click(queryByTestId("subagents-track-header")!);
    click(queryByTestId("subagents-track-row-child-b")!);
    expect(onOpenSubagent).toHaveBeenCalledTimes(1);
    expect(onOpenSubagent).toHaveBeenCalledWith("child-b");
  });

  it("renders each row through the shared workspace tab icon primitives", () => {
    render([
      row({ id: "idle-child", status: "idle", provider: "codex" }),
      row({ id: "running-child", status: "running", provider: "claude-code" }),
    ]);
    click(queryByTestId("subagents-track-header")!);

    const idleRow = queryByTestId("subagents-track-row-idle-child");
    expect(idleRow).not.toBeNull();
    expect(idleRow!.querySelectorAll('[data-testid="subagents-provider-icon"]').length).toBe(1);
    expect(idleRow!.querySelectorAll('[data-testid="subagents-synced-loader"]').length).toBe(0);

    const runningRow = queryByTestId("subagents-track-row-running-child");
    expect(runningRow).not.toBeNull();
    expect(runningRow!.querySelectorAll('[data-testid="subagents-synced-loader"]').length).toBe(1);
    expect(runningRow!.querySelectorAll('[data-testid="subagents-provider-icon"]').length).toBe(0);
  });
});
