import { describe, expect, it } from "vitest";
import type { PickedImageSource } from "@/hooks/image-attachment-picker";
import { readPickedImageBase64 } from "@/hooks/read-picked-image";
import { createPickImages } from "./pick-images";

describe("createPickImages", () => {
  it("returns each picked image with its name, type, and base64 bytes", async () => {
    const pickImages = createPickImages({
      pick: async () => [
        {
          source: { kind: "blob", blob: new Blob(["hello"], { type: "image/png" }) },
          mimeType: "image/png",
          fileName: "shot.png",
        },
        {
          source: { kind: "data_url", dataUrl: "data:image/jpeg;base64,aGk=" },
          mimeType: "image/jpeg",
        },
      ],
      readBase64: readPickedImageBase64,
      signal: new AbortController().signal,
    });

    await expect(pickImages()).resolves.toEqual([
      { name: "shot.png", mimeType: "image/png", base64: "aGVsbG8=" },
      { name: null, mimeType: "image/jpeg", base64: "aGk=" },
    ]);
  });

  it("resolves an empty list when the user cancels", async () => {
    const pickImages = createPickImages({
      pick: async () => null,
      readBase64: async () => {
        throw new Error("nothing to read");
      },
      signal: new AbortController().signal,
    });

    await expect(pickImages()).resolves.toEqual([]);
  });

  it("rejects when reading a picked image fails", async () => {
    const pickImages = createPickImages({
      pick: async () => [
        { source: { kind: "file_uri", uri: "file:///gone.png" }, mimeType: "image/png" },
      ],
      readBase64: async (source: PickedImageSource) => {
        throw new Error(`cannot read ${source.kind}`);
      },
      signal: new AbortController().signal,
    });

    await expect(pickImages()).rejects.toThrow("cannot read file_uri");
  });

  it("rejects once the plugin has stopped, without opening the picker", async () => {
    const lifetime = new AbortController();
    lifetime.abort();
    let opened = false;
    const pickImages = createPickImages({
      pick: async () => {
        opened = true;
        return null;
      },
      readBase64: readPickedImageBase64,
      signal: lifetime.signal,
    });

    await expect(pickImages()).rejects.toThrow("Plugin has stopped");
    expect(opened).toBe(false);
  });

  it("rejects when the plugin stops while the picker is open", async () => {
    const lifetime = new AbortController();
    const pickImages = createPickImages({
      pick: async () => {
        lifetime.abort();
        return [
          {
            source: { kind: "data_url", dataUrl: "data:image/png;base64,aGk=" },
            mimeType: "image/png",
          },
        ];
      },
      readBase64: readPickedImageBase64,
      signal: lifetime.signal,
    });

    await expect(pickImages()).rejects.toThrow("Plugin has stopped");
  });
});
