import { describe, expect, it } from "vitest";
import type { DesktopDialogBridge, DesktopDialogOpenOptions } from "@/desktop/host";
import {
  normalizePickedImageAssets,
  openImagePathsWithDesktopDialog,
} from "./image-attachment-picker";

function fakeDialogReturning(selection: string | string[] | null): {
  dialog: DesktopDialogBridge;
  recordedOptions: DesktopDialogOpenOptions[];
} {
  const recordedOptions: DesktopDialogOpenOptions[] = [];
  return {
    dialog: {
      open: async (options?: DesktopDialogOpenOptions) => {
        if (options) {
          recordedOptions.push(options);
        }
        return selection;
      },
    },
    recordedOptions,
  };
}

describe("image-attachment-picker", () => {
  it("normalizes a picked File into a blob source", async () => {
    const file = new File(["hello"], "picked.png", { type: "image/png" });

    const result = await normalizePickedImageAssets([
      {
        uri: "blob:test",
        mimeType: "image/png",
        fileName: null,
        file,
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.source.kind).toBe("blob");
    expect(result[0]?.fileName).toBe("picked.png");
    expect(result[0]?.mimeType).toBe("image/png");
  });

  it("keeps filesystem picker results as file uris", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "file:///tmp/picked.png",
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);

    expect(result).toEqual([
      {
        source: { kind: "file_uri", uri: "file:///tmp/picked.png" },
        mimeType: "image/png",
        fileName: "picked.png",
      },
    ]);
  });

  it("converts data urls into blob sources when no file path exists", async () => {
    const result = await normalizePickedImageAssets([
      {
        uri: "data:image/png;base64,AAEC",
        mimeType: "image/png",
        fileName: "inline.png",
      },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0]?.source.kind).toBe("blob");
    expect(result[0]?.fileName).toBe("inline.png");
    expect(result[0]?.mimeType).toBe("image/png");
  });

  it("uses the desktop dialog api when available", async () => {
    const { dialog, recordedOptions } = fakeDialogReturning(["/tmp/one.png", "/tmp/two.jpg"]);

    const result = await openImagePathsWithDesktopDialog(dialog);

    expect(recordedOptions).toHaveLength(1);
    expect(recordedOptions[0]).toMatchObject({
      multiple: true,
      directory: false,
      title: "Attach images",
    });
    expect(result).toEqual(["/tmp/one.png", "/tmp/two.jpg"]);
  });

  it("throws when desktop dialog API is not available", async () => {
    await expect(openImagePathsWithDesktopDialog(null)).rejects.toThrow(
      "Desktop dialog API is not available.",
    );
    await expect(openImagePathsWithDesktopDialog({})).rejects.toThrow(
      "Desktop dialog API is not available.",
    );
  });
});
