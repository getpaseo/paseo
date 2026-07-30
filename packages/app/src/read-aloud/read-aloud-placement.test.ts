import { describe, expect, it } from "vitest";

import {
  ANCHOR_OFFSET,
  BOX_PADDING,
  decidePlacement,
  intersectRects,
  type AnchorRect,
} from "@/read-aloud/read-aloud-placement";

const WIDTH = 32;
const HEIGHT = 32;

/** A scroll pane occupying the right side of a 1200x900 window. */
const PANE: AnchorRect = { top: 100, bottom: 700, left: 300, right: 1200 };

function lineRect(top: number, left: number, right: number): AnchorRect {
  return { top, bottom: top + 19, left, right };
}

/** Caret rects are zero-width, which is what the geometry actually produces. */
function caret(top: number, x: number): AnchorRect {
  return { top, bottom: top + 19, left: x, right: x };
}

function place(firstRect: AnchorRect | null, lastRect: AnchorRect | null, box = PANE) {
  return decidePlacement({ firstRect, lastRect, visibleBox: box, width: WIDTH, height: HEIGHT });
}

describe("intersectRects", () => {
  it("intersects overlapping boxes", () => {
    expect(intersectRects({ top: 0, bottom: 900, left: 0, right: 1200 }, PANE)).toEqual(PANE);
  });

  it("collapses instead of inverting when the boxes are disjoint", () => {
    const result = intersectRects(
      { top: 0, bottom: 100, left: 0, right: 100 },
      { top: 400, bottom: 500, left: 400, right: 500 },
    );
    expect(result.bottom).toBeGreaterThanOrEqual(result.top);
    expect(result.right).toBeGreaterThanOrEqual(result.left);
  });
});

describe("decidePlacement", () => {
  it("anchors above the start when the whole selection is visible", () => {
    const first = lineRect(300, 400, 700);
    const result = place(first, lineRect(340, 400, 620));

    expect(result.isOffscreen).toBe(false);
    expect(result.top).toBe(300 - HEIGHT - ANCHOR_OFFSET);
    // Centred on the anchored rect, not on the whole selection.
    expect(result.left).toBe(550 - WIDTH / 2);
  });

  it("anchors below the visible end when the start is scrolled out of the pane", () => {
    // The start is above the pane but still inside the window — the case
    // window-relative measurement gets wrong.
    const first = lineRect(20, 400, 700);
    const last = lineRect(400, 400, 620);
    const result = place(first, last);

    expect(result.isOffscreen).toBe(false);
    expect(result.top).toBe(last.bottom + ANCHOR_OFFSET);
    expect(result.left).toBe(510 - WIDTH / 2);
  });

  it("keeps the above-the-start placement when only the end is clipped", () => {
    const first = lineRect(400, 400, 700);
    const result = place(first, lineRect(900, 400, 620));

    expect(result.isOffscreen).toBe(false);
    expect(result.top).toBe(400 - HEIGHT - ANCHOR_OFFSET);
  });

  it("anchors to the pane's bottom edge when the selection is taller than the pane", () => {
    const result = place(lineRect(-500, 400, 700), lineRect(1400, 400, 620));

    expect(result.isOffscreen).toBe(false);
    expect(result.top).toBe(PANE.bottom - HEIGHT - ANCHOR_OFFSET);
    expect(result.left).toBe((PANE.left + PANE.right) / 2 - WIDTH / 2);
  });

  it("reports offscreen and parks at the top edge when the selection scrolled above the pane", () => {
    const result = place(lineRect(-200, 400, 700), lineRect(-100, 400, 620));

    expect(result.isOffscreen).toBe(true);
    expect(result.top).toBe(PANE.top + BOX_PADDING);
  });

  it("reports offscreen and parks at the bottom edge when the selection scrolled below the pane", () => {
    const result = place(lineRect(900, 400, 700), lineRect(1000, 400, 620));

    expect(result.isOffscreen).toBe(true);
    expect(result.top).toBe(PANE.bottom - HEIGHT - BOX_PADDING);
  });

  it("parks at the bottom edge when the range's nodes have detached", () => {
    const result = place(null, null);

    expect(result.isOffscreen).toBe(true);
    expect(result.top).toBe(PANE.bottom - HEIGHT - BOX_PADDING);
    expect(result.left).toBe((PANE.left + PANE.right) / 2 - WIDTH / 2);
  });

  it("flips below when there is no room above the start", () => {
    const first = lineRect(PANE.top + 2, 400, 700);
    const result = place(first, lineRect(PANE.top + 40, 400, 620));

    expect(result.top).toBe(first.bottom + ANCHOR_OFFSET);
  });

  it("flips above when there is no room below the visible end", () => {
    const first = lineRect(20, 400, 700);
    const last = lineRect(PANE.bottom - 20, 400, 620);
    const result = place(first, last);

    expect(result.top).toBe(last.top - HEIGHT - ANCHOR_OFFSET);
  });

  it("clamps into the pane, not the window", () => {
    // A selection hugging the pane's left edge would otherwise centre the
    // bubble over the sidebar.
    const first = caret(300, PANE.left + 2);
    const result = place(first, caret(320, PANE.left + 40));

    expect(result.left).toBe(PANE.left + BOX_PADDING);
  });

  it("centres rather than inverting when the box is too short to hold the bubble", () => {
    const shortPane: AnchorRect = { top: 200, bottom: 236, left: 300, right: 1200 };
    const result = place(lineRect(210, 400, 700), lineRect(215, 400, 620), shortPane);

    // The naive clamp would push the bubble to `bottom - HEIGHT - PADDING`,
    // which is above the box's top.
    expect(result.top).toBe((shortPane.top + shortPane.bottom) / 2 - HEIGHT / 2);
    expect(result.top).toBeGreaterThanOrEqual(shortPane.top);
  });

  it("keeps a wide failure pill inside the pane", () => {
    const first = caret(300, PANE.right - 10);
    const result = decidePlacement({
      firstRect: first,
      lastRect: caret(300, PANE.right - 4),
      visibleBox: PANE,
      width: 220,
      height: HEIGHT,
    });

    expect(result.left + 220).toBeLessThanOrEqual(PANE.right - BOX_PADDING);
  });
});
