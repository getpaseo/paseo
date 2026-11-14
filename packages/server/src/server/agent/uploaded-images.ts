import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { UploadedImage } from "@getpaseo/protocol/messages";

export async function readUploadedImages(paseoHome: string, images: readonly UploadedImage[]) {
  return Promise.all(
    images.map(async (image) => {
      if (image.fileName === "." || image.fileName === ".." || /[\\/]/.test(image.fileName)) {
        throw new Error("Invalid uploaded image filename");
      }
      const bytes = await readFile(join(paseoHome, "uploads", image.id, image.fileName));
      if (bytes.byteLength !== image.size) throw new Error("Uploaded image size mismatch");
      return { data: bytes.toString("base64"), mimeType: image.mimeType };
    }),
  );
}
