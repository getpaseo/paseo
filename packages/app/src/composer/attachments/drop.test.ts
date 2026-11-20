import { describe, expect, it } from "vitest";
import { droppedItemsToSelectedFiles } from "./drop";

describe("composer dropped attachments", () => {
  it("turns non-image browser files into selected files and leaves raster images for image handling", async () => {
    const jsonFile = new File([JSON.stringify({ ok: true })], "config.json", {
      type: "application/json",
    });
    const imageFile = new File([new Uint8Array([0])], "screen.png", { type: "image/png" });

    const files = droppedItemsToSelectedFiles([
      { kind: "web-file", file: jsonFile },
      { kind: "web-file", file: imageFile },
    ]);

    expect(files.map(({ fileName, mimeType }) => ({ fileName, mimeType }))).toEqual([
      { fileName: "config.json", mimeType: "application/json" },
    ]);
    expect(await files[0]?.readBytes()).toEqual(new Uint8Array(await jsonFile.arrayBuffer()));
  });

  it("reads desktop paths lazily and leaves raster images for image handling", async () => {
    const windowsPath = "C:\\Users\\alice\\config.json";
    const posixPath = "/Users/alice/notes/readme.txt";
    const imagePath = "C:\\Users\\alice\\screen.png";
    const bytesByPath = new Map([
      [windowsPath, new Uint8Array([1, 2, 3])],
      [posixPath, new Uint8Array([4, 5])],
    ]);
    const readPaths: string[] = [];

    const files = droppedItemsToSelectedFiles(
      [
        { kind: "desktop-path", path: windowsPath },
        { kind: "desktop-path", path: imagePath },
        { kind: "desktop-path", path: posixPath },
      ],
      {
        readDesktopFileBytes: async (path) => {
          readPaths.push(path);
          const bytes = bytesByPath.get(path);
          if (!bytes) {
            throw new Error(`Unexpected desktop read: ${path}`);
          }
          return bytes;
        },
      },
    );

    expect(files.map(({ fileName, mimeType }) => ({ fileName, mimeType }))).toEqual([
      { fileName: "config.json", mimeType: "application/octet-stream" },
      { fileName: "readme.txt", mimeType: "application/octet-stream" },
    ]);
    expect(readPaths).toEqual([]);

    expect(await files[0]?.readBytes()).toEqual(new Uint8Array([1, 2, 3]));
    expect(await files[1]?.readBytes()).toEqual(new Uint8Array([4, 5]));
    expect(readPaths).toEqual([windowsPath, posixPath]);
  });
});
