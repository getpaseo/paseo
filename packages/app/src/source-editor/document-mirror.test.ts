import { describe, expect, test } from "vitest";
import { SourceDocumentMirror } from "./document-mirror";

describe("SourceDocumentMirror", () => {
  test("applies CodeMirror changes without replacing unchanged text", () => {
    const mirror = new SourceDocumentMirror("one two three");

    const document = mirror.apply([
      { from: 0, to: 3, insert: "ONE" },
      { from: 8, to: 13, insert: "THREE" },
    ]);

    expect(document).toBe("ONE two THREE");
  });

  test("preserves the file line separator while runtime offsets stay normalized", () => {
    const mirror = new SourceDocumentMirror("one\r\ntwo\r\n");

    expect(mirror.getRuntimeDocument()).toBe("one\ntwo\n");
    expect(mirror.apply([{ from: 4, to: 7, insert: "second\nline" }])).toBe(
      "one\r\nsecond\r\nline\r\n",
    );
  });

  test("rejects overlapping or out-of-range changes", () => {
    const mirror = new SourceDocumentMirror("one two");

    expect(() =>
      mirror.apply([
        { from: 0, to: 4, insert: "" },
        { from: 3, to: 7, insert: "" },
      ]),
    ).toThrow("Invalid source editor change range");
    expect(() => mirror.apply([{ from: 0, to: 8, insert: "" }])).toThrow(
      "Invalid source editor change range",
    );
  });
});
