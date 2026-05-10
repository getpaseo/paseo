/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SubagentsSection } from "./section";
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
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
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
    document.querySelectorAll<HTMLElement>('[data-testid^="subagents-section-row-"]'),
  ).map((node) => node.getAttribute("data-testid")?.replace("subagents-section-row-", "") ?? "");
}

describe("SubagentsSection", () => {
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
    onOpenSubagent: ReturnType<typeof vi.fn> = vi.fn(),
    onArchiveSubagent: ReturnType<typeof vi.fn> = vi.fn(),
  ): ReturnType<typeof vi.fn> {
    act(() => {
      root?.render(
        <SubagentsSection
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
    expect(queryByTestId("subagents-section")).toBeNull();
    expect(queryByTestId("subagents-section-header")).toBeNull();
    expect(queryRowIds()).toEqual([]);
  });

  it("shows only the collapsed header and no rows initially", () => {
    render([row({ id: "child-a" }), row({ id: "child-b" })]);
    expect(queryByTestId("subagents-section-header")).not.toBeNull();
    expect(queryRowIds()).toEqual([]);
  });

  it("expands rows in the given order when the header is pressed", () => {
    render([row({ id: "child-b" }), row({ id: "child-a" }), row({ id: "child-c" })]);
    click(queryByTestId("subagents-section-header")!);
    expect(queryRowIds()).toEqual(["child-b", "child-a", "child-c"]);
  });

  it("calls onOpenSubagent with the row id when a row is pressed", () => {
    const onOpenSubagent = render([row({ id: "child-a" }), row({ id: "child-b" })]);
    click(queryByTestId("subagents-section-header")!);
    click(queryByTestId("subagents-section-row-child-b")!);
    expect(onOpenSubagent).toHaveBeenCalledTimes(1);
    expect(onOpenSubagent).toHaveBeenCalledWith("child-b");
  });

  describe("header copy", () => {
    it("renders '2 subagents' when two rows are not running", () => {
      render([row({ id: "child-a" }), row({ id: "child-b" })]);
      expect(queryByTestId("subagents-section-header")?.textContent).toBe("2 subagents");
    });

    it("renders '3 subagents · 1 running' with a single running row", () => {
      render([
        row({ id: "child-a", status: "running" }),
        row({ id: "child-b" }),
        row({ id: "child-c" }),
      ]);
      expect(queryByTestId("subagents-section-header")?.textContent).toBe(
        "3 subagents · 1 running",
      );
    });

    it("renders '1 subagent' for a finished row that still requires attention upstream", () => {
      render([row({ id: "child-a", requiresAttention: true })]);
      expect(queryByTestId("subagents-section-header")?.textContent).toBe("1 subagent");
    });

    it("renders '5 subagents · 2 running' when finished rows require attention upstream", () => {
      render([
        row({ id: "a", status: "running" }),
        row({ id: "b", status: "running" }),
        row({ id: "c", requiresAttention: true }),
        row({ id: "d" }),
        row({ id: "e" }),
      ]);
      expect(queryByTestId("subagents-section-header")?.textContent).toBe(
        "5 subagents · 2 running",
      );
    });
  });

  it("ignores requiresAttention for non-running header copy", () => {
    render([
      row({ id: "a", status: "error", requiresAttention: false }),
      row({ id: "b", status: "idle", requiresAttention: false }),
      row({ id: "c", status: "idle", requiresAttention: true }),
    ]);
    expect(queryByTestId("subagents-section-header")?.textContent).toBe("3 subagents");
  });

  it("still counts running rows even when they require attention", () => {
    render([
      row({ id: "a", status: "error", requiresAttention: true }),
      row({ id: "b", status: "running", requiresAttention: true }),
      row({ id: "c", status: "idle", requiresAttention: true }),
    ]);
    expect(queryByTestId("subagents-section-header")?.textContent).toBe("3 subagents · 1 running");
  });

  it("renders each row through the shared workspace tab icon primitives", () => {
    render([
      row({ id: "idle-child", status: "idle", provider: "codex" }),
      row({ id: "running-child", status: "running", provider: "claude-code" }),
    ]);
    click(queryByTestId("subagents-section-header")!);

    const idleRow = queryByTestId("subagents-section-row-idle-child");
    expect(idleRow).not.toBeNull();
    expect(idleRow!.querySelectorAll('[data-testid="subagents-provider-icon"]').length).toBe(1);
    expect(idleRow!.querySelectorAll('[data-testid="subagents-synced-loader"]').length).toBe(0);

    const runningRow = queryByTestId("subagents-section-row-running-child");
    expect(runningRow).not.toBeNull();
    expect(runningRow!.querySelectorAll('[data-testid="subagents-synced-loader"]').length).toBe(1);
    expect(runningRow!.querySelectorAll('[data-testid="subagents-provider-icon"]').length).toBe(0);
  });
});
