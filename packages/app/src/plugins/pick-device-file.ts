import * as DocumentPicker from "expo-document-picker";
import { File, FileMode } from "expo-file-system";
import type { DeviceFileSelection } from "./pick-device-file.types";

export async function pickDeviceFile(): Promise<DeviceFileSelection | null> {
  const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: false });
  const asset = result.canceled ? undefined : result.assets[0];
  if (!asset) return null;
  const size = asset.size ?? new File(asset.uri).size;
  return {
    name: asset.name,
    size,
    async read() {
      try {
        const handle = new File(asset.uri).open(FileMode.ReadOnly);
        try {
          return handle.readBytes(size + 1);
        } finally {
          handle.close();
        }
      } catch (error) {
        throw new Error("Paseo could not read the selected file. Choose it again.", {
          cause: error,
        });
      }
    },
  };
}
