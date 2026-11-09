import { describe, expect, it } from "vitest";
import {
  resolveSidebarFooterLayout,
  SIDEBAR_FOOTER_ACTIONS,
} from "@/components/sidebar-footer-layout";
import { DEFAULT_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH } from "@/stores/panel-store";

const TOUCH = 44;
const POINTER = 28;
const ROW_PADDING = 8;

function layout(rowWidth: number, controlSize: number) {
  return resolveSidebarFooterLayout({
    rowWidth,
    controlSize,
    rowPadding: ROW_PADDING,
    actions: SIDEBAR_FOOTER_ACTIONS,
  });
}

describe("sidebar footer layout", () => {
  it("keeps every action inline at the default width with either sizing", () => {
    for (const controlSize of [TOUCH, POINTER]) {
      expect(layout(DEFAULT_SIDEBAR_WIDTH, controlSize)).toEqual({
        inline: ["add-project", "usage", "hosts", "help", "settings"],
        overflow: [],
      });
    }
  });

  it("keeps every action inline at the minimum width with pointer sizing", () => {
    expect(layout(MIN_SIDEBAR_WIDTH, POINTER).overflow).toEqual([]);
  });

  // The iPhone Duo report: the folded sidebar column is about the minimum width, and touch
  // sizing makes five 44pt buttons plus padding 236pt wide.
  it("moves Help and Usage behind the caret at the minimum width with touch sizing", () => {
    expect(layout(MIN_SIDEBAR_WIDTH, TOUCH)).toEqual({
      inline: ["add-project", "hosts", "settings"],
      overflow: ["usage", "help"],
    });
  });

  it("keeps Settings and Add project inline longest", () => {
    // Three slots: two actions and the caret.
    expect(layout(3 * TOUCH + 2 * ROW_PADDING, TOUCH)).toEqual({
      inline: ["add-project", "settings"],
      overflow: ["usage", "hosts", "help"],
    });
    // Two slots: Settings and the caret.
    expect(layout(2 * TOUCH + 2 * ROW_PADDING, TOUCH)).toEqual({
      inline: ["settings"],
      overflow: ["add-project", "usage", "hosts", "help"],
    });
  });

  it("puts everything behind the caret when only the caret fits", () => {
    expect(layout(TOUCH + 2 * ROW_PADDING - 10, TOUCH)).toEqual({
      inline: [],
      overflow: ["add-project", "usage", "hosts", "help", "settings"],
    });
  });

  it("fits all five actions exactly at their combined width", () => {
    const exact = 5 * TOUCH + 2 * ROW_PADDING;
    expect(layout(exact, TOUCH).overflow).toEqual([]);
    // Browser layout rounds a little below the exact width.
    expect(layout(exact - 0.4, TOUCH).overflow).toEqual([]);
    expect(layout(exact - 1, TOUCH).overflow).toEqual(["usage", "help"]);
  });

  it("only places the actions it is given", () => {
    expect(
      resolveSidebarFooterLayout({
        rowWidth: 3 * TOUCH + 2 * ROW_PADDING,
        controlSize: TOUCH,
        rowPadding: ROW_PADDING,
        actions: ["add-project", "hosts", "settings"],
      }),
    ).toEqual({ inline: ["add-project", "hosts", "settings"], overflow: [] });
  });

  // Laying out against a guessed width would paint a clipped row for a frame on narrow sidebars.
  it("places nothing before the row has been measured", () => {
    for (const controlSize of [TOUCH, POINTER]) {
      expect(layout(0, controlSize)).toEqual({ inline: [], overflow: [] });
    }
  });
});
