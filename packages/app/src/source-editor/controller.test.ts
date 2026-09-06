import { describe, expect, test } from "vitest";
import { SourceEditorController } from "./controller";

function makeController() {
  const events: unknown[] = [];
  const controller = new SourceEditorController({
    editorKey: "current",
    document: "one\r\ntwo",
    callbacks: {
      onChange: (document) => events.push(["change", document]),
      onSave: () => events.push(["save"]),
      onCursorChange: (position) => events.push(["cursor", position]),
      onVimModeChange: (mode) => events.push(["vim", mode]),
    },
  });
  return { controller, events };
}

describe("SourceEditorController", () => {
  test("turns compact runtime changes into a document callback", () => {
    const { controller, events } = makeController();

    expect(
      controller.receive({
        type: "change",
        editorKey: "current",
        changes: [{ from: 4, to: 7, insert: "second" }],
      }),
    ).toBe(true);
    expect(events).toEqual([["change", "one\r\nsecond"]]);
  });

  test("rejects messages from a stale editor generation", () => {
    const { controller, events } = makeController();

    expect(controller.receive({ type: "save", editorKey: "stale" })).toBe(false);
    expect(events).toEqual([]);
  });

  test("rejects invalid changes at the document boundary", () => {
    const { controller, events } = makeController();

    expect(
      controller.receive({
        type: "change",
        editorKey: "current",
        changes: [{ from: 0, to: 99, insert: "bad" }],
      }),
    ).toBe(false);
    expect(events).toEqual([]);
  });

  test("returns a normalized replacement only when the controlled document changed", () => {
    const { controller } = makeController();

    expect(controller.replaceDocument("one\r\ntwo")).toBeNull();
    expect(controller.replaceDocument("replacement\r\ndocument")).toBe("replacement\ndocument");
  });
});
