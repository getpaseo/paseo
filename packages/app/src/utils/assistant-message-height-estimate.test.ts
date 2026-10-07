import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
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

    expect(
      estimateAssistantMessageHeightFromCache({
        markdown: "First paragraph\n\nSecond paragraph",
        contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
      }),
    ).toBe(97);
  });

  it("reads block heights measured at the configured content width", () => {
    setAssistantMarkdownBlockHeight({ block: "Wide paragraph", width: 1584, height: 20 });

    expect(
      estimateAssistantMessageHeightFromCache({
        markdown: "Wide paragraph",
        contentMaxWidth: 1600,
      }),
    ).toBe(44);
    expect(
      estimateAssistantMessageHeightFromCache({
        markdown: "Wide paragraph",
        contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
      }),
    ).toBeNull();
  });

  it("falls back to image metadata when markdown blocks are not measured", () => {
    setAssistantImageMetadata(
      {
        source: "https://example.com/landscape.png",
      },
      { width: 1200, height: 800 },
    );

    expect(
      estimateAssistantMessageHeightFromCache({
        markdown: "Here is the screenshot\n\n![Screenshot](https://example.com/landscape.png)",
        contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
      }),
    ).toBeGreaterThan(220);
  });
});
