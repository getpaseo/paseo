import {
  getMimeTypeFromPath,
  isRasterImageFile,
  isRasterImagePath,
} from "@/attachments/file-types";
import { readDesktopFileBytes, type PickedFile } from "@/attachments/picked-file";
import type { DroppedItem } from "@/hooks/use-file-drop-zone";

function fileNameFromPath(path: string): string {
  return path.split("/").pop() ?? path.split("\\").pop() ?? path;
}

export async function droppedItemsToPickedFiles(items: DroppedItem[]): Promise<PickedFile[]> {
  const files: PickedFile[] = [];

  for (const item of items) {
    if (item.kind === "web-file") {
      if (isRasterImageFile(item.file)) {
        continue;
      }
      files.push({
        fileName: item.file.name,
        mimeType: item.file.type || getMimeTypeFromPath(item.file.name),
        bytes: new Uint8Array(await item.file.arrayBuffer()),
      });
      continue;
    }

    if (isRasterImagePath(item.path)) {
      continue;
    }
    files.push({
      fileName: fileNameFromPath(item.path),
      mimeType: getMimeTypeFromPath(item.path),
      bytes: await readDesktopFileBytes(item.path),
    });
  }

  return files;
}
