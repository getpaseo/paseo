import { beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_CONTENT_MAX_WIDTH } from "@/styles/theme";
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

  it("keeps local image metadata scoped to its server and workspace", () => {
    const image = {
      source: "screenshot.png",
      workspaceRoot: "/workspace/one",
      serverId: "server-1",
    };
    setAssistantImageMetadata(image, { width: 1200, height: 800 });

    expect(getAssistantImageMetadata({ ...image, workspaceRoot: "/workspace/two" })).toBeNull();
    expect(getAssistantImageMetadata({ ...image, serverId: "server-2" })).toBeNull();
    expect(getAssistantImageMetadata({ source: image.source })).toBeNull();
    expect(getAssistantImageMetadata(image)).toEqual({
      width: 1200,
      height: 800,
      aspectRatio: 1.5,
    });

    setAssistantImageMetadata(
      { ...image, workspaceRoot: "/workspace/two" },
      { width: 800, height: 1200 },
    );
    expect(getAssistantImageMetadata(image)?.aspectRatio).toBe(1.5);
    expect(
      getAssistantImageMetadata({ ...image, workspaceRoot: "/workspace/two" })?.aspectRatio,
    ).toBe(2 / 3);
  });

  it("reuses direct image metadata without workspace context", () => {
    const source = "https://example.com/shared.png";
    setAssistantImageMetadata(
      { source, workspaceRoot: "/workspace/one", serverId: "server-1" },
      { width: 1200, height: 800 },
    );
    expect(getAssistantImageMetadata({ source })).toEqual({
      width: 1200,
      height: 800,
      aspectRatio: 1.5,
    });
  });

  it("reserves the default image aspect ratio before metadata arrives", () => {
    expect(
      estimateAssistantMessageHeightFromCache({
        markdown: "![Pending](https://example.com/pending.png)",
        contentMaxWidth: 608,
      }),
    ).toBe(464);
  });

  it("estimates assistant message height from cached image metadata", () => {
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

  it("estimates image-only data-image markdown without caching the full payload as text", () => {
    const source = `data:image/png;base64,${"a".repeat(512)}`;
    setAssistantImageMetadata({ source }, { width: 1200, height: 800 });

    const imageOnlyHeight = estimateAssistantMessageHeightFromCache({
      markdown: `![Screenshot](${source})`,
      contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
    });
    const mixedHeight = estimateAssistantMessageHeightFromCache({
      markdown: `Text\n\n![Screenshot](${source})`,
      contentMaxWidth: DEFAULT_CONTENT_MAX_WIDTH,
    });

    expect(imageOnlyHeight).toBeGreaterThan(220);
    expect(mixedHeight).toBeGreaterThan(imageOnlyHeight ?? 0);
  });
});
