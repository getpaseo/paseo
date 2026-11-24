// @vitest-environment jsdom
import "@/test/window-local-storage";
import { i18n as testI18n } from "@/i18n/i18next";
import { cleanup, render } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { highlightDiffLines } from "@/utils/diff-highlight";
import { buildLineDiff, parseUnifiedDiff } from "@/utils/tool-call-parsers";
import { DiffViewer } from "./diff-viewer";

void testI18n;

vi.mock("react-native-unistyles", async () => {
  const { darkTheme: theme } = await import("@/styles/theme");
  return {
    StyleSheet: {
      create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
    },
    withUnistyles: <T,>(component: T) => component,
    useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
  };
});

afterEach(() => {
  cleanup();
});

describe("DiffViewer", () => {
  it("overlays word-level change backgrounds onto syntax-highlighted lines", () => {
    const diff = highlightDiffLines(
      buildLineDiff('routeA: "PBH (M_i=352)"', 'routeA: "PBH (M_i=353)"'),
      "/repo/src/theoryContentEn.ts",
    );

    const { getByText } = render(<DiffViewer diffLines={diff} />);

    const removedWord = getByText("352");
    const addedWord = getByText("353");

    expect(removedWord.style.backgroundColor).toBe("rgba(248, 81, 73, 0.35)");
    expect(addedWord.style.backgroundColor).toBe("rgba(46, 160, 67, 0.4)");
    // Syntax foreground color is preserved on the highlighted word inside the string token.
    expect(removedWord.style.color).not.toBe("");
    expect(addedWord.style.color).not.toBe("");
  });

  it("highlights word-level changes parsed from unifiedDiff for supported languages", () => {
    const unified = ["@@ -1 +1 @@", "-const count = 10;", "+const count = 20;"].join("\n");
    const diff = highlightDiffLines(parseUnifiedDiff(unified), "/repo/src/counter.ts");

    const { getByText } = render(<DiffViewer diffLines={diff} />);

    expect(getByText("10").style.backgroundColor).toBe("rgba(248, 81, 73, 0.35)");
    expect(getByText("20").style.backgroundColor).toBe("rgba(46, 160, 67, 0.4)");
  });

  it("wraps long lines instead of forcing horizontal scroll", () => {
    const diff = highlightDiffLines(
      buildLineDiff(
        'routeA: "very long text ending with M_i=352"',
        'routeA: "very long text ending with M_i=353"',
      ),
      "/repo/src/theoryContentEn.ts",
    );

    const { getByText } = render(<DiffViewer diffLines={diff} />);
    const lineText = getByText("352").parentElement;

    expect(lineText?.style.whiteSpace).toBe("pre-wrap");
    expect(lineText?.style.overflowWrap).toBe("anywhere");
  });

  it("renders the empty state when there are no diff lines", () => {
    const { getByText } = render(<DiffViewer diffLines={[]} emptyLabel="Nothing changed" />);
    expect(getByText("Nothing changed")).toBeTruthy();
  });
});
