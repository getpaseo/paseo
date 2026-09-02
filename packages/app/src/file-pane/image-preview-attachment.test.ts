import type { FileReadResult } from "@getpaseo/client/internal/daemon-client";
import type { AttachmentMetadata } from "@/attachments/types";
import { describe, expect, it } from "vitest";
import {
  prepareImagePreviewAttachment,
  type ImagePreviewAttachmentPort,
} from "./image-preview-attachment";

function imageFile(revision: string): FileReadResult {
  return {
    bytes: new Uint8Array([137, 80, 78, 71]),
    mime: "image/png",
    size: 4,
    path: "/workspace/image.png",
    kind: "image",
    modifiedAt: "2026-08-03T00:00:00.000Z",
    revision,
  };
}

function attachment(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "native-file",
    storageKey: `file:///cache/${id}.png`,
    fileName: "image.png",
    byteSize: 4,
    createdAt: 0,
  };
}

describe("image preview attachment", () => {
  it("uses the file revision in the preview attachment identity", async () => {
    const ids: string[] = [];
    const port: ImagePreviewAttachmentPort = {
      async persist(input) {
        ids.push(input.id);
        return attachment(input.id);
      },
    };

    await prepareImagePreviewAttachment(imageFile("revision-1"), port);
    await prepareImagePreviewAttachment(imageFile("revision-2"), port);

    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("reports a preparation failure and permits the same image to retry", async () => {
    let fails = true;
    const port: ImagePreviewAttachmentPort = {
      async persist(input) {
        if (fails) {
          fails = false;
          throw new Error("cache unavailable");
        }
        return attachment(input.id);
      },
    };
    const file = imageFile("revision-1");

    await expect(prepareImagePreviewAttachment(file, port)).resolves.toEqual({
      status: "error",
      attachment: null,
    });
    await expect(prepareImagePreviewAttachment(file, port)).resolves.toMatchObject({
      status: "ready",
      attachment: { id: expect.stringMatching(/^preview_/) },
    });
  });
});
