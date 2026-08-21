import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearAssistantMessageHeightEstimateCache,
  estimateAssistantMessageHeightFromCache,
  setAssistantMarkdownBlockHeight,
} from "./assistant-message-height-estimate";
import {
  clearAssistantImageMetadataCache,
  setAssistantImageMetadata,
} from "./assistant-image-metadata";
import { getContentEstimateWidth, setContentEstimateWidth } from "./content-estimate-width";

describe("assistant message height estimate", () => {
  const defaultEstimateWidth = getContentEstimateWidth();

  beforeEach(() => {
    clearAssistantMessageHeightEstimateCache();
    clearAssistantImageMetadataCache();
  });

  afterEach(() => {
    setContentEstimateWidth(defaultEstimateWidth);
  });

  it("estimates assistant message height from measured markdown block heights", () => {
    setAssistantMarkdownBlockHeight({
      block: "First paragraph",
      width: 804,
      height: 18.2,
    });
    setAssistantMarkdownBlockHeight({
      block: "Second paragraph",
      width: 804,
      height: 41.1,
    });

    expect(estimateAssistantMessageHeightFromCache("First paragraph\n\nSecond paragraph")).toBe(97);
  });

  it("looks blocks up at the configured measure, not the authored default", () => {
    setContentEstimateWidth(1200);
    setAssistantMarkdownBlockHeight({
      block: "First paragraph",
      width: 1184, // 1200 - the assistant block's horizontal padding
      height: 20,
    });

    expect(estimateAssistantMessageHeightFromCache("First paragraph")).toBe(44);
  });

  it("misses a block measured at a different measure instead of reusing its height", () => {
    setAssistantMarkdownBlockHeight({
      block: "First paragraph",
      width: 804,
      height: 20,
    });
    setContentEstimateWidth(1200);

    expect(estimateAssistantMessageHeightFromCache("First paragraph")).toBeNull();
  });

  it("scales the image estimate with the configured measure", () => {
    setAssistantImageMetadata(
      { source: "https://example.com/landscape.png" },
      { width: 1200, height: 800 },
    );
    const markdown = "![Screenshot](https://example.com/landscape.png)";

    const atDefault = estimateAssistantMessageHeightFromCache(markdown);
    setContentEstimateWidth(1400);
    const atWide = estimateAssistantMessageHeightFromCache(markdown);

    expect(atDefault).not.toBeNull();
    expect(atWide).not.toBeNull();
    expect(atWide as number).toBeGreaterThan(atDefault as number);
  });

  it("falls back to image metadata when markdown blocks are not measured", () => {
    setAssistantImageMetadata(
      {
        source: "https://example.com/landscape.png",
      },
      { width: 1200, height: 800 },
    );

    expect(
      estimateAssistantMessageHeightFromCache(
        "Here is the screenshot\n\n![Screenshot](https://example.com/landscape.png)",
      ),
    ).toBeGreaterThan(220);
  });
});
