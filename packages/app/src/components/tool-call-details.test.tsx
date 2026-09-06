// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, setStringAsync } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, md: 6, lg: 8, xl: 12, full: 999 },
    fontFamily: { mono: "monospace", ui: "system-ui" },
    fontSize: { xs: 11, sm: 13, base: 15, code: 13 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      surface1: "#111",
      surface2: "#222",
      syntax: {
        keyword: "#c792ea",
        comment: "#6a9955",
        string: "#ce9178",
        number: "#b5cea8",
        function: "#dcdcaa",
        variable: "#9cdcfe",
        type: "#4ec9b0",
        punctuation: "#d4d4d4",
        operator: "#d4d4d4",
        property: "#9cdcfe",
      },
    },
  },
  setStringAsync: vi.fn<() => Promise<void>>(() => Promise.resolve()),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: <T,>(component: T) => component,
}));

vi.mock("react-native", async () => {
  const ReactModule = await import("react");
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return {
    ...actual,
    Pressable: ({
      accessibilityLabel,
      children,
      onPress,
    }: {
      accessibilityLabel?: string;
      children?:
        | React.ReactNode
        | ((state: { hovered: boolean; pressed: boolean }) => React.ReactNode);
      onPress?: () => void;
    }) => {
      const resolvedChildren =
        typeof children === "function" ? children({ hovered: false, pressed: false }) : children;
      return ReactModule.createElement(
        "button",
        {
          "aria-label": accessibilityLabel,
          onClick: onPress,
          type: "button",
        },
        resolvedChildren,
      );
    },
  };
});

vi.mock("react-native-gesture-handler", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return {
    ScrollView: actual.ScrollView,
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "message.actions.copied": "Copied",
        "message.actions.copyCode": "Copy code",
        "common.actions.copy": "Copy",
        "common.states.copied": "Copied",
        "toolCallDetails.empty": "No additional details available",
        "toolCallDetails.error": "Error",
      })[key] ?? key,
  }),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync,
}));

vi.mock("@/utils/highlight-cache", () => ({
  extensionFromPath: () => "md",
  highlightToKeyedLines: () => null,
}));

vi.mock("@/utils/diff-highlight", () => ({
  highlightDiffLines: (lines: unknown) => lines,
}));

vi.mock("@/utils/tool-call-parsers", () => ({
  buildLineDiff: () => undefined,
  parseUnifiedDiff: () => undefined,
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    Check: createIcon("Check"),
    Copy: createIcon("Copy"),
  };
});

import { ToolCallDetailsContent } from "./tool-call-details";

const MARKDOWN_WRITE_CONTENT = "# Release plan\n\n- Ship the copy button\n";
const MARKDOWN_WRITE_DETAIL = {
  type: "write" as const,
  filePath: "docs/plans/release.md",
  content: MARKDOWN_WRITE_CONTENT,
};
const NON_MARKDOWN_WRITE_DETAIL = {
  type: "write" as const,
  filePath: "src/release.ts",
  content: "export const shipped = true;\n",
};

describe("ToolCallDetailsContent", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    setStringAsync.mockClear();
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

  it("copies markdown write detail content from the write panel", async () => {
    act(() => {
      root?.render(<ToolCallDetailsContent detail={MARKDOWN_WRITE_DETAIL} />);
    });

    const button = container?.querySelector('button[aria-label="Copy"]');
    expect(button).not.toBeNull();

    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(setStringAsync).toHaveBeenCalledWith(MARKDOWN_WRITE_CONTENT);
  });

  it("does not show the write copy button for non-markdown files", () => {
    act(() => {
      root?.render(<ToolCallDetailsContent detail={NON_MARKDOWN_WRITE_DETAIL} />);
    });

    expect(container?.querySelector('button[aria-label="Copy"]')).toBeNull();
  });
});
