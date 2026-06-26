import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MermaidFenceBlock } from "./mermaid-fence-block";

const theme = {
  colorScheme: "dark" as const,
  spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 8: 32 },
  iconSize: { sm: 14, md: 18, lg: 22 },
  borderWidth: { 1: 1 },
  borderRadius: { sm: 4, md: 6, lg: 8, full: 999 },
  fontSize: { xs: 11, sm: 13, base: 15 },
  fontWeight: { normal: "400" as const, medium: "500" as const },
  colors: {
    surface0: "#121214",
    surface1: "#18181b",
    surface2: "#27272a",
    surface3: "#3f3f46",
    foreground: "#fafafa",
    foregroundMuted: "#a1a1aa",
    border: "#3f3f46",
    borderAccent: "#52525b",
    destructive: "#dc2626",
  },
};

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) => {
    function Themed(props: Record<string, unknown>) {
      const { uniProps, ...rest } = props;
      const extra =
        typeof uniProps === "function"
          ? (uniProps as (t: typeof theme) => Record<string, unknown>)(theme)
          : {};
      return React.createElement(Component, { ...rest, ...extra });
    }
    return Themed;
  },
}));

vi.mock("@/constants/platform", () => ({
  isWeb: true,
  isNative: false,
}));

vi.mock("@/constants/layout", () => ({
  useIsCompactFormFactor: () => false,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "markdown.mermaid.diagram": "Diagram",
        "markdown.mermaid.source": "Source",
        "markdown.mermaid.viewDiagram": "View diagram",
        "markdown.mermaid.viewSource": "View source",
        "markdown.mermaid.renderFailed": "Diagram failed to render",
        "markdown.mermaid.openFullscreen": "Open fullscreen",
        "message.actions.copyCode": "Copy code",
        "message.actions.copied": "Copied",
      })[key] ?? key,
  }),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(async () => undefined),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    Check: icon("Check"),
    Copy: icon("Copy"),
    Expand: icon("Expand"),
    FileCode2: icon("FileCode2"),
    GitGraph: icon("GitGraph"),
  };
});

vi.mock("@/components/highlighted-code-block", () => ({
  HighlightedCodeBlock: ({ code }: { code: string }) =>
    React.createElement("pre", { "data-testid": "highlighted-source" }, code),
  splitFenceStyle: () => ({
    containerStyle: { position: "relative" as const, padding: 8, backgroundColor: "#222" },
    innerTextStyle: {},
  }),
}));

vi.mock("@/styles/code-surface", () => ({
  CODE_SURFACE_DATASET: { pmono: "" },
}));

const VALID_MERMAID = `flowchart LR
  A[Start] --> B[End]`;

const INVALID_MERMAID = `not valid mermaid [[[`;

const FENCE_INHERITED_STYLES = {};
const FENCE_TEXT_STYLE = {
  fontFamily: "monospace",
  fontSize: 13,
  color: "#fff",
  padding: 8,
};

function waitFor(
  predicate: () => boolean,
  options?: { timeoutMs?: number; intervalMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? 15_000;
  const intervalMs = options?.intervalMs ?? 100;
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("MermaidFenceBlock (browser)", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
  });

  it("renders an SVG for valid mermaid source", async () => {
    await act(async () => {
      root.render(
        <MermaidFenceBlock
          code={VALID_MERMAID}
          inheritedStyles={FENCE_INHERITED_STYLES}
          textStyle={FENCE_TEXT_STYLE}
        />,
      );
    });

    await waitFor(() => host.querySelector("svg") !== null, { timeoutMs: 20_000 });
    expect(host.textContent).not.toContain("Diagram failed to render");
  });

  it("shows render failure for invalid mermaid and allows source view", async () => {
    await act(async () => {
      root.render(
        <MermaidFenceBlock
          code={INVALID_MERMAID}
          inheritedStyles={FENCE_INHERITED_STYLES}
          textStyle={FENCE_TEXT_STYLE}
        />,
      );
    });

    await waitFor(() => host.textContent?.includes("Diagram failed to render") === true, {
      timeoutMs: 20_000,
    });

    const sourceButton = Array.from(host.querySelectorAll('[role="button"]')).find((el) =>
      el.getAttribute("aria-label")?.includes("View source"),
    );
    expect(sourceButton).toBeTruthy();
    await act(async () => {
      sourceButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitFor(() => host.querySelector('[data-testid="highlighted-source"]') !== null);
    expect(host.querySelector('[data-testid="highlighted-source"]')?.textContent).toContain(
      INVALID_MERMAID,
    );
  });
});
