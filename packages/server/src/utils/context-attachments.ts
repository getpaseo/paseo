import { mkdir, writeFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { createHash } from "node:crypto";

const CONTEXT_ATTACHMENTS_DIR = ".context/attachments";

const MIME_TO_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/heic": ".heic",
  "image/heif": ".heif",
  "image/avif": ".avif",
  "image/tiff": ".tiff",
  "image/bmp": ".bmp",
  "application/pdf": ".pdf",
};

function resolveExtension(mimeType: string, fileName?: string): string {
  if (fileName) {
    const ext = extname(fileName);
    if (ext) {
      return ext;
    }
  }
  return MIME_TO_EXT[mimeType] ?? ".bin";
}

function buildFileName(data: string, mimeType: string, fileName?: string): string {
  const ext = resolveExtension(mimeType, fileName);
  if (fileName) {
    const base = fileName.replace(/\.[^.]+$/, "");
    return `${base}${ext}`;
  }
  const hash = createHash("sha256").update(data).digest("hex").slice(0, 12);
  return `attachment-${hash}${ext}`;
}

export interface PersistedAttachment {
  relativePath: string;
  absolutePath: string;
  mimeType: string;
  fileName: string;
}

/**
 * Persist base64-encoded image/PDF attachments to .context/attachments/ in the
 * workspace cwd. Returns metadata about each saved file so the caller can
 * include file paths in the agent prompt.
 */
export async function persistAttachments(
  cwd: string,
  images: Array<{ data: string; mimeType: string; fileName?: string }>,
): Promise<PersistedAttachment[]> {
  if (images.length === 0) {
    return [];
  }

  const dir = join(cwd, CONTEXT_ATTACHMENTS_DIR);
  await mkdir(dir, { recursive: true });

  const results: PersistedAttachment[] = [];

  for (let i = 0; i < images.length; i++) {
    const image = images[i]!;
    const fileName = buildFileName(image.data, image.mimeType, image.fileName);
    const absolutePath = join(dir, fileName);
    const relativePath = join(CONTEXT_ATTACHMENTS_DIR, fileName);

    const buffer = Buffer.from(image.data, "base64");
    await writeFile(absolutePath, buffer);

    results.push({
      relativePath,
      absolutePath,
      mimeType: image.mimeType,
      fileName,
    });
  }

  return results;
}
