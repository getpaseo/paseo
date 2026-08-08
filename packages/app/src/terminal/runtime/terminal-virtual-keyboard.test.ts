import { describe, expect, it } from "vitest";

import {
  getTerminalVirtualKeyboardControlId,
  shouldShowTerminalFloatingCopyAction,
  shouldShowTerminalPasteAction,
  TERMINAL_VIRTUAL_KEYBOARD_ROWS,
  type TerminalVirtualKeyboardControl,
} from "./terminal-virtual-keyboard";

interface ControlPosition {
  row: number;
  col: number;
}

function controlIds(): string[] {
  return TERMINAL_VIRTUAL_KEYBOARD_ROWS.flatMap((row) =>
    row.map((control) => getTerminalVirtualKeyboardControlId(control)),
  );
}

function controlPositions(): Map<string, ControlPosition> {
  const positions = new Map<string, ControlPosition>();
  TERMINAL_VIRTUAL_KEYBOARD_ROWS.forEach((row, rowIndex) => {
    row.forEach((control, colIndex) => {
      positions.set(getTerminalVirtualKeyboardControlId(control), {
        row: rowIndex,
        col: colIndex,
      });
    });
  });
  return positions;
}

function controlsByType(
  type: TerminalVirtualKeyboardControl["type"],
): TerminalVirtualKeyboardControl[] {
  return TERMINAL_VIRTUAL_KEYBOARD_ROWS.flatMap((row) =>
    row.filter((control) => control.type === type),
  );
}

describe("terminal virtual keyboard policy", () => {
  it("does not expose redundant Space or Backspace controls", () => {
    expect(controlIds()).toEqual([
      "terminal-key-esc",
      "terminal-key-tab",
      "terminal-key-ctrl",
      "terminal-key-up",
      "terminal-key-shift",
      "terminal-keyboard-toggle",
      "terminal-key-alt",
      "terminal-paste",
      "terminal-key-left",
      "terminal-key-down",
      "terminal-key-right",
      "terminal-key-enter",
    ]);
  });

  it("keeps the arrows in an inverted-T cluster", () => {
    const positions = controlPositions();

    expect({
      up: positions.get("terminal-key-up"),
      left: positions.get("terminal-key-left"),
      down: positions.get("terminal-key-down"),
      right: positions.get("terminal-key-right"),
    }).toEqual({
      up: { row: 0, col: 3 },
      left: { row: 1, col: 2 },
      down: { row: 1, col: 3 },
      right: { row: 1, col: 4 },
    });
  });

  it("keeps Paste in the keyboard and Copy out of the permanent row", () => {
    expect(controlsByType("paste")).toHaveLength(1);
    expect(controlIds()).toContain("terminal-paste");
    expect(controlIds()).not.toContain("terminal-copy");
  });

  it("shows Copy only as a native selection affordance", () => {
    expect(
      shouldShowTerminalFloatingCopyAction({
        hasSelection: false,
        isNative: true,
      }),
    ).toBe(false);
    expect(
      shouldShowTerminalFloatingCopyAction({
        hasSelection: true,
        isNative: false,
      }),
    ).toBe(false);
    expect(
      shouldShowTerminalFloatingCopyAction({
        hasSelection: true,
        isNative: true,
      }),
    ).toBe(true);
  });

  it("keeps Paste native-gated", () => {
    expect(shouldShowTerminalPasteAction({ isNative: true })).toBe(true);
    expect(shouldShowTerminalPasteAction({ isNative: false })).toBe(false);
  });
});
