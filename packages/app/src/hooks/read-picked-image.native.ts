import { Buffer } from "buffer";
import * as FileSystem from "expo-file-system/legacy";
import { parseDataUrl } from "@/attachments/utils";
import type { PickedImageSource } from "@/hooks/image-attachment-picker";

/** Reads a picked image as base64. Native pickers return file URIs. */
export async function readPickedImageBase64(source: PickedImageSource): Promise<string> {
  if (source.kind === "data_url") return parseDataUrl(source.dataUrl).base64;
  if (source.kind === "blob") {
    return Buffer.from(await source.blob.arrayBuffer()).toString("base64");
  }
  return await FileSystem.readAsStringAsync(source.uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
}
