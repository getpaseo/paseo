import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { normal: "400" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      diffAddition: "#0f0",
      diffDeletion: "#f00",
    },
  },
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: React.ReactNode }) => React.createElement("div", {}, children),
  Text: ({ children }: { children?: React.ReactNode }) => React.createElement("span", {}, children),
  Pressable: ({
    children,
    onPress,
    testID,
    accessibilityRole,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
    accessibilityRole?: string;
  }) =>
    React.createElement(
      "button",
      {
        "data-testid": testID,
        onClick: () => onPress?.(),
        role: accessibilityRole,
        type: "button",
      },
      children,
    ),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("lucide-react-native", () => ({
  ChevronRight: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "ChevronRight" }),
}));

import { DirectoryRow } from "./changed-files-tree-row";

describe("DirectoryRow", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    const dom = new JSDOM("<!doctype html><html><body></body></html>");
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("window", dom.window);
    vi.stubGlobal("document", dom.window.document);
    vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
    vi.stubGlobal("Node", dom.window.Node);
    vi.stubGlobal("navigator", dom.window.navigator);

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
    container = null;
    vi.unstubAllGlobals();
  });

  function renderRow(props: React.ComponentProps<typeof DirectoryRow>): void {
    act(() => {
      root?.render(<DirectoryRow {...props} />);
    });
  }

  it("renders the directory name", () => {
    renderRow({
      name: "components",
      depth: 0,
      additions: 42,
      deletions: 7,
      expanded: false,
      onToggle: vi.fn(),
    });

    expect(container?.textContent).toContain("components");
  });

  it("renders the aggregated additions and deletions", () => {
    renderRow({
      name: "components",
      depth: 0,
      additions: 42,
      deletions: 7,
      expanded: false,
      onToggle: vi.fn(),
    });

    expect(container?.textContent).toContain("+42");
    expect(container?.textContent).toContain("-7");
  });

  it("calls onToggle when the row is pressed", () => {
    const onToggle = vi.fn();
    renderRow({
      name: "components",
      depth: 0,
      additions: 42,
      deletions: 7,
      expanded: false,
      onToggle,
    });

    const row = container?.querySelector(
      '[data-testid="changed-files-dir-components"]',
    ) as HTMLElement | null;
    expect(row).not.toBeNull();

    act(() => {
      row?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
