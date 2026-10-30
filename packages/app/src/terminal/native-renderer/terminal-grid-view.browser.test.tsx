import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import type { TerminalViewportState } from "./headless-terminal-state";
import { TerminalGridView } from "./terminal-grid-view.native";

const fixtureStyle = { width: 1000 };
const output = "#".repeat(49);
const state: TerminalViewportState = {
  rows: 1,
  cols: 49,
  firstRow: 0,
  oldestRow: 0,
  newestRow: 0,
  grid: [[...output].map((char) => ({ char }))],
  cursor: { row: 0, col: 48, hidden: true },
};

const styledRuns = ["a", "bc", "defg", "hijkl"];
const styledState: TerminalViewportState = {
  ...state,
  cols: 12,
  grid: [
    styledRuns.flatMap((text, index) =>
      [...text].map((char) => ({ char, fg: index + 1, fgMode: 1 })),
    ),
  ],
};

const measuredCellWidths: number[] = [];
function onCellMetricsChange(metrics: { cellWidth: number }) {
  measuredCellWidths.push(metrics.cellWidth);
}

afterEach(() => {
  cleanup();
  measuredCellWidths.length = 0;
});

describe("native terminal full-width text", () => {
  it.each([9, 11, 12, 14, 18])(
    "keeps short colored runs complete despite native layout rounding at %s px",
    async (fontSize) => {
      const view = render(
        <TerminalGridView state={styledState} fontSize={fontSize} style={fixtureStyle} />,
      );
      for (const runText of styledRuns) {
        const text = view.getByText(runText);
        const run = text.parentElement!;
        await expect.poll(() => run.clientWidth).toBeGreaterThan(0);
        // Native one-line layout rounds independently of the cell box. Leave text
        // layout at least one physical pixel of slack, while the cell box clips paint.
        await expect
          .poll(() => text.getBoundingClientRect().width - run.getBoundingClientRect().width)
          .toBeGreaterThanOrEqual(1 / window.devicePixelRatio);
        expect(getComputedStyle(run).overflowX).toBe("hidden");
        const range = document.createRange();
        range.selectNodeContents(text);
        expect(range.getBoundingClientRect().width).toBeLessThanOrEqual(
          text.getBoundingClientRect().width,
        );
      }
      expect(view.getByTestId("terminal-row-0").getAttribute("aria-label")).toBe(
        styledRuns.join(""),
      );
    },
  );
  it.each([9, 11, 12, 14, 18])(
    "fits every character in a full-width ASCII row at %s px",
    async (fontSize) => {
      const view = render(
        <TerminalGridView
          state={state}
          style={fixtureStyle}
          fontSize={fontSize}
          onCellMetricsChange={onCellMetricsChange}
        />,
      );
      await expect.poll(() => measuredCellWidths.at(-1) ?? 0).toBeGreaterThan(0);
      const text = view.getByText(output);
      await expect.poll(() => text.clientWidth).toBeGreaterThan(0);
      // The native Text adapter truncates overflowing one-line content. Compare the actual
      // font layout with the available width, rather than asserting a particular CSS policy.
      await expect.poll(() => text.scrollWidth - text.clientWidth).toBeLessThanOrEqual(1);
      const run = text.parentElement!;
      expect(run.getBoundingClientRect().width).toBeCloseTo(49 * measuredCellWidths.at(-1)!, 1);
      expect(view.getByTestId("terminal-row-0").getAttribute("aria-label")).toBe(output);
    },
  );
});
