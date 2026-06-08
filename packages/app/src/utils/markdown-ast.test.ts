import { describe, expect, it } from "vitest";
import { markdownNodeContainsType } from "./markdown-ast";

describe("markdownNodeContainsType", () => {
  it("matches the node itself", () => {
    expect(markdownNodeContainsType({ type: "image", children: [] }, "image")).toBe(true);
  });

  it("matches descendants", () => {
    const paragraph = {
      type: "paragraph",
      children: [
        { type: "text", children: [] },
        {
          type: "link",
          children: [{ type: "image", children: [] }],
        },
      ],
    };

    expect(markdownNodeContainsType(paragraph, "image")).toBe(true);
  });

  it("returns false when the type is absent", () => {
    const paragraph = {
      type: "paragraph",
      children: [
        { type: "text", children: [] },
        { type: "strong", children: [{ type: "text", children: [] }] },
      ],
    };

    expect(markdownNodeContainsType(paragraph, "image")).toBe(false);
  });
});
