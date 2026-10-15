import { describe, expect, it } from "vitest";
import { WORKSPACE_PANE_TRAILING_GLYPH_RAIL } from "@/components/tree-primitives";
import { smallIconButtonChromeFrameSize } from "@/components/ui/icon-button-chrome";
import {
  paneContentToolbarIconSize,
  paneContentToolbarTrailingPadding,
} from "@/components/ui/pane-content-toolbar";

/** Where the last control's painted edge lands, measured from the row's right edge. */
function trailingInkRail(isCompact: boolean, trailing: "glyph" | "framed"): number {
  const padding = paneContentToolbarTrailingPadding(isCompact, trailing);
  if (trailing === "framed") return padding;
  const frameOverhang =
    (smallIconButtonChromeFrameSize(isCompact) - paneContentToolbarIconSize(isCompact)) / 2;
  return padding + frameOverhang;
}

describe("pane content toolbar trailing rail", () => {
  it("lands a bare glyph on the shared rail by letting its hitbox overhang the row", () => {
    expect(trailingInkRail(false, "glyph")).toBe(WORKSPACE_PANE_TRAILING_GLYPH_RAIL);
    expect(trailingInkRail(true, "glyph")).toBe(WORKSPACE_PANE_TRAILING_GLYPH_RAIL);
    expect(paneContentToolbarTrailingPadding(true, "glyph")).toBeLessThan(
      WORKSPACE_PANE_TRAILING_GLYPH_RAIL,
    );
  });

  it("lands a framed control on the shared rail, because its frame is the ink", () => {
    expect(trailingInkRail(false, "framed")).toBe(WORKSPACE_PANE_TRAILING_GLYPH_RAIL);
    expect(trailingInkRail(true, "framed")).toBe(WORKSPACE_PANE_TRAILING_GLYPH_RAIL);
    expect(paneContentToolbarTrailingPadding(true, "framed")).toBe(
      WORKSPACE_PANE_TRAILING_GLYPH_RAIL,
    );
  });

  it("pads a framed control more than a glyph, since the glyph's frame is bigger on compact", () => {
    expect(paneContentToolbarTrailingPadding(true, "framed")).toBeGreaterThan(
      paneContentToolbarTrailingPadding(true, "glyph"),
    );
    expect(paneContentToolbarTrailingPadding(false, "framed")).toBeGreaterThan(
      paneContentToolbarTrailingPadding(false, "glyph"),
    );
  });
});
