import { describe, expect, it } from "vitest";
import { composerToolbarOverhang, resolveComposerLeadingEdge } from "./toolbar-rails";

describe("composer toolbar rails", () => {
  it("keeps touch glyphs and labels on the text rails and nests a trailing disc into the corner", () => {
    for (const edge of ["attach", "dictation", "voiceMode", "label", "none"] as const) {
      expect(composerToolbarOverhang(edge, "touch")).toBe(0);
    }
    // A 36pt disc centred in the 44pt row sits 8 from the bottom edge, so it sits 8 from the side.
    expect(composerToolbarOverhang("disc", "touch")).toBe(8);
  });

  it("keeps the pointer row's flat overhang", () => {
    for (const edge of ["attach", "dictation", "voiceMode", "disc", "label", "none"] as const) {
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
