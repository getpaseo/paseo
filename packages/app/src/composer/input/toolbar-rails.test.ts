import { describe, expect, it } from "vitest";
import {
  composerToolbarOverhang,
  resolveComposerLeadingEdge,
  resolveComposerTrailingEdge,
} from "./toolbar-rails";

describe("composer toolbar rails", () => {
  it("hangs touch slots into the padding so the end ink sits on the text column's edge", () => {
    // A 44pt slot around a 24pt glyph insets the box 10; Plus and Mic ink sits 4 further in.
    expect(composerToolbarOverhang("attach", "touch")).toBe(14);
    expect(composerToolbarOverhang("dictation", "touch")).toBe(14);
    // AudioLines nearly fills its box.
    expect(composerToolbarOverhang("voiceMode", "touch")).toBe(11);
    // A 36pt disc in a 44pt slot: its edge is 4 in.
    expect(composerToolbarOverhang("disc", "touch")).toBe(4);
    // A labelled picker's glyph starts after its 8pt padding.
    expect(composerToolbarOverhang("label", "touch")).toBe(8);
  });

  it("keeps the pointer row's flat overhang", () => {
    for (const edge of ["attach", "dictation", "voiceMode", "disc", "label", "none"] as const) {
      expect(composerToolbarOverhang(edge, "pointer")).toBe(6);
    }
  });

  it("ends the row on send or stop, then voice mode, then dictation", () => {
    const base = {
      hasPrimaryAction: false,
      showsVoiceMode: true,
      showsDictation: true,
      isDictating: false,
    };
    expect(resolveComposerTrailingEdge({ ...base, hasPrimaryAction: true })).toBe("disc");
    expect(resolveComposerTrailingEdge(base)).toBe("voiceMode");
    expect(resolveComposerTrailingEdge({ ...base, showsVoiceMode: false })).toBe("dictation");
    expect(resolveComposerTrailingEdge({ ...base, showsVoiceMode: false, isDictating: true })).toBe(
      "disc",
    );
    expect(
      resolveComposerTrailingEdge({ ...base, showsVoiceMode: false, showsDictation: false }),
    ).toBe("none");
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
