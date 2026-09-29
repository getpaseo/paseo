import type {
  DownloadedFile,
  SaveDownloadedFile,
  SaveDownloadedFileHooks,
} from "@/utils/download-files";

export interface FakeDownloadedFileSaver {
  readonly save: SaveDownloadedFile;
  readonly savedFiles: readonly DownloadedFile[];
  failNextSave(error: Error): void;
}

export function createFakeDownloadedFileSaver(): FakeDownloadedFileSaver {
  const savedFiles: DownloadedFile[] = [];
  let nextError: Error | null = null;

  async function save(file: DownloadedFile, hooks: SaveDownloadedFileHooks): Promise<void> {
    if (nextError) {
      const error = nextError;
      nextError = null;
      throw error;
    }
    savedFiles.push(file);
    hooks.onSaved();
  }

  return {
    save,
    savedFiles,
    failNextSave(error) {
      nextError = error;
    },
  };
}
