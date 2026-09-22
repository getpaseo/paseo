import { describe, expect, it } from "vitest";

import {
  getTerminalVirtualKeyboardControlId,
  isTouchTerminalSurface,
  resolveTerminalVirtualKeyboardRows,
  shouldShowTerminalFloatingCopyAction,
  shouldShowTerminalPasteAction,
  TERMINAL_VIRTUAL_KEYBOARD_ROWS,
  TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS,
  type TerminalVirtualKeyboardControl,
} from "./terminal-virtual-keyboard";

interface ControlPosition {
  row: number;
  col: number;
}

function controlIds(
  rows: readonly (readonly TerminalVirtualKeyboardControl[])[] = TERMINAL_VIRTUAL_KEYBOARD_ROWS,
): string[] {
  return rows.flatMap((row) => row.map((control) => getTerminalVirtualKeyboardControlId(control)));
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

  it("offers the same controls in both layouts", () => {
    const wideIds = controlIds(TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS);

    expect([...wideIds].sort()).toEqual([...controlIds()].sort());
  });

  it("collapses to a single row only when the bar itself is wide enough", () => {
    expect(TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS).toHaveLength(1);
    expect(resolveTerminalVirtualKeyboardRows({ isCompact: false, availableWidth: 900 })).toBe(
      TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS,
    );
    // A 13" portrait pane with the sidebar open: measured at 698pt, every label fits.
    expect(resolveTerminalVirtualKeyboardRows({ isCompact: false, availableWidth: 698 })).toBe(
      TERMINAL_VIRTUAL_KEYBOARD_WIDE_ROWS,
    );
    // An 11" portrait pane with the sidebar open: a tablet window, but only ~515pt of bar.
    expect(resolveTerminalVirtualKeyboardRows({ isCompact: false, availableWidth: 515 })).toBe(
      TERMINAL_VIRTUAL_KEYBOARD_ROWS,
    );
    // Not laid out yet. Two rows fit everywhere, so they are the safe default.
    expect(resolveTerminalVirtualKeyboardRows({ isCompact: false, availableWidth: 0 })).toBe(
      TERMINAL_VIRTUAL_KEYBOARD_ROWS,
    );
    // Compact never gets the single row regardless of a stale wide measurement.
    expect(resolveTerminalVirtualKeyboardRows({ isCompact: true, availableWidth: 900 })).toBe(
      TERMINAL_VIRTUAL_KEYBOARD_ROWS,
    );
  });

  it("treats every native surface as touch, not just compact widths", () => {
    // A tablet: wide enough to miss the compact breakpoint, still without a physical Esc.
    expect(isTouchTerminalSurface({ isNative: true, isCompact: false })).toBe(true);
    expect(isTouchTerminalSurface({ isNative: true, isCompact: true })).toBe(true);
    // A narrow browser window still gets the bar; a desktop-width one does not.
    expect(isTouchTerminalSurface({ isNative: false, isCompact: true })).toBe(true);
    expect(isTouchTerminalSurface({ isNative: false, isCompact: false })).toBe(false);
  });
});
