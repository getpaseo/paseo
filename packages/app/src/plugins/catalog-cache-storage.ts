import { Directory, File, Paths } from "expo-file-system";

/**
 * The file operations the cached plugin catalog needs. Paths are relative to the
 * app's documents directory.
 */
export interface CatalogCacheStorage {
  /** Creates the directory and any missing parents. Safe to repeat. */
  makeDirectory(path: string): Promise<void>;
  /** Returns null when no file exists at the path. */
  readTextFile(path: string): Promise<string | null>;
  /** Creates the file and replaces any existing contents. */
  writeTextFile(path: string, contents: string): Promise<void>;
}

export function createExpoCatalogCacheStorage(): CatalogCacheStorage {
  return {
    async makeDirectory(path) {
      new Directory(Paths.document, path).create({ intermediates: true, idempotent: true });
    },
    async readTextFile(path) {
      const file = new File(Paths.document, path);
      return file.exists ? await file.text() : null;
    },
    async writeTextFile(path, contents) {
      new File(Paths.document, path).write(contents);
    },
  };
}
