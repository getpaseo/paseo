import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentTimelineImage } from "./agent-sdk-types.js";

const CONVERSATION_IMAGES_DIRNAME = "conversation-images";
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface ConversationImageInput {
  data: string;
  mimeType: string;
}

export interface ConversationImageStore {
  persist(images: readonly ConversationImageInput[]): Promise<AgentTimelineImage[]>;
  garbageCollect(referencedIds: ReadonlySet<string>): Promise<void>;
}

function extensionForMimeType(mimeType: string): string {
  switch (mimeType.toLowerCase()) {
    case "image/jpeg":
    case "image/jpg":
      return "jpg";
    case "image/png":
      return "png";
    case "image/gif":
      return "gif";
    case "image/webp":
      return "webp";
    case "image/avif":
      return "avif";
    case "image/heic":
      return "heic";
    case "image/heif":
      return "heif";
    case "image/tiff":
      return "tiff";
    case "image/bmp":
      return "bmp";
    default:
      return "img";
  }
}

function parseImageData(image: ConversationImageInput): {
  bytes: Buffer;
  mimeType: string;
} {
  const dataUrl = /^data:([^;]+);base64,(.*)$/s.exec(image.data);
  const mimeType = dataUrl?.[1] ?? image.mimeType;
  const data = dataUrl?.[2] ?? image.data;
  return { bytes: Buffer.from(data, "base64"), mimeType };
}

export function createConversationImageStore(paseoHome: string): ConversationImageStore {
  const directory = path.join(paseoHome, CONVERSATION_IMAGES_DIRNAME);

  async function ensureDirectory(): Promise<void> {
    await mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    await chmod(directory, PRIVATE_DIRECTORY_MODE);
  }

  async function moveIntoPlace(temporarySource: string, source: string): Promise<void> {
    try {
      await rename(temporarySource, source);
    } catch (error) {
      try {
        await stat(source);
      } catch {
        await rm(temporarySource, { force: true });
        throw error;
      }
      await rm(temporarySource, { force: true });
    }
  }

  return {
    async persist(images) {
      await ensureDirectory();
      return await Promise.all(
        images.map(async (image) => {
          const { bytes, mimeType } = parseImageData(image);
          const id = createHash("sha256").update(bytes).digest("hex");
          const extension = extensionForMimeType(mimeType);
          const fileName = `${id}.${extension}`;
          const source = path.join(directory, fileName);
          const temporarySource = path.join(directory, `.${fileName}.${randomUUID()}.tmp`);
          await writeFile(temporarySource, bytes, { mode: PRIVATE_FILE_MODE });
          await moveIntoPlace(temporarySource, source);
          await chmod(source, PRIVATE_FILE_MODE);
          return {
            id,
            mimeType,
            source,
            byteSize: bytes.byteLength,
          };
        }),
      );
    },

    async garbageCollect(referencedIds) {
      await ensureDirectory();
      const entries = await readdir(directory, { withFileTypes: true });
      const unreferenced = entries.filter((entry) => {
        if (!entry.isFile()) return false;
        const id = entry.name.split(".")[0];
        return !referencedIds.has(id);
      });
      await Promise.all(unreferenced.map((entry) => rm(path.join(directory, entry.name))));
    },
  };
}
