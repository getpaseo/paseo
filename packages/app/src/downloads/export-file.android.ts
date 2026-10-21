import { Alert } from "react-native";
import { requireNativeModule } from "expo-modules-core";
import { i18n } from "@/i18n/i18next";
import { shareDownloadedFile, type DownloadedFile } from "./share-file";

interface PaseoFileExportModule {
  saveFileAsync(uri: string, fileName: string, mimeType: string): Promise<boolean>;
}

type ExportAction = "save" | "share" | "cancel";

function chooseExportAction(fileName: string): Promise<ExportAction> {
  return new Promise((resolve) => {
    Alert.alert(
      fileName,
      undefined,
      [
        {
          text: i18n.t("common.actions.cancel"),
          style: "cancel",
          onPress: () => resolve("cancel"),
        },
        { text: i18n.t("downloads.shareFile"), onPress: () => resolve("share") },
        { text: i18n.t("downloads.saveToDevice"), onPress: () => resolve("save") },
      ],
      { cancelable: true, onDismiss: () => resolve("cancel") },
    );
  });
}

export async function exportDownloadedFile(file: DownloadedFile): Promise<boolean> {
  const action = await chooseExportAction(file.fileName);
  if (action === "cancel") {
    return false;
  }
  if (action === "share") {
    return shareDownloadedFile(file);
  }
  try {
    const module = requireNativeModule<PaseoFileExportModule>("PaseoFileExport");
    return await module.saveFileAsync(
      file.uri,
      file.fileName,
      file.mimeType ?? "application/octet-stream",
    );
  } catch (cause) {
    throw new Error(i18n.t("downloads.saveFailed"), { cause });
  }
}
