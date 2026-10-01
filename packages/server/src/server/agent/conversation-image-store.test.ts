import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createConversationImageStore } from "./conversation-image-store.js";

describe("conversation image store", () => {
  it("persists content-addressed image bytes under the Paseo home", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-conversation-images-"));
    const store = createConversationImageStore(paseoHome);
    const bytes = Buffer.from("durable image bytes");

    const [image] = await store.persist([
      { data: bytes.toString("base64"), mimeType: "image/png" },
    ]);

    expect(image).toEqual({
      id: "18cc1ca38078764299ccf1eb0aa3c40676a5bb20c8c1c43b1faafefa0f16e52d",
      mimeType: "image/png",
      source: path.join(
        paseoHome,
        "conversation-images",
        "18cc1ca38078764299ccf1eb0aa3c40676a5bb20c8c1c43b1faafefa0f16e52d.png",
      ),
      byteSize: bytes.byteLength,
    });
    await expect(readFile(image.source)).resolves.toEqual(bytes);
    if (process.platform !== "win32") {
      expect((await stat(image.source)).mode & 0o777).toBe(0o600);
    }
  });

  it("deletes only files no persisted message references", async () => {
    const paseoHome = await mkdtemp(path.join(os.tmpdir(), "paseo-conversation-images-gc-"));
    const store = createConversationImageStore(paseoHome);
    const [kept, removed] = await store.persist([
      { data: Buffer.from("kept").toString("base64"), mimeType: "image/jpeg" },
      { data: Buffer.from("removed").toString("base64"), mimeType: "image/png" },
    ]);

    await store.garbageCollect(new Set([kept.id]));

    expect(await readdir(path.join(paseoHome, "conversation-images"))).toEqual([`${kept.id}.jpg`]);
    await expect(readFile(removed.source)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
