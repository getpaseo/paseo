import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { TimelineImageStore } from "./timeline-images.js";

test("persists image bytes per agent across store instances", async () => {
  const home = await mkdtemp(join(tmpdir(), "paseo-timeline-images-"));
  try {
    const bytes = Buffer.alloc(512 * 1024, 0xa5);
    const saved = await new TimelineImageStore(home).put("agent-a", {
      bytes,
      mimeType: "image/png",
    });
    expect(saved).toMatchObject({ mimeType: "image/png", size: bytes.length });
    const restored = new TimelineImageStore(home);
    expect(await restored.read("agent-a", saved.id)).toEqual(bytes);
    const chunks: Buffer[] = [];
    await restored.stream("agent-a", saved.id, async (file) => {
      expect(file.size).toBe(bytes.length);
      for await (const chunk of file.chunks) chunks.push(chunk);
    });
    expect(chunks.length).toBe(2);
    expect(Buffer.concat(chunks)).toEqual(bytes);
    await expect(restored.read("agent-b", saved.id)).rejects.toThrow();
    await expect(restored.read("agent-a", "../outside")).rejects.toThrow();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
