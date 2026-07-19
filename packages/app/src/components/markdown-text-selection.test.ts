import { describe, expect, it } from "vitest";
import { iosMarkdownTextIsSelectable } from "./markdown-text-selection";

describe("markdown text selection", () => {
  it("uses plain text only for iOS table cells", () => {
    expect({
      tableCell: iosMarkdownTextIsSelectable("table-cell"),
      prose: iosMarkdownTextIsSelectable("prose"),
    }).toEqual({
      tableCell: false,
      prose: true,
    });
  });
});
