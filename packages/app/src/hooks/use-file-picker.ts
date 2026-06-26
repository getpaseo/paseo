import { useCallback, useRef } from "react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { isWeb } from "@/constants/platform";
import { getMimeTypeFromPath } from "@/attachments/file-types";
import { readDesktopFileBytes, type PickedFile } from "@/attachments/picked-file";

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
    const bytes = await readDesktopFileBytes(filePath);

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

async function pickFilesWithDocumentPicker(): Promise<PickedFile[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: true,
    copyToCacheDirectory: true,
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  return await Promise.all(
    result.assets.map(async (asset) => ({
      fileName: asset.name,
      mimeType: asset.mimeType ?? getMimeTypeFromPath(asset.name),
      bytes: await new File(asset.uri).bytes(),
    })),
  );
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

      return await pickFilesWithDocumentPicker();
    } catch (error) {
      console.error("[FilePicker] Failed to pick files:", error);
      throw error;
    } finally {
      isPickingRef.current = false;
    }
  }, []);

  return { pickFiles };
}
