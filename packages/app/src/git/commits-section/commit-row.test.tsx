import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { normal: "400", medium: "500" },
    fontFamily: { ui: "ui", mono: "mono" },
    borderRadius: { full: 9999 },
    borderWidth: { 1: 1 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      statusSuccess: "#0a0",
      diffAddition: "#0f0",
      diffDeletion: "#f00",
    },
  },
}));

vi.mock("react-native", () => ({
  View: ({
    children,
    testID,
    style,
  }: {
    children?: React.ReactNode;
    testID?: string;
    style?: unknown;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID, "data-style": JSON.stringify(style) },
      children,
    ),
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

vi.mock("react-native-svg", () => ({
  SvgXml: ({ xml }: { xml: string }) =>
    React.createElement("span", { "data-svg": xml, "data-icon": "file" }),
}));

vi.mock("lucide-react-native", () => ({
  ChevronRight: (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": "ChevronRight" }),
}));

vi.mock("@/components/material-file-icons", () => ({
  getFileIconSvg: (name: string) => `<svg data-name="${name}" />`,
}));

import { CommitRow } from "./commit-row";

function makeCommit(overrides: Partial<CheckoutCommit> = {}): CheckoutCommit {
  return {
    sha: "abcdef1234567890",
    shortSha: "abcdef1",
    subject: "Add the commits section",
    authorName: "Ada Lovelace",
    authorDate: "2026-06-13T00:00:00.000Z",
    isOnRemote: false,
    files: [{ path: "src/app.ts", additions: 12, deletions: 3, status: "modified" }],
    ...overrides,
  };
}

describe("CommitRow", () => {
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

  function renderRow(props: React.ComponentProps<typeof CommitRow>): void {
    act(() => {
      root?.render(<CommitRow {...props} />);
    });
  }

  it("renders the subject and short sha", () => {
    renderRow({ commit: makeCommit(), expanded: false, onToggle: vi.fn() });

    expect(container?.textContent).toContain("Add the commits section");
    expect(container?.textContent).toContain("abcdef1");
  });

  it("renders the local dot variant when the commit is not on the remote", () => {
    renderRow({ commit: makeCommit({ isOnRemote: false }), expanded: false, onToggle: vi.fn() });

    expect(container?.querySelector('[data-testid="commit-dot-local"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="commit-dot-remote"]')).toBeNull();
  });

  it("renders the remote dot variant when the commit is on the remote", () => {
    renderRow({ commit: makeCommit({ isOnRemote: true }), expanded: false, onToggle: vi.fn() });

    expect(container?.querySelector('[data-testid="commit-dot-remote"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="commit-dot-local"]')).toBeNull();
  });

  it("calls onToggle when the row is pressed", () => {
    const onToggle = vi.fn();
    renderRow({ commit: makeCommit(), expanded: false, onToggle });

    const row = container?.querySelector(
      '[data-testid="commit-row-abcdef1"]',
    ) as HTMLElement | null;
    expect(row).not.toBeNull();

    act(() => {
      row?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it("hides the file rows when collapsed and reveals them when expanded", () => {
    renderRow({ commit: makeCommit(), expanded: false, onToggle: vi.fn() });
    expect(container?.querySelector('[data-testid="commit-file-src/app.ts"]')).toBeNull();

    renderRow({ commit: makeCommit(), expanded: true, onToggle: vi.fn() });
    const fileRow = container?.querySelector('[data-testid="commit-file-src/app.ts"]');
    expect(fileRow).not.toBeNull();
    expect(container?.textContent).toContain("src/app.ts");
    expect(container?.textContent).toContain("+12");
    expect(container?.textContent).toContain("-3");
  });

  it("calls onFilePress with the commit and file when a file row is pressed", () => {
    const onFilePress = vi.fn();
    const commit = makeCommit();
    renderRow({ commit, expanded: true, onToggle: vi.fn(), onFilePress });

    const fileRow = container?.querySelector(
      '[data-testid="commit-file-src/app.ts"]',
    ) as HTMLElement | null;
    expect(fileRow).not.toBeNull();

    act(() => {
      fileRow?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(onFilePress).toHaveBeenCalledTimes(1);
    expect(onFilePress).toHaveBeenCalledWith(commit, commit.files[0]);
  });
});
