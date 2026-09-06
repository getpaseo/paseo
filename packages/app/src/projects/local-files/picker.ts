import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import type { LocalFileSelection } from "./picker-types";

// Sensitive imports must not use the attachment picker, which makes durable copies.
export async function pickLocalFiles(): Promise<LocalFileSelection[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: false,
  });
  if (result.canceled) return null;
  return result.assets.map((asset) => {
    const file = new File(asset.uri);
    const size = asset.size ?? file.size;
    const modified = file.modificationTime;
    return {
      path: asset.name,
      size,
      status: "ready",
      read: async () => {
        if (file.size !== size || file.modificationTime !== modified) throw new Error("changed");
        const bytes = await file.bytes();
        if (file.size !== size || file.modificationTime !== modified) throw new Error("changed");
        return bytes;
      },
    };
  });
}
