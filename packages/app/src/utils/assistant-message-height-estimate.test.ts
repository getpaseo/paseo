import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAssistantMessageHeightEstimateCache,
  estimateAssistantMessageHeightFromCache,
  setAssistantMarkdownBlockHeight,
} from "./assistant-message-height-estimate";
import {
  clearAssistantImageMetadataCache,
  setAssistantImageMetadata,
} from "./assistant-image-metadata";

describe("assistant message height estimate", () => {
  beforeEach(() => {
    clearAssistantMessageHeightEstimateCache();
    clearAssistantImageMetadataCache();
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
