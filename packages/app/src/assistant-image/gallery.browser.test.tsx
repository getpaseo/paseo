import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssistantImageGallery } from "./gallery";
import {
  ASSISTANT_IMAGE_GALLERY_MAX_HEIGHT,
  ASSISTANT_IMAGE_GALLERY_MAX_WIDTH,
  constrainAssistantImageSize,
} from "./layout";

interface MountedGallery {
  root: Root;
  container: HTMLDivElement;
}

const mountedGalleries: MountedGallery[] = [];
const paragraphStyle = { width: "100%", flexDirection: "row" } as const;
const previewSizes = [
  constrainAssistantImageSize({
    intrinsic: { width: 1200, height: 600 },
    maxWidth: ASSISTANT_IMAGE_GALLERY_MAX_WIDTH,
    maxHeight: ASSISTANT_IMAGE_GALLERY_MAX_HEIGHT,
  }),
  constrainAssistantImageSize({
    intrinsic: { width: 390, height: 844 },
    maxWidth: ASSISTANT_IMAGE_GALLERY_MAX_WIDTH,
    maxHeight: ASSISTANT_IMAGE_GALLERY_MAX_HEIGHT,
  }),
  constrainAssistantImageSize({
    intrinsic: { width: 100, height: 50 },
    maxWidth: ASSISTANT_IMAGE_GALLERY_MAX_WIDTH,
    maxHeight: ASSISTANT_IMAGE_GALLERY_MAX_HEIGHT,
  }),
] as const;

function mountGallery(): HTMLDivElement {
  const container = document.createElement("div");
  container.style.width = "360px";
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <AssistantImageGallery paragraphStyle={paragraphStyle}>
        <View testID="gallery-image-1" style={previewSizes[0]} />
        <View testID="gallery-image-2" style={previewSizes[1]} />
        <View testID="gallery-image-3" style={previewSizes[2]} />
      </AssistantImageGallery>,
    );
  });
  mountedGalleries.push({ root, container });
  return container;
}

beforeEach(() => vi.stubGlobal("React", React));

afterEach(() => {
  for (const mounted of mountedGalleries.splice(0)) {
    act(() => mounted.root.unmount());
    mounted.container.remove();
  }
  vi.unstubAllGlobals();
});

describe("assistant image gallery", () => {
  it("top-aligns mixed aspect ratios at intrinsic constrained sizes in one scrollable row", () => {
    const container = mountGallery();
    const gallery = container.querySelector('[data-testid="assistant-image-gallery"]');

    expect(gallery).toBeInstanceOf(HTMLElement);
    if (!(gallery instanceof HTMLElement)) {
      throw new Error("Assistant image gallery did not render");
    }
    const images = container.querySelectorAll<HTMLElement>('[data-testid^="gallery-image-"]');
    const imageRects = Array.from(images, (image) => image.getBoundingClientRect());
    expect(images).toHaveLength(3);
    expect(imageRects[0]?.width).toBe(320);
    expect(imageRects[0]?.height).toBe(160);
    expect(imageRects[1]?.width).toBeCloseTo(148, 0);
    expect(imageRects[1]?.height).toBe(320);
    expect(imageRects[2]?.width).toBe(100);
    expect(imageRects[2]?.height).toBe(50);
    expect(imageRects.map((rect) => rect.top)).toEqual([
      imageRects[0]?.top,
      imageRects[0]?.top,
      imageRects[0]?.top,
    ]);
    expect(gallery.scrollWidth).toBeGreaterThan(gallery.clientWidth);

    gallery.scrollLeft = 120;
    expect(gallery.scrollLeft).toBe(120);
  });
});
