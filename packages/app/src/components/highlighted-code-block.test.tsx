/**
 * @vitest-environment jsdom
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      surface2: "#222",
      syntax: {
        keyword: "#fff",
        comment: "#fff",
        string: "#fff",
        number: "#fff",
        literal: "#fff",
        function: "#fff",
        definition: "#fff",
        class: "#fff",
        type: "#fff",
        tag: "#fff",
        attribute: "#fff",
        property: "#fff",
        variable: "#fff",
        operator: "#fff",
        punctuation: "#fff",
        regexp: "#fff",
        escape: "#fff",
        meta: "#fff",
        heading: "#fff",
        link: "#fff",
      },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
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
        "message.actions.copied": "Copied",
        "message.actions.copyCode": "Copy code",
      })[key] ?? key,
  }),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { ...props, "data-icon": name });
  return {
    Check: createIcon("Check"),
    Copy: createIcon("Copy"),
  };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { HighlightedCodeBlock } from "./highlighted-code-block";

const EMPTY_TEXT_STYLE = {};
const CODE_TEXT_STYLE = { fontFamily: "monospace", fontSize: 13, color: "#fff" };
const issue1589Fixture = readFileSync(
  join(process.cwd(), "src/components/fixtures/issue-1589-homelab-microvms-proposal.broken.txt"),
  "utf8",
);
const issue1589DiagramFence = extractFirstFence(issue1589Fixture);

function extractFirstFence(markdown: string): string {
  const fenceStart = markdown.indexOf("```");
  if (fenceStart < 0) {
    throw new Error("issue 1589 fixture is missing the expected fenced code block");
  }
  const contentStart = markdown.indexOf("\n", fenceStart);
  const fenceEnd = markdown.indexOf("\n```", contentStart + 1);
  if (contentStart < 0 || fenceEnd < 0) {
    throw new Error("issue 1589 fixture is missing the expected fenced code block");
  }
  return markdown.slice(contentStart + 1, fenceEnd);
}

describe("HighlightedCodeBlock", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
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
  });

  function render(element: React.ReactElement): void {
    act(() => {
      root?.render(element);
    });
  }

  it("renders plain diagram code as separate preformatted lines", () => {
    render(
      <HighlightedCodeBlock
        code={`${issue1589DiagramFence}\n`}
        language={null}
        inheritedStyles={EMPTY_TEXT_STYLE}
        textStyle={CODE_TEXT_STYLE}
      />,
    );

    const lineElements = Array.from(container?.querySelectorAll("div, span") ?? []).filter(
      (element) =>
        (element.textContent?.includes("│") || element.textContent?.includes("┌")) &&
        !element.textContent.includes("Host"),
    );

    expect(container?.textContent).toContain("bridge: fcbr0");
    expect(lineElements.length).toBeGreaterThanOrEqual(3);
    expect(
      lineElements.some((element) =>
        (element.getAttribute("style") ?? "").includes("white-space: pre"),
      ),
    ).toBe(true);
  });
});
