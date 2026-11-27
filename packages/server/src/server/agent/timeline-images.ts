import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic-file.js";

export interface TimelineImageReference {
  id: string;
  mimeType: string;
  size: number;
}

export class TimelineImageStore {
  constructor(private readonly paseoHome: string) {}

  async put(
    agentId: string,
    image: { bytes: Uint8Array; mimeType: string },
  ): Promise<TimelineImageReference> {
    const id = createHash("sha256").update(image.bytes).digest("hex");
    await writeFileAtomic(this.path(agentId, id), image.bytes);
    return { id, mimeType: image.mimeType, size: image.bytes.byteLength };
  }

  async read(agentId: string, id: string): Promise<Uint8Array> {
    return readFile(this.path(agentId, id));
  }

  async stream(
    agentId: string,
    id: string,
    consume: (file: {
      size: number;
      modifiedAt: string;
      chunks: AsyncIterable<Buffer>;
    }) => Promise<void>,
  ): Promise<void> {
    const handle = await open(this.path(agentId, id), "r");
    try {
      const stat = await handle.stat();
      await consume({
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        chunks: handle.createReadStream({ autoClose: false, highWaterMark: 256 * 1024 }),
      });
    } finally {
      await handle.close();
    }
  }

  private path(agentId: string, id: string): string {
    if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("Invalid timeline image ID");
    const agentKey = createHash("sha256").update(agentId).digest("hex");
    return join(this.paseoHome, "timeline-images", agentKey, id);
  }
}
