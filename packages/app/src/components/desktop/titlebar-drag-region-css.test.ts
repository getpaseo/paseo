import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NO_DRAG_SCOPE_ATTRIBUTE, TITLEBAR_DRAG_OVERLAY_ATTRIBUTE } from "./titlebar-drag-region";

const indexHtml = readFileSync(path.resolve(__dirname, "../../../public/index.html"), "utf8");

describe("index.html app-region backstop", () => {
  it("scopes the no-drag backstop to drag-overlay surfaces and no-drag scopes", () => {
    expect(indexHtml).toContain(`:has(> [${TITLEBAR_DRAG_OVERLAY_ATTRIBUTE}]) button`);
    expect(indexHtml).toContain(`[${NO_DRAG_SCOPE_ATTRIBUTE}] button`);
  });

  it("does not apply the no-drag backstop globally", () => {
    // A global backstop lets scrolled-out list content (whose layout rects pass
    // through the titlebar strip unclipped) subtract from the drag region.
    expect(indexHtml).not.toMatch(/^\s*button,$/m);
    expect(indexHtml).not.toMatch(/^\s*\[tabindex\],$/m);
  });
});
