import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiffLine } from "@/git/use-diff-query";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 2: 8, 3: 12 },
    fontSize: { code: 12 },
    lineHeight: { diff: 18 },
    fontFamily: { mono: "mono" },
    borderWidth: { 1: 1 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#333",
      surface1: "#111",
      surface2: "#222",
      surfaceDiffEmpty: "#000",
      diffAddition: "#0f0",
      diffDeletion: "#f00",
      syntax: { keyword: "#c0f", string: "#0fc" },
    },
  },
}));

function flattenStyle(style: unknown): Record<string, unknown> {
  if (Array.isArray(style)) {
    return style.reduce<Record<string, unknown>>(
      (acc, s) => Object.assign(acc, flattenStyle(s)),
      {},
    );
  }
  if (style && typeof style === "object") {
    return style as Record<string, unknown>;
  }
  return {};
}

vi.mock("react-native", () => ({
  View: ({
    children,
    style,
    testID,
  }: {
    children?: React.ReactNode;
    style?: unknown;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID, "data-style": JSON.stringify(flattenStyle(style)) },
      children,
    ),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
  Pressable: ({ children, style }: { children?: React.ReactNode; style?: unknown }) =>
    React.createElement("div", { "data-style": JSON.stringify(flattenStyle(style)) }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
}));

vi.mock("@/constants/platform", () => ({ isNative: false, isWeb: true }));

vi.mock("@/styles/unistyles-inline-style", () => ({
  inlineUnistylesStyle: (style: Record<string, unknown>) => style,
}));

const gutterCellCalls = vi.hoisted(() => [] as Array<{ reviewTarget: unknown }>);

vi.mock("@/review", () => ({
  InlineReviewGutterCell: ({
    children,
    style,
    reviewTarget,
  }: {
    children?: React.ReactNode;
    style?: unknown;
    reviewTarget?: unknown;
  }) => {
    gutterCellCalls.push({ reviewTarget: reviewTarget ?? null });
    return React.createElement(
      "div",
      {
        "data-gutter": "1",
        "data-has-target": reviewTarget ? "1" : "0",
        "data-style": JSON.stringify(flattenStyle(style)),
      },
      children,
    );
  },
  isInlineReviewEditorForTarget: () => false,
}));

import { DiffUnifiedLineRow } from "./diff-unified-line-row";
import type { ReviewableDiffTarget } from "@/utils/diff-layout";
import type { InlineReviewActions } from "@/review";

const REVIEW_TARGET = { key: "target-key" } as unknown as ReviewableDiffTarget;

function makeReviewActions(): InlineReviewActions {
  return {
    commentsByTarget: new Map(),
    editor: null,
    onStartComment: vi.fn(),
  } as unknown as InlineReviewActions;
}

function makeLine(type: DiffLine["type"], content: string): DiffLine {
  return {
    type,
    content,
    tokens: [
      { text: "const", style: "keyword" },
      { text: ` ${content}`, style: null },
    ],
  } as unknown as DiffLine;
}

describe("DiffUnifiedLineRow", () => {
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
    gutterCellCalls.length = 0;
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

  function render(
    line: DiffLine,
    lineNumber: number | null,
    options?: {
      reviewTarget?: ReviewableDiffTarget | null;
      reviewActions?: InlineReviewActions;
    },
  ): void {
    act(() => {
      root?.render(
        <DiffUnifiedLineRow
          line={line}
          lineNumber={lineNumber}
          gutterWidth={40}
          gutterTestID="gutter"
          contentTestID="content"
          reviewTarget={options?.reviewTarget}
          reviewActions={options?.reviewActions}
        />,
      );
    });
  }

  it("renders the line number in the gutter and the content tokens", () => {
    render(makeLine("add", "x"), 12);

    expect(container?.querySelector('[data-testid="gutter"]')?.textContent).toContain("12");
    expect(container?.textContent).toContain("const");
    expect(container?.textContent).toContain("x");
  });

  it("applies the add-line background to the row container", () => {
    render(makeLine("add", "x"), 1);

    const rowStyles = Array.from(container?.querySelectorAll("[data-style]") ?? [])
      .map((el) => JSON.parse(el.getAttribute("data-style") ?? "{}"))
      .filter((s) => typeof s.backgroundColor === "string");
    expect(rowStyles.some((s) => s.backgroundColor === "rgba(46, 160, 67, 0.15)")).toBe(true);
  });

  it("applies the remove-line background to the row container", () => {
    render(makeLine("remove", "y"), 3);

    const rowStyles = Array.from(container?.querySelectorAll("[data-style]") ?? [])
      .map((el) => JSON.parse(el.getAttribute("data-style") ?? "{}"))
      .filter((s) => typeof s.backgroundColor === "string");
    expect(rowStyles.some((s) => s.backgroundColor === "rgba(248, 81, 73, 0.1)")).toBe(true);
  });

  it("does not surface the comment affordance without reviewActions (per-commit diff)", () => {
    render(makeLine("add", "x"), 1, { reviewTarget: REVIEW_TARGET });

    // Without reviewActions, DiffGutterCell must hand a null reviewTarget to
    // InlineReviewGutterCell so canComment is false (no "+", disabled, no a11y
    // add-comment label) even though the diff produced a reviewTarget.
    expect(gutterCellCalls.length).toBeGreaterThan(0);
    expect(gutterCellCalls.every((call) => call.reviewTarget === null)).toBe(true);
    expect(container?.querySelector('[data-has-target="1"]')).toBeNull();
  });

  it("passes the reviewTarget through when reviewActions is present (Changes panel)", () => {
    render(makeLine("add", "x"), 1, {
      reviewTarget: REVIEW_TARGET,
      reviewActions: makeReviewActions(),
    });

    expect(gutterCellCalls.some((call) => call.reviewTarget === REVIEW_TARGET)).toBe(true);
    expect(container?.querySelector('[data-has-target="1"]')).not.toBeNull();
  });
});
