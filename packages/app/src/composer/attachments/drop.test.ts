import { describe, expect, it } from "vitest";
import { droppedItemsToPickedFiles } from "./drop";

describe("composer dropped attachments", () => {
  it("turns non-image browser files into picked files and leaves raster images for image handling", async () => {
    const jsonFile = new File([JSON.stringify({ ok: true })], "config.json", {
      type: "application/json",
    });
    const imageFile = new File([new Uint8Array([0])], "screen.png", { type: "image/png" });

    const files = await droppedItemsToPickedFiles([
      { kind: "web-file", file: jsonFile },
      { kind: "web-file", file: imageFile },
    ]);

    expect(files).toEqual([
      {
        fileName: "config.json",
        mimeType: "application/json",
        bytes: new Uint8Array(await jsonFile.arrayBuffer()),
      },
    ]);
  });

  it("turns non-image desktop paths into picked files and leaves raster images for image handling", async () => {
    const windowsPath = "C:\\Users\\alice\\config.json";
    const posixPath = "/Users/alice/notes/readme.txt";
    const imagePath = "C:\\Users\\alice\\screen.png";
    const bytesByPath = new Map([
      [windowsPath, new Uint8Array([1, 2, 3])],
      [posixPath, new Uint8Array([4, 5])],
    ]);
    const readPaths: string[] = [];

    const files = await droppedItemsToPickedFiles(
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

    expect(readPaths).toEqual([windowsPath, posixPath]);
    expect(files).toEqual([
      {
        fileName: "config.json",
        mimeType: "application/octet-stream",
        bytes: new Uint8Array([1, 2, 3]),
      },
      {
        fileName: "readme.txt",
        mimeType: "application/octet-stream",
        bytes: new Uint8Array([4, 5]),
      },
    ]);
  });
});
