import { describe, expect, it, vi, beforeEach } from "vitest";

const desktopHostState = vi.hoisted(() => ({
  api: null as any,
}));

vi.mock("@/desktop/host", () => ({
  getDesktopHost: () => desktopHostState.api,
}));

import {
  normalizePickedImageAssets,
  openImagePathsWithDesktopDialog,
} from "./image-attachment-picker";

describe("image-attachment-picker", () => {
  beforeEach(() => {
    desktopHostState.api = null;
  });

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
    const open = vi.fn().mockResolvedValue(["/tmp/one.png", "/tmp/two.jpg"]);
    desktopHostState.api = {
      dialog: { open },
    };

    const result = await openImagePathsWithDesktopDialog();

    expect(open).toHaveBeenCalledWith(
      expect.objectContaining({
        multiple: true,
        directory: false,
        title: "Attach images",
      }),
    );
    expect(result).toEqual(["/tmp/one.png", "/tmp/two.jpg"]);
  });

  it("throws when desktop dialog API is not available", async () => {
    desktopHostState.api = {};

    await expect(openImagePathsWithDesktopDialog()).rejects.toThrow(
      "Desktop dialog API is not available.",
    );
  });
});
