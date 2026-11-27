import { Buffer } from "buffer";
import { readDesktopFileBytes } from "@/attachments/selected-file";
import { parseDataUrl } from "@/attachments/utils";
import type { PickedImageSource } from "@/hooks/image-attachment-picker";

/** Reads a picked image as base64. A web `file_uri` only comes from the Electron file dialog. */
export async function readPickedImageBase64(source: PickedImageSource): Promise<string> {
  if (source.kind === "data_url") return parseDataUrl(source.dataUrl).base64;
  if (source.kind === "blob") {
    return Buffer.from(await source.blob.arrayBuffer()).toString("base64");
  }
  return Buffer.from(await readDesktopFileBytes(source.uri)).toString("base64");
}
