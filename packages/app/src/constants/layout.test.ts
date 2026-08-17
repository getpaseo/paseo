import { describe, expect, it } from "vitest";
import {
  DESKTOP_TRAFFIC_LIGHT_BASE_TOP,
  DESKTOP_TRAFFIC_LIGHT_BUTTON_HEIGHT,
  DESKTOP_TRAFFIC_LIGHT_CENTER_Y,
  DESKTOP_TRAFFIC_LIGHT_OFFSET_Y,
  HEADER_INNER_HEIGHT,
  WORKSPACE_SECONDARY_HEADER_HEIGHT,
} from "./layout";

// The desktop shell drops an offset it considers out of range instead of applying it, which
// leaves the buttons at their pinned position with no error. Mirrors MAX_TRAFFIC_LIGHT_OFFSET_Y
// in packages/desktop/src/window/window-manager.ts.
const MAX_TRAFFIC_LIGHT_OFFSET_Y = 10;

// Every row that can own the window's top-left corner: the header row, and the shorter tab
// strip that replaces it in focus mode.
const TOP_LEFT_ROW_HEIGHTS = [HEADER_INNER_HEIGHT, WORKSPACE_SECONDARY_HEADER_HEIGHT];

describe("traffic light placement", () => {
  it("puts the buttons on the center line the app aligns to", () => {
    const centerY =
      DESKTOP_TRAFFIC_LIGHT_BASE_TOP +
      DESKTOP_TRAFFIC_LIGHT_OFFSET_Y +
      DESKTOP_TRAFFIC_LIGHT_BUTTON_HEIGHT / 2;
    expect(centerY).toBe(DESKTOP_TRAFFIC_LIGHT_CENTER_Y);
  });

  it("keeps the buttons inside every row that can own the top-left corner", () => {
    for (const rowHeight of TOP_LEFT_ROW_HEIGHTS) {
      expect(
        DESKTOP_TRAFFIC_LIGHT_CENTER_Y - DESKTOP_TRAFFIC_LIGHT_BUTTON_HEIGHT / 2,
      ).toBeGreaterThanOrEqual(0);
      expect(
        DESKTOP_TRAFFIC_LIGHT_CENTER_Y + DESKTOP_TRAFFIC_LIGHT_BUTTON_HEIGHT / 2,
      ).toBeLessThanOrEqual(rowHeight);
    }
  });

  it("stays within the offset range the desktop shell accepts", () => {
    expect(Math.abs(DESKTOP_TRAFFIC_LIGHT_OFFSET_Y)).toBeLessThanOrEqual(
      MAX_TRAFFIC_LIGHT_OFFSET_Y,
    );
  });

  it("needs no correction at startup, so the buttons do not move as the app loads", () => {
    expect(DESKTOP_TRAFFIC_LIGHT_OFFSET_Y).toBe(0);
  });
});
