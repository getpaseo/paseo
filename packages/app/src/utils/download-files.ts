import { File as FSFile, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { openExternalUrl } from "@/utils/open-external-url";
import { isWeb } from "@/constants/platform";
import { i18n } from "@/i18n/i18next";

// Revoking a blob URL in the same tick as the anchor click can cancel the download.
const OBJECT_URL_REVOKE_DELAY_MS = 30_000;

export function triggerBrowserDownload(url: string, fileName: string): void {
  if (typeof document === "undefined") {
    if (typeof window !== "undefined") {
      void openExternalUrl(url);
    }
    return;
  }

  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  link.rel = "noopener";
  document.body.appendChild(link);
  link.click();
  link.remove();
}

export interface DownloadedFile {
  bytes: Uint8Array;
  mimeType: string;
  fileName: string;
}

export interface SaveDownloadedFileHooks {
  onSaved: () => void;
}

/**
 * Persists downloaded bytes, calls `onSaved` once the file is saved, and only
 * then runs follow-up UI such as the native share sheet.
 */
export type SaveDownloadedFile = (
  file: DownloadedFile,
  hooks: SaveDownloadedFileHooks,
) => Promise<void>;

export async function saveDownloadedFile(
  file: DownloadedFile,
  hooks: SaveDownloadedFileHooks,
): Promise<void> {
  if (isWeb) {
    saveBytesInBrowser(file);
    hooks.onSaved();
    return;
  }
  const uri = saveBytesOnDevice(file);
  hooks.onSaved();
  await shareDownloadedFile({ uri, mimeType: file.mimeType, fileName: file.fileName });
}

/** Web only: hands in-memory bytes to the browser's download manager. */
function saveBytesInBrowser({ bytes, mimeType, fileName }: DownloadedFile): void {
  const blob = new Blob([toBlobBytes(bytes)], { type: mimeType });
  const objectUrl = URL.createObjectURL(blob);
  triggerBrowserDownload(objectUrl, fileName);
  setTimeout(() => URL.revokeObjectURL(objectUrl), OBJECT_URL_REVOKE_DELAY_MS);
}

// Blob only accepts ArrayBuffer-backed views; re-view without copying when possible.
function toBlobBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const { buffer } = bytes;
  if (buffer instanceof ArrayBuffer) {
    return new Uint8Array(buffer, bytes.byteOffset, bytes.byteLength);
  }
  return new Uint8Array(bytes);
}

/** Native only: writes bytes to the app's download directory and returns the file URI. */
function saveBytesOnDevice({ bytes, fileName }: Omit<DownloadedFile, "mimeType">): string {
  const targetFile = resolveDownloadTargetFile(fileName);
  targetFile.write(bytes);
  return targetFile.uri;
}

interface ShareDownloadedFileInput {
  uri: string;
  mimeType: string | null;
  fileName: string;
}

/**
 * Offers the saved file in the native share sheet. The file is already saved
 * when this runs, so a share-sheet failure is logged and never fails the download.
 */
export async function shareDownloadedFile(input: ShareDownloadedFileInput): Promise<void> {
  try {
    if (!(await Sharing.isAvailableAsync())) {
      return;
    }
    await Sharing.shareAsync(input.uri, {
      mimeType: input.mimeType ?? undefined,
      dialogTitle: input.fileName
        ? i18n.t("downloads.shareFileNamed", { fileName: input.fileName })
        : i18n.t("downloads.shareFile"),
    });
  } catch (error) {
    console.warn(`[DownloadStore] Share sheet failed for saved file ${input.uri}:`, error);
  }
}

export function resolveDownloadTargetFile(fileName: string): FSFile {
  const directory = Paths.cache ?? Paths.document;
  if (!directory) {
    throw new Error("No download directory available.");
  }

  const safeName = sanitizeDownloadFileName(fileName);
  const split = splitFileName(safeName);
  let targetFile = new FSFile(directory, safeName);
  let suffix = 1;

  while (targetFile.exists) {
    targetFile = new FSFile(directory, `${split.base} (${suffix})${split.ext}`);
    suffix += 1;
  }

  return targetFile;
}

function sanitizeDownloadFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (!trimmed) {
    return "download";
  }
  return trimmed.replace(/[\\/:*?"<>|]+/g, "_");
}

function splitFileName(fileName: string): { base: string; ext: string } {
  const lastDot = fileName.lastIndexOf(".");
  if (lastDot <= 0) {
    return { base: fileName, ext: "" };
  }
  return {
    base: fileName.slice(0, lastDot),
    ext: fileName.slice(lastDot),
  };
}
