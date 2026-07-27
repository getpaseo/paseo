import { useCallback } from "react";
import { useFileDownload } from "@/hooks/use-file-download";
import type { PdfPreviewDocument } from "@/pdf/pdf-preview-props";

interface UsePdfDownloadParams {
  serverId: string;
  workspaceRoot: string;
  readTarget: { cwd: string; path: string } | null;
  pdfDocument: PdfPreviewDocument | null;
}

/**
 * The download offered when a PDF cannot be previewed — the escape hatch on
 * Android, where the share sheet that follows the download is the only way to
 * reach a PDF app.
 *
 * Returns undefined when there is nothing to download: no PDF open, or a file
 * outside the workspace root, which is the only scope the daemon will issue a
 * download token for.
 */
export function usePdfDownload({
  serverId,
  workspaceRoot,
  readTarget,
  pdfDocument,
}: UsePdfDownloadParams): (() => void) | undefined {
  const downloadFile = useFileDownload({ serverId, workspaceRoot });
  const downloadPath = readTarget?.cwd === workspaceRoot ? readTarget.path : null;
  const fileName = pdfDocument?.fileName;

  const download = useCallback(() => {
    if (!downloadPath || !fileName) return;
    downloadFile({ fileName, path: downloadPath });
  }, [downloadFile, downloadPath, fileName]);

  return downloadPath && fileName ? download : undefined;
}
