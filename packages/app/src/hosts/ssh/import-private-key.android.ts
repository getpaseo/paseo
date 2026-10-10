import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import type { ImportedPrivateKey } from "./ssh-key-import-model";

/** Read one bounded private-key file and erase the picker's temporary cache copy immediately. */
export async function importPrivateKey(): Promise<ImportedPrivateKey | null> {
  const result = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  const file = new File(asset.uri);
  try {
    if (file.size > 65536) throw new Error("Choose a private key smaller than 64 KiB.");
    const text = await file.text();
    if (!text.includes("PRIVATE KEY")) throw new Error("Choose a private key, not a public key.");
    return { name: asset.name, text };
  } finally {
    file.delete();
  }
}
