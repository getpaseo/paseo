/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, base: 6, md: 8 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", semibold: "600" },
    fontFamily: { ui: "system-ui", mono: "monospace" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface2: "#222",
      border: "#333",
      destructive: "#f00",
      statusDotRunning: "#0a0",
    },
  },
}));

vi.mock("react-native", () => ({
  View: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
  Text: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("span", props, children),
  ScrollView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
}));

vi.mock("react-native-gesture-handler", () => ({
  ScrollView: ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) =>
    React.createElement("div", props, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps, ...props }: Record<string, unknown>) => {
      const themedProps = typeof uniProps === "function" ? uniProps(theme) : uniProps;
      return React.createElement(Component, { ...props, ...themedProps });
    },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/components/markdown/renderer", () => ({
  MarkdownRenderer: ({ text, compact }: { text: string; compact?: boolean }) =>
    React.createElement("div", { "data-testid": "markdown-renderer", "data-compact": compact ? "true" : "false" }, text),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { ToolCallDetailsContent } from "./tool-call-details";

describe("ToolCallDetailsContent", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root && container) {
      act(() => {
        root?.unmount();
      });
      container.remove();
    }
    container = null;
    root = null;
  });

  it("renders unknown string detail (such as thinking) using MarkdownRenderer", async () => {
    await act(async () => {
      root?.render(
        <ToolCallDetailsContent
          detail={{
            type: "unknown",
            input: "**Scaling Jitter Configuration**\n\nSome reasoning text `inlineCode`.",
            output: null,
          }}
        />,
      );
    });

    const markdownNode = container?.querySelector('[data-testid="markdown-renderer"]');
    expect(markdownNode).not.toBeNull();
    expect(markdownNode?.textContent).toBe("**Scaling Jitter Configuration**\n\nSome reasoning text `inlineCode`.");
    expect(markdownNode?.getAttribute("data-compact")).toBe("true");
  });
});
