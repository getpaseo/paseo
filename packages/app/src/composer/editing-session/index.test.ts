import { describe, expect, it } from "vitest";
import { ComposerEditingSession } from "./index";

function leaveLiveDraft(session: ComposerEditingSession) {
  session.captureForRemount({
    snapshot: { text: "Unpublished live draft", selection: { start: 4, end: 17 } },
    focused: true,
    replacementKey: "draft:applied",
  });
}

describe("composer editing remount handoff", () => {
  it("keeps live text and selection when remounting from an initial draft publication", () => {
    const session = new ComposerEditingSession();
    leaveLiveDraft(session);
    const handoff = session.takeHandoff({ kind: "initial", key: "draft:initial", text: "stale" });
    expect(handoff?.snapshot).toEqual({
      text: "Unpublished live draft",
      selection: { start: 4, end: 17 },
    });
    expect(handoff?.focused).toBe(true);
  });

  it("keeps local edits when the last applied replacement is still current", () => {
    const session = new ComposerEditingSession();
    leaveLiveDraft(session);
    const handoff = session.takeHandoff({
      kind: "replace",
      key: "draft:applied",
      text: "old replacement",
    });
    expect(handoff?.snapshot).toEqual({
      text: "Unpublished live draft",
      selection: { start: 4, end: 17 },
    });
  });

  it.each(["New explicit draft", ""])(
    "honors an explicit replacement made while the editor is absent: %j",
    (text) => {
      const session = new ComposerEditingSession();
      leaveLiveDraft(session);
      const handoff = session.takeHandoff({ kind: "replace", key: "draft:new", text });
      expect(handoff?.snapshot).toEqual({
        text,
        selection: { start: text.length, end: text.length },
      });
      expect(handoff?.focused).toBe(true);
      expect(session.takeHandoff({ kind: "replace", key: "draft:new", text })).toBeNull();
    },
  );
});
