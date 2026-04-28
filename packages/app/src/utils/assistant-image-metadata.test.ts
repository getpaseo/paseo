import { beforeEach, describe, expect, it } from "vitest";
import {
  clearAssistantImageMetadataCache,
  estimateAssistantMessageHeightFromCache,
  extractAssistantImageSources,
  getAssistantImageMetadata,
  setAssistantImageMetadata,
} from "./assistant-image-metadata";

describe("assistant image metadata", () => {
  beforeEach(() => {
    clearAssistantImageMetadataCache();
  });

  it("extracts markdown image sources", () => {
    expect(
      extractAssistantImageSources(
        'Before\n\n![local](/tmp/paseo.png)\n\n![remote](https://example.com/test.png "Remote")',
      ),
    ).toEqual(["/tmp/paseo.png", "https://example.com/test.png"]);
  });

  it("reuses cached metadata across canonical and raw source keys", () => {
    setAssistantImageMetadata(
      {
        source: "/tmp/paseo-codex-screenshot.png",
        workspaceRoot: "/Users/moboudra/dev/paseo",
        serverId: "server-1",
      },
      { width: 1200, height: 800 },
    );

    expect(
      getAssistantImageMetadata({
        source: "/tmp/paseo-codex-screenshot.png",
      }),
    ).toEqual({
      width: 1200,
      height: 800,
      aspectRatio: 1.5,
    });
  });

  it("estimates assistant message height from cached image metadata", () => {
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

  it("estimates image-only data-image markdown without caching the full payload as text", () => {
    const source = `data:image/png;base64,${"a".repeat(512)}`;
    setAssistantImageMetadata({ source }, { width: 1200, height: 800 });

    const imageOnlyHeight = estimateAssistantMessageHeightFromCache(`![Screenshot](${source})`);
    const mixedHeight = estimateAssistantMessageHeightFromCache(`Text\n\n![Screenshot](${source})`);

    expect(imageOnlyHeight).toBeGreaterThan(220);
    expect(mixedHeight).toBeGreaterThan(imageOnlyHeight ?? 0);
  });
});
