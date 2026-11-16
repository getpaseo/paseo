import * as Sharing from "expo-sharing";
import { i18n } from "@/i18n/i18next";

export interface DownloadedFile {
  uri: string;
  fileName: string;
  mimeType: string | null;
}

export async function shareDownloadedFile(file: DownloadedFile): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error(i18n.t("downloads.sharingUnavailable"));
  }
  await Sharing.shareAsync(file.uri, {
    mimeType: file.mimeType ?? undefined,
    dialogTitle: i18n.t("downloads.shareFileNamed", { fileName: file.fileName }),
  });
  return true;
}
