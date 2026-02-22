import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  collectImageFilesFromClipboardData,
  filesToImageAttachments,
} from "./image-attachments-from-files";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentStore } from "@/attachments/types";

function createClipboardItem(params: {
  kind: string;
  type: string;
  file?: File | null;
}) {
  return {
    kind: params.kind,
    type: params.type,
    getAsFile: () => params.file ?? null,
  };
}

function createTestStore(): AttachmentStore {
  let sequence = 0;
  return {
    storageType: "web-indexeddb",
    async save(input) {
      sequence += 1;
      const id = input.id ?? `att-${sequence}`;
      const mimeType = input.mimeType ?? "image/jpeg";
      const fileName = input.fileName ?? null;
      let byteSize = 0;
      if (input.source.kind === "blob") {
        byteSize = input.source.blob.size;
      } else if (input.source.kind === "data_url") {
        byteSize = input.source.dataUrl.length;
      } else {
        byteSize = input.source.uri.length;
      }
      return {
        id,
        mimeType,
        storageType: "web-indexeddb",
        storageKey: id,
        fileName,
        byteSize,
        createdAt: 1700000000000 + sequence,
      };
    },
    async encodeBase64() {
      throw new Error("not used in this test");
    },
    async resolvePreviewUrl() {
      throw new Error("not used in this test");
    },
    async delete() {},
    async garbageCollect() {},
  };
}

beforeEach(() => {
  __setAttachmentStoreForTests(createTestStore());
});

afterEach(() => {
  __setAttachmentStoreForTests(null);
});

describe("collectImageFilesFromClipboardData", () => {
  it("returns only image files from clipboard items", () => {
    const imagePng = new File([new Uint8Array([0, 1, 2, 3])], "paste.png", {
      type: "image/png",
    });
    const textFile = new File(["not image"], "notes.txt", {
      type: "text/plain",
    });

    const files = collectImageFilesFromClipboardData({
      items: [
        createClipboardItem({ kind: "string", type: "text/plain" }),
        createClipboardItem({
          kind: "file",
          type: "text/plain",
          file: textFile,
        }),
        createClipboardItem({
          kind: "file",
          type: "image/png",
          file: imagePng,
        }),
        createClipboardItem({
          kind: "file",
          type: "image/jpeg",
          file: null,
        }),
      ],
    });

    expect(files).toEqual([imagePng]);
  });

  it("returns an empty array when clipboard data is missing", () => {
    expect(collectImageFilesFromClipboardData(undefined)).toEqual([]);
  });
});

describe("filesToImageAttachments", () => {
  it("persists files as attachment metadata in order", async () => {
    const pngFile = new File([new Uint8Array([0, 1, 2, 3])], "first.png", {
      type: "image/png",
    });
    const typeLessFile = new File([new Uint8Array([4, 5, 6, 7])], "second", {
      type: "",
    });

    const attachments = await filesToImageAttachments([pngFile, typeLessFile]);

    expect(attachments).toEqual([
      {
        id: "att-1",
        mimeType: "image/png",
        storageType: "web-indexeddb",
        storageKey: "att-1",
        fileName: "first.png",
        byteSize: 4,
        createdAt: 1700000000001,
      },
      {
        id: "att-2",
        mimeType: "image/jpeg",
        storageType: "web-indexeddb",
        storageKey: "att-2",
        fileName: "second",
        byteSize: 4,
        createdAt: 1700000000002,
      },
    ]);
  });

  it("handles large files without creating data URLs", async () => {
    const large = new File([new Uint8Array(4 * 1024 * 1024)], "large.png", {
      type: "image/png",
    });

    const [attachment] = await filesToImageAttachments([large]);

    expect(attachment?.storageType).toBe("web-indexeddb");
    expect(attachment?.byteSize).toBe(4 * 1024 * 1024);
  });
});
