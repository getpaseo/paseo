import { describe, expect, it } from "vitest";
import type { MarkdownDisplayPart } from "./html-ish";
import { groupMarkdownParts } from "./part-groups";

describe("groupMarkdownParts", () => {
  const flowImage: MarkdownDisplayPart = {
    kind: "inlineImage",
    alt: "Priority",
    src: "https://example.com/priority.svg",
    flowsWithText: true,
  };

  it("flows an image with the lead paragraph and keeps later paragraphs full width", () => {
    expect(
      groupMarkdownParts([
        flowImage,
        { kind: "markdown", text: " **Title line**\n\nSecond paragraph." },
      ]),
    ).toEqual([
      {
        kind: "imageText",
        images: [flowImage],
        lead: "**Title line**",
        rest: "Second paragraph.",
      },
    ]);
  });

  it("flows an image with a single-paragraph text", () => {
    expect(groupMarkdownParts([flowImage, { kind: "markdown", text: " Only line" }])).toEqual([
      { kind: "imageText", images: [flowImage], lead: "Only line", rest: "" },
    ]);
  });

  it("groups two consecutive flowing images with the lead paragraph", () => {
    const secondImage: MarkdownDisplayPart = {
      kind: "inlineImage",
      alt: "Severity",
      src: "https://example.com/severity.svg",
      flowsWithText: true,
    };

    expect(
      groupMarkdownParts([
        flowImage,
        { kind: "markdown", text: " " },
        secondImage,
        { kind: "markdown", text: " **Title text here**\n\nBody paragraph." },
      ]),
    ).toEqual([
      {
        kind: "imageText",
        images: [flowImage, secondImage],
        lead: "**Title text here**",
        rest: "Body paragraph.",
      },
    ]);
  });

  it("keeps standalone images as plain parts", () => {
    const image: MarkdownDisplayPart = {
      kind: "inlineImage",
      alt: "Shot",
      src: "https://example.com/shot.png",
    };

    expect(groupMarkdownParts([image, { kind: "markdown", text: "\n\nCaption" }])).toEqual([
      { kind: "part", part: image },
      { kind: "part", part: { kind: "markdown", text: "\n\nCaption" } },
    ]);
  });

  it("keeps a flowing image alone when no markdown follows", () => {
    expect(groupMarkdownParts([flowImage])).toEqual([{ kind: "part", part: flowImage }]);
  });

  it("keeps a flowing image alone when the following markdown starts with a blank line", () => {
    expect(groupMarkdownParts([flowImage, { kind: "markdown", text: "\n\nBelow" }])).toEqual([
      { kind: "part", part: flowImage },
      { kind: "part", part: { kind: "markdown", text: "\n\nBelow" } },
    ]);
  });

  it("passes other part kinds through unchanged", () => {
    const details: MarkdownDisplayPart = { kind: "details", summary: "More", body: "Body" };

    expect(groupMarkdownParts([{ kind: "markdown", text: "Intro" }, details])).toEqual([
      { kind: "part", part: { kind: "markdown", text: "Intro" } },
      { kind: "part", part: details },
    ]);
  });
});
