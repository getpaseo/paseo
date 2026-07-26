import { describe, expect, it } from "vitest";
import { projectIconEmojiFromDataUri, projectIconToDataUri } from "./project-icon-presentation";

describe("project icon presentation", () => {
  it("round-trips emoji icons through the display data URI", () => {
    const dataUri = projectIconToDataUri({
      data: "fallback",
      mimeType: "image/svg+xml",
      source: "custom",
      emoji: "\u{1F4B2}",
    });

    expect(projectIconEmojiFromDataUri(dataUri)).toBe("\u{1F4B2}");
  });

  it("preserves image icons as base64 data URIs", () => {
    const dataUri = projectIconToDataUri({
      data: "base64",
      mimeType: "image/png",
      source: "custom",
    });

    expect(dataUri).toBe("data:image/png;base64,base64");
    expect(projectIconEmojiFromDataUri(dataUri)).toBeNull();
  });
});
