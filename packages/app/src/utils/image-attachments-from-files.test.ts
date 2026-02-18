import { describe, expect, it } from "vitest";
import {
  collectImageFilesFromClipboardData,
  filesToImageAttachments,
} from "./image-attachments-from-files";

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
  it("converts files into data URI image attachments and keeps order", async () => {
    const pngFile = new File([new Uint8Array([0, 1, 2, 3])], "first.png", {
      type: "image/png",
    });
    const typeLessFile = new File([new Uint8Array([4, 5, 6, 7])], "second", {
      type: "",
    });

    const attachments = await filesToImageAttachments([pngFile, typeLessFile]);

    expect(attachments).toEqual([
      {
        uri: "data:image/png;base64,AAECAw==",
        mimeType: "image/png",
      },
      {
        uri: "data:image/jpeg;base64,BAUGBw==",
        mimeType: "image/jpeg",
      },
    ]);
  });
});
