import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import { TerminalGridView } from "./terminal-grid-view.native";
import type { TerminalViewportState } from "./headless-terminal-state";
import type { TerminalGridCellMetrics } from "./terminal-grid-metrics";

test("measures a single font cell before the terminal has its viewport columns", async () => {
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 700px; display: flex";
  document.body.appendChild(container);
  const root = createRoot(container);
  const measurements: TerminalGridCellMetrics[] = [];
  const state: TerminalViewportState = {
    rows: 1,
    cols: 1,
    firstRow: 0,
    oldestRow: 0,
    newestRow: 0,
    grid: [[{ char: " " }]],
    cursor: { row: 0, col: 0 },
  };
  const style = { flex: 1 };
  const recordMeasurement = (metrics: TerminalGridCellMetrics) => measurements.push(metrics);
  try {
    act(() =>
      root.render(
        React.createElement(TerminalGridView, {
          state,
          fontSize: 12,
          style,
          onCellMetricsChange: recordMeasurement,
        }),
      ),
    );
    await expect.poll(() => measurements.length).toBeGreaterThan(0);
    const sample = [...container.querySelectorAll("div")].find(
      (element) => element.textContent === "mmmmmmmmmm" && element.childElementCount === 0,
    );
    expect(sample).toBeDefined();
    // Native Text wraps to its containing block. Font measurement must fit even
    // when the terminal starts with one column, before layout determines its size.
    expect(sample!.parentElement!.getBoundingClientRect().width).toBeGreaterThanOrEqual(
      sample!.getBoundingClientRect().width,
    );
    // The first measurement is used to size the emulator before restore data arrives.
    // A wrapped ten-character sample reports a fraction of a cell and multiple lines.
    expect(measurements[0].cellWidth).toBeGreaterThan(5);
    expect(measurements[0].cellHeight).toBeLessThan(24);
  } finally {
    act(() => root.unmount());
    container.remove();
  }
});
