import { describe, expect, it } from "vitest";
import { composerToolbarOverhang, resolveComposerLeadingEdge } from "./toolbar-rails";

describe("composer toolbar rails", () => {
  it("hangs each end highlight far enough to put its ink on the text rail and nests a trailing disc into the corner", () => {
    // The 36pt highlight around the plus's ink (14/24 of a 20pt glyph, plus its 1.5 stroke).
    expect(composerToolbarOverhang("attach", "touch")).toBeCloseTo((36 - (14 * 20) / 24 - 1.5) / 2);
    expect(composerToolbarOverhang("label", "touch")).toBe(8);
    expect(composerToolbarOverhang("none", "touch")).toBe(0);
    // A 36pt disc centred in the 44pt row sits 8 from the bottom edge, so it sits 8 from the side.
    expect(composerToolbarOverhang("disc", "touch")).toBe(8);
  });

  it("keeps the pointer row's flat overhang", () => {
    for (const edge of ["attach", "disc", "label", "none"] as const) {
      expect(composerToolbarOverhang(edge, "pointer")).toBe(6);
    }
  });

  it("starts the row on attach, else on the agent controls", () => {
    expect(resolveComposerLeadingEdge({ showsAttach: true, showsAgentControls: true })).toBe(
      "attach",
    );
    expect(resolveComposerLeadingEdge({ showsAttach: false, showsAgentControls: true })).toBe(
      "label",
    );
    expect(resolveComposerLeadingEdge({ showsAttach: false, showsAgentControls: false })).toBe(
      "none",
    );
  });
});
