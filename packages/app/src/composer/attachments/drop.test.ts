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
});
