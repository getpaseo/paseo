import { useCallback, useRef } from "react";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { getDesktopHost, isElectronRuntime } from "@/desktop/host";
import { isWeb } from "@/constants/platform";
import { getMimeTypeFromPath } from "@/attachments/file-types";
import { readDesktopFileBytes, type SelectedFile } from "@/attachments/selected-file";

export interface PickFilesOptions {
  multiple?: boolean;
  /** Narrows the picker; callers still validate the content, since mobile pickers mislabel types. */
  accept?: { name: string; extensions: string[]; mimeTypes: string[] };
}

async function pickFilesWithDesktopDialog(
  options: PickFilesOptions,
): Promise<SelectedFile[] | null> {
  const dialog = getDesktopHost()?.dialog;
  const dialogOpen = dialog?.open;
  if (typeof dialogOpen !== "function") {
    throw new Error("Desktop dialog API is not available.");
  }

  const selection = await dialogOpen({
    directory: false,
    multiple: options.multiple ?? true,
    ...(options.accept
      ? { filters: [{ name: options.accept.name, extensions: options.accept.extensions }] }
      : {}),
  });

  if (!selection) {
    return null;
  }

  const paths = Array.isArray(selection) ? selection : [selection];
  if (paths.length === 0) {
    return null;
  }

  const result: SelectedFile[] = [];

  for (const filePath of paths) {
    const fileName = filePath.split("/").pop() ?? filePath.split("\\").pop() ?? filePath;
    const mimeType = getMimeTypeFromPath(filePath);
    result.push({ fileName, mimeType, readBytes: () => readDesktopFileBytes(filePath) });
  }

  return result;
}

function pickFilesWithWebInput(options: PickFilesOptions): Promise<SelectedFile[] | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = options.multiple ?? true;
    if (options.accept) {
      input.accept = [
        ...options.accept.extensions.map((extension) => `.${extension}`),
        ...options.accept.mimeTypes,
      ].join(",");
    }
    input.style.display = "none";

    input.addEventListener("change", async () => {
      const files = Array.from(input.files ?? []);
      if (files.length === 0) {
        resolve(null);
        return;
      }

      const result: SelectedFile[] = [];
      for (const file of files) {
        result.push({
          fileName: file.name,
          mimeType: file.type || getMimeTypeFromPath(file.name),
          readBytes: async () => new Uint8Array(await file.arrayBuffer()),
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

async function pickFilesWithDocumentPicker(
  options: PickFilesOptions,
): Promise<SelectedFile[] | null> {
  const result = await DocumentPicker.getDocumentAsync({
    multiple: options.multiple ?? true,
    copyToCacheDirectory: true,
    ...(options.accept ? { type: options.accept.mimeTypes } : {}),
  });

  if (result.canceled || result.assets.length === 0) {
    return null;
  }

  return result.assets.map((asset) => ({
    fileName: asset.name,
    mimeType: asset.mimeType ?? getMimeTypeFromPath(asset.name),
    readBytes: () => new File(asset.uri).bytes(),
  }));
}

type PickFiles = (options?: PickFilesOptions) => Promise<SelectedFile[] | null>;

export function useFilePicker() {
  const isPickingRef = useRef(false);

  const pickFiles = useCallback<PickFiles>(async (options = {}) => {
    if (isPickingRef.current) {
      return null;
    }
    isPickingRef.current = true;

    try {
      if (isWeb && isElectronRuntime()) {
        return await pickFilesWithDesktopDialog(options);
      }

      if (isWeb) {
        return await pickFilesWithWebInput(options);
      }

      return await pickFilesWithDocumentPicker(options);
    } catch (error) {
      console.error("[FilePicker] Failed to pick files:", error);
      throw error;
    } finally {
      isPickingRef.current = false;
    }
  }, []);

  return { pickFiles };
}
