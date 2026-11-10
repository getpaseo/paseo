import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import type { PickFilesOptions, PickedFile } from "@getpaseo/plugin/client/react-native";
import { toPickedFile } from "./picked-file";

/**
 * Each read opens its own handle so nothing stays open between a plugin's chunks. The picker's
 * cache copy outlives the pick: the OS clears the cache directory when it needs the space, and
 * the host never deletes it, since it cannot tell when the plugin is done. Once the copy is gone,
 * `open()` throws and the read rejects.
 */
async function readCachedFileRange(
  uri: string,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const handle = new File(uri).open();
  try {
    handle.offset = offset;
    return handle.readBytes(length);
  } finally {
    handle.close();
  }
}

/** The document picker, for any file type; the plugin reads the cache copy a range at a time. */
export async function pickFiles(options: PickFilesOptions = {}): Promise<PickedFile[]> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: options.multiple === true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return [];
  return result.assets.map((asset) =>
    toPickedFile({
      fileName: asset.name,
      mimeType: asset.mimeType,
      byteLength: asset.size ?? new File(asset.uri).size,
      readBytes: (offset, length) => readCachedFileRange(asset.uri, offset, length),
    }),
  );
}
