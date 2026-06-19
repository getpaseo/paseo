import type { TerminalCell } from "@getpaseo/protocol/messages";
import { describe, expect, test } from "vitest";

import { createTerminalCellStyleResolver, DEFAULT_TERMINAL_THEME } from "./colors";
import { buildRows } from "./terminal-row-model";

function cell(char: string, overrides: Partial<TerminalCell> = {}): TerminalCell {
  return { char, ...overrides };
}

describe("terminal row model", () => {
  test("preserves terminal cell width for styled runs and trailing spaces", () => {
    const resolver = createTerminalCellStyleResolver(DEFAULT_TERMINAL_THEME);

    const rows = buildRows({
      grid: [
        [cell("n", { bg: 2, bgMode: 1 }), cell("v", { bg: 2, bgMode: 1 }), cell(" "), cell(" ")],
      ],
      resolver,
    });

    expect(rows[0].runs.map((run) => ({ text: run.text, cellCount: run.cellCount }))).toEqual([
      { text: "nv", cellCount: 2 },
      { text: "  ", cellCount: 2 },
    ]);
  });
});
