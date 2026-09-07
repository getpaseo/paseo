import { describe, expect, it } from "vitest";
import { createAssistantMarkdownParser } from "@/utils/assistant-markdown-parser";
import { assistantVideoMarkdown } from "./markdown";

describe("assistant video markdown", () => {
  it.each([
    ["[Recording](/tmp/clip.mp4)", "/tmp/clip.mp4", "Recording"],
    ["![Recording](recordings/clip.WEBM)", "recordings/clip.WEBM", "Recording"],
    ["[Movie](file:///tmp/clip.mov)", "file:///tmp/clip.mov", "Movie"],
    [
      "https://example.com/clip.mp4?token=123",
      "https://example.com/clip.mp4?token=123",
      "https://example.com/clip.mp4?token=123",
    ],
  ])("renders %s as a video block outside native text groups", (markdown, source, _label) => {
    const parser = createAssistantMarkdownParser().use(assistantVideoMarkdown);
    const children = parser.parse(markdown, {}).find((token) => token.type === "inline")?.children;
    expect(
      children
        ?.filter((token) => token.type === "video")
        .map((token) => ({
          type: token.type,
          block: token.block,
          source: token.attrGet("src"),
          content: token.content,
        })),
    ).toEqual([{ type: "video", block: true, source, content: "" }]);
  });

  it("preserves surrounding prose and normal links, images, and code", () => {
    const parser = createAssistantMarkdownParser().use(assistantVideoMarkdown);
    const tokens = parser.parse(
      "Before [clip](clip.webm) after [source](code.ts) ![photo](image.png) `clip.mp4`",
      {},
    );
    const children = tokens.find((token) => token.type === "inline")?.children;
    expect(children?.map((token) => token.type)).toEqual([
      "text",
      "link_open",
      "text",
      "link_close",
      "text",
      "link_open",
      "text",
      "link_close",
      "text",
      "image",
      "text",
      "code_inline",
      "video",
    ]);
    expect(children?.[0].content).toBe("Before ");
    expect(children?.[4].content).toBe(" after ");
    expect(parser.parse("```text\n[clip](clip.mp4)\n```", {})[0].type).toBe("fence");
  });

  it("places one player after formatted links to the same video", () => {
    const parser = createAssistantMarkdownParser().use(assistantVideoMarkdown);
    const tokens = parser.parse("**[Recording](clip.mp4)** and [again](clip.mp4)", {});
    const children = tokens.find((token) => token.type === "inline")?.children ?? [];
    expect(children.filter((token) => token.type === "video")).toHaveLength(1);
    expect(children.at(-1)?.type).toBe("video");
    expect(
      children.filter((token) => token.type === "link_open").map((token) => token.attrGet("href")),
    ).toEqual(["clip.mp4", "clip.mp4"]);
  });
});
