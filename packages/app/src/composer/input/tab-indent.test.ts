import { describe, expect, it } from "vitest";
import { insertComposerTabIndent } from "./tab-indent";

describe("insertComposerTabIndent", () => {
  it("inserts a tab at the cursor and moves selection after it", () => {
    expect(
      insertComposerTabIndent({
        value: "foo\nbar",
        selectionStart: 4,
        selectionEnd: 4,
      }),
    ).toEqual({
      value: "foo\n\tbar",
      selectionStart: 5,
      selectionEnd: 5,
    });
  });
});
