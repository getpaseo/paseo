import type { LocalFileContents, LocalFolder } from "./copy-folder";

// The File System Access picker is not in TypeScript's DOM library yet. Chromium browsers and
// Electron provide it; Firefox and Safari do not.
interface DirectoryPickerWindow {
  showDirectoryPicker?: (options?: {
    id?: string;
    mode?: "read" | "readwrite";
    startIn?: "downloads";
  }) => Promise<FileSystemDirectoryHandle>;
}

function directoryPicker(): DirectoryPickerWindow["showDirectoryPicker"] {
  return typeof window === "undefined"
    ? undefined
    : (window as unknown as DirectoryPickerWindow).showDirectoryPicker;
}

export function canSaveFolders(): boolean {
  return typeof directoryPicker() === "function";
}

/**
 * Asks where to save a folder. Call it straight from the press that started the download: the
 * browser only opens the picker during a user gesture. Resolves `null` when the user cancels.
 */
export async function pickLocalFolder(): Promise<LocalFolder | null> {
  const showDirectoryPicker = directoryPicker();
  if (!showDirectoryPicker) {
    throw new Error("This browser cannot save folders.");
  }
  try {
    const handle = await showDirectoryPicker({
      id: "paseo-folder-download",
      mode: "readwrite",
      startIn: "downloads",
    });
    return directoryHandleFolder(handle);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return null;
    }
    throw error;
  }
}

function directoryHandleFolder(handle: FileSystemDirectoryHandle): LocalFolder {
  return {
    folder: async (name) =>
      directoryHandleFolder(await handle.getDirectoryHandle(name, { create: true })),
    writeFile: (name, contents, signal) => writeHandleFile(handle, name, contents, signal),
  };
}

async function writeHandleFile(
  directory: FileSystemDirectoryHandle,
  name: string,
  contents: LocalFileContents,
  signal: AbortSignal,
): Promise<void> {
  const file = await directory.getFileHandle(name, { create: true });
  // The writable stream fills a swap file that replaces the target only on close, so a failed
  // or cancelled copy leaves the previous file, or nothing, rather than a partial one.
  const writable = await file.createWritable();
  if (contents instanceof Uint8Array) {
    try {
      await writable.write(contents as Uint8Array<ArrayBuffer>);
      await writable.close();
    } catch (error) {
      await writable.abort().catch(() => undefined);
      throw error;
    }
    return;
  }
  // pipeTo closes the writable on success and aborts it on error or cancel.
  await contents.pipeTo(writable, { signal });
}
