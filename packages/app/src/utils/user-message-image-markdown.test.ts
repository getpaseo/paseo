import { describe, expect, it } from "vitest";

import { splitUserMessageImageMarkdown } from "./user-message-image-markdown";

describe("splitUserMessageImageMarkdown", () => {
  it("keeps plain user text unchanged", () => {
    expect(splitUserMessageImageMarkdown("look at this")).toEqual({
      visibleText: "look at this",
      imageSources: [],
    });
  });

  it("extracts persistent file-URI images and leaves surrounding text", () => {
    expect(
      splitUserMessageImageMarkdown(
        "see this\n![Image](file:///Users/me/.paseo/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png)\nplease",
      ),
    ).toEqual({
      visibleText: "see this\nplease",
      imageSources: [
        "file:///Users/me/.paseo/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png",
      ],
    });
  });

  it("extracts an image-only message", () => {
    expect(splitUserMessageImageMarkdown("![Image](file:///tmp/shot.png)")).toEqual({
      visibleText: "",
      imageSources: ["file:///tmp/shot.png"],
    });
  });

  it("extracts concatenated replay text without a separating newline", () => {
    expect(splitUserMessageImageMarkdown("hey![Image](file:///tmp/shot.png)")).toEqual({
      visibleText: "hey",
      imageSources: ["file:///tmp/shot.png"],
    });
  });

  it("leaves http images in the visible text", () => {
    expect(splitUserMessageImageMarkdown("![chart](https://example.com/a.png)")).toEqual({
      visibleText: "![chart](https://example.com/a.png)",
      imageSources: [],
    });
  });

  it("extracts a Windows drive file URI", () => {
    const source =
      "file:///C:/Users/me/.paseo/attachments/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png";
    expect(splitUserMessageImageMarkdown(`shot![Image](${source})`)).toEqual({
      visibleText: "shot",
      imageSources: [source],
    });
  });
});
