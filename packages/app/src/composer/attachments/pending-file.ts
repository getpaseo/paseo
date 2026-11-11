import { getFileTypeLabel } from "@/attachments/file-types";
import type { SelectedFile } from "@/attachments/selected-file";

export interface PendingFileAttachment {
  id: number;
  file: SelectedFile;
  failed: boolean;
}

interface PendingFilePillLabel {
  title: string;
  subtitle: string;
}

/**
 * A failed upload explains the retry and remove actions instead of showing the daemon's error,
 * which only the log keeps.
 */
export function pendingFilePillLabel(
  entry: PendingFileAttachment,
  failedLabel: string,
): PendingFilePillLabel {
  return {
    title: entry.file.fileName,
    subtitle: entry.failed ? failedLabel : (getFileTypeLabel(entry.file.fileName) ?? ""),
  };
}
