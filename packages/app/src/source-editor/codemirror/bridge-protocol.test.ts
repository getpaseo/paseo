import { describe, expect, test } from "vitest";
import { parseSourceEditorBridgeMessage } from "./bridge-protocol";

describe("parseSourceEditorBridgeMessage", () => {
  test("accepts compact document changes", () => {
    expect(
      parseSourceEditorBridgeMessage(
        JSON.stringify({
          type: "change",
          editorKey: "editor-1",
          changes: [{ from: 2, to: 4, insert: "replacement" }],
        }),
      ),
    ).toEqual({
      type: "change",
      editorKey: "editor-1",
      changes: [{ from: 2, to: 4, insert: "replacement" }],
    });
  });

  test("rejects malformed bridge input", () => {
    expect(parseSourceEditorBridgeMessage("not json")).toBeNull();
    expect(
      parseSourceEditorBridgeMessage(
        JSON.stringify({ type: "change", editorKey: "editor-1", changes: [{ from: "2" }] }),
      ),
    ).toBeNull();
  });
});
