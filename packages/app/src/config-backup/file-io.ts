import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";

import { isWeb } from "@/constants/platform";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";

const BACKUP_FILE_FILTER = [{ name: "Paseo configuration", extensions: ["json"] }];

export interface ImportedTextFile {
  fileName: string;
  content: string;
}

export async function saveConfigBackupFile(input: {
  fileName: string;
  content: string;
}): Promise<boolean> {
  if (isWeb && isElectronRuntime()) {
    const saveText = getDesktopHost()?.dialog?.saveText;
    if (!saveText) throw new Error("Desktop save dialog is unavailable.");
    return (
      (await saveText({
        title: "Export Paseo configuration",
        defaultPath: input.fileName,
        content: input.content,
        filters: BACKUP_FILE_FILTER,
      })) !== null
    );
  }

  if (isWeb) {
    const blob = new Blob([input.content], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = input.fileName;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    return true;
  }

  if (!FileSystem.cacheDirectory) throw new Error("No cache directory is available.");
  const uri = `${FileSystem.cacheDirectory}${input.fileName}`;
  await FileSystem.writeAsStringAsync(uri, input.content);
  await Sharing.shareAsync(uri, {
    mimeType: "application/json",
    dialogTitle: "Export Paseo configuration",
  });
  return true;
}

function openBrowserTextFile(): Promise<ImportedTextFile | null> {
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) {
        resolve(null);
        return;
      }
      file
        .text()
        .then((content) => resolve({ fileName: file.name, content }))
        .catch(reject)
        .finally(() => input.remove());
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    document.body.appendChild(input);
    input.click();
  });
}

export async function openConfigBackupFile(): Promise<ImportedTextFile | null> {
  if (isWeb && isElectronRuntime()) {
    const openText = getDesktopHost()?.dialog?.openText;
    if (!openText) throw new Error("Desktop open dialog is unavailable.");
    return openText({
      title: "Import Paseo configuration",
      filters: BACKUP_FILE_FILTER,
    });
  }

  if (isWeb) return openBrowserTextFile();

  const result = await DocumentPicker.getDocumentAsync({
    type: "application/json",
    multiple: false,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return null;
  const asset = result.assets[0];
  if (!asset) return null;
  return {
    fileName: asset.name,
    content: await new File(asset.uri).text(),
  };
}
