import { useCallback, useRef } from "react";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { copyDesktopAttachmentFile } from "@/desktop/attachments/desktop-file-commands";
import { readDesktopFileBase64 } from "@/desktop/attachments/desktop-preview-url";
import { isWeb } from "@/constants/platform";

export interface PickedFile {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".heic": "image/heic",
  ".heif": "image/heif",
  ".avif": "image/avif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".js": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript-jsx",
  ".jsx": "text/javascript",
  ".html": "text/html",
  ".css": "text/css",
  ".xml": "text/xml",
  ".csv": "text/csv",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tar": "application/x-tar",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function getFileExtension(path: string): string {
  const normalizedPath = path.split("#", 1)[0]?.split("?", 1)[0] ?? path;
  const extensionIndex = normalizedPath.lastIndexOf(".");
  if (extensionIndex < 0) {
    return "";
  }
  return normalizedPath.slice(extensionIndex).toLowerCase();
}

export function getMimeTypeFromPath(path: string): string {
  const ext = getFileExtension(path);
  return MIME_BY_EXTENSION[ext] ?? "application/octet-stream";
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

export async function readDesktopFileBytes(path: string): Promise<Uint8Array> {
  const { path: managedPath } = await copyDesktopAttachmentFile({
    attachmentId: crypto.randomUUID(),
    sourcePath: path,
    extension: getFileExtension(path).slice(1) || null,
  });
  const base64 = await readDesktopFileBase64(managedPath);
  return base64ToUint8Array(base64);
}

async function pickFilesWithDesktopDialog(): Promise<PickedFile[] | null> {
  const dialog = getDesktopHost()?.dialog;
  const dialogOpen = dialog?.open;
  if (typeof dialogOpen !== "function") {
    throw new Error("Desktop dialog API is not available.");
  }

  const selection = await dialogOpen({
    directory: false,
    multiple: true,
  });

  if (!selection) {
    return null;
  }

  const paths = Array.isArray(selection) ? selection : [selection];
  if (paths.length === 0) {
    return null;
  }

  const result: PickedFile[] = [];

  for (const filePath of paths) {
    const fileName = filePath.split("/").pop() ?? filePath.split("\\").pop() ?? filePath;
    const mimeType = getMimeTypeFromPath(filePath);

    // Copy into managed storage so we can read it through the existing secure IPC.
    const { path: managedPath } = await copyDesktopAttachmentFile({
      attachmentId: crypto.randomUUID(),
      sourcePath: filePath,
      extension: getFileExtension(filePath).slice(1) || null,
    });

    const base64 = await readDesktopFileBase64(managedPath);
    const bytes = base64ToUint8Array(base64);

    result.push({ fileName, mimeType, bytes });
  }

  return result;
}

function pickFilesWithWebInput(): Promise<PickedFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.style.display = "none";

    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve(null);
        return;
      }

      const result: PickedFile[] = [];
      for (const file of files) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        result.push({
          fileName: file.name,
          mimeType: file.type || getMimeTypeFromPath(file.name),
          bytes,
        });
      }
      resolve(result);
    });

    input.addEventListener("cancel", () => {
      resolve(null);
    });

    document.body.appendChild(input);
    input.click();

    // Clean up after a short delay to allow the change event to fire
    setTimeout(() => {
      input.remove();
    }, 60_000);
  });
}

export function useFilePicker() {
  const isPickingRef = useRef(false);

  const pickFiles = useCallback(async (): Promise<PickedFile[] | null> => {
    if (isPickingRef.current) {
      return null;
    }
    isPickingRef.current = true;

    try {
      if (isWeb && isElectronRuntime()) {
        return await pickFilesWithDesktopDialog();
      }

      if (isWeb) {
        return await pickFilesWithWebInput();
      }

      // Native not supported yet
      return null;
    } catch (error) {
      console.error("[FilePicker] Failed to pick files:", error);
      throw error;
    } finally {
      isPickingRef.current = false;
    }
  }, []);

  return { pickFiles };
}
