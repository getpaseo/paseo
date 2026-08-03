import { describe, expect, it } from "vitest";
import {
  type AssistantImageRenderedDimensionsReader,
  resolveAssistantImageLoadDimensions,
} from "./load-dimensions";

class MemoryRenderedDimensionsReader implements AssistantImageRenderedDimensionsReader {
  constructor(private readonly dimensions: { width: number; height: number } | null) {}

  read(): { width: number; height: number } | null {
    return this.dimensions;
  }
}

describe("assistant image load dimensions", () => {
  it("prefers native source dimensions", () => {
    const dimensions = resolveAssistantImageLoadDimensions({
      source: { width: 640, height: 320 },
      target: { naturalWidth: 800, naturalHeight: 400 },
      renderedImage: null,
      renderedDimensions: new MemoryRenderedDimensionsReader({ width: 900, height: 600 }),
    });

    expect(dimensions).toEqual({ width: 640, height: 320 });
  });

  it("uses browser event dimensions when native dimensions are absent", () => {
    const dimensions = resolveAssistantImageLoadDimensions({
      source: { width: 0, height: 0 },
      target: { naturalWidth: 800, naturalHeight: 400 },
      renderedImage: null,
      renderedDimensions: new MemoryRenderedDimensionsReader({ width: 900, height: 600 }),
    });

    expect(dimensions).toEqual({ width: 800, height: 400 });
  });

  it("falls back to the rendered image adapter", () => {
    const renderedImage = { id: "rendered-image" };
    const dimensions = resolveAssistantImageLoadDimensions({
      target: null,
      renderedImage,
      renderedDimensions: new MemoryRenderedDimensionsReader({ width: 900, height: 600 }),
    });

    expect(dimensions).toEqual({ width: 900, height: 600 });
  });
});
