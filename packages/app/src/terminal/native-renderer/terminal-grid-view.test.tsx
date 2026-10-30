// @vitest-environment jsdom
import React from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createNativeHeadlessTerminal } from "./headless-terminal-state";
import { TerminalGridView } from "./terminal-grid-view.native";

afterEach(cleanup);

describe("native terminal grid text layout", () => {
  it("gives short runs between accented glyphs layout room without widening their cells", async () => {
    const terminal = createNativeHeadlessTerminal({ rows: 1, cols: 30 });
    try {
      await terminal.write("café naïve|END");
      const view = render(<TerminalGridView state={terminal.getViewportState()} />);
      const text = view.getByText(" na", { normalizer: (value) => value });
      const run = text.parentElement!;
      const accentRun = view.getByText("é").parentElement!;
      const cellWidth = parseFloat(getComputedStyle(accentRun).width);
      expect(parseFloat(getComputedStyle(run).width)).toBe(3 * cellWidth);

      // Native Text wraps or ellipsizes when rounding or trailing letter spacing puts this
      // leading-space run just past its layout width. Layout has room; the cell box clips paint.
      expect(parseFloat(getComputedStyle(text).width)).toBeGreaterThan(3 * cellWidth);
      expect(getComputedStyle(text).position).toBe("absolute");
      expect(getComputedStyle(run).overflowX).toBe("hidden");
      expect(view.getByTestId("terminal-row-0").getAttribute("aria-label")).toBe("café naïve|END");
    } finally {
      terminal.dispose();
    }
  });
});
