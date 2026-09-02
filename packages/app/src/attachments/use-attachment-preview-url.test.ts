import { describe, expect, it } from "vitest";
import type { AttachmentMetadata } from "./types";
import { resolveAttachmentPreviewUrlState } from "./use-attachment-preview-url";

const attachment: AttachmentMetadata = {
  id: "preview-image",
  mimeType: "image/png",
  storageType: "native-file",
  storageKey: "file:///cache/preview-image.png",
  fileName: "preview-image.png",
  byteSize: 4,
  createdAt: 0,
};

describe("attachment preview URL", () => {
  it("reports a failed URI resolution as an actionable error state", async () => {
    await expect(
      resolveAttachmentPreviewUrlState({
        attachment,
        resolve: async () => {
          throw new Error("cache file missing");
        },
      }),
    ).resolves.toEqual({ status: "error", url: null });
  });
});
