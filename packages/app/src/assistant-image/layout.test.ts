import { describe, expect, it } from "vitest";
import {
  ASSISTANT_IMAGE_GALLERY_MAX_HEIGHT,
  ASSISTANT_IMAGE_GALLERY_MAX_WIDTH,
  constrainAssistantImageSize,
  isAssistantImageGalleryParagraph,
} from "./layout";

describe("assistant image layout", () => {
  it("groups image-only paragraphs containing multiple images", () => {
    expect(
      isAssistantImageGalleryParagraph({
        children: [{ type: "image" }, { type: "softbreak" }, { type: "image" }, { type: "image" }],
      }),
    ).toBe(true);
  });

  it("keeps single images and mixed prose on the normal markdown path", () => {
    expect(isAssistantImageGalleryParagraph({ children: [{ type: "image" }] })).toBe(false);
    expect(
      isAssistantImageGalleryParagraph({
        children: [{ type: "text", content: "Screenshots:" }, { type: "image" }, { type: "image" }],
      }),
    ).toBe(false);
  });

  it.each([
    {
      label: "wide",
      intrinsic: { width: 1200, height: 600 },
      expected: { width: 320, height: 160 },
    },
    {
      label: "tall",
      intrinsic: { width: 390, height: 844 },
      expected: { width: 148, height: 320 },
    },
    {
      label: "small",
      intrinsic: { width: 100, height: 50 },
      expected: { width: 100, height: 50 },
    },
  ])("fits $label images without cropping or upscaling", ({ intrinsic, expected }) => {
    const size = constrainAssistantImageSize({
      intrinsic,
      maxWidth: ASSISTANT_IMAGE_GALLERY_MAX_WIDTH,
      maxHeight: ASSISTANT_IMAGE_GALLERY_MAX_HEIGHT,
    });
    expect(size.width).toBeCloseTo(expected.width, 0);
    expect(size.height).toBeCloseTo(expected.height, 0);
  });
});
