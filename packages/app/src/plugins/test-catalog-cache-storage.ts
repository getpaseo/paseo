import type { CatalogCacheStorage } from "./catalog-cache-storage";

export interface TestCatalogCacheStorage extends CatalogCacheStorage {
  readonly files: ReadonlyMap<string, string>;
  readonly directories: ReadonlySet<string>;
  setFile(path: string, contents: string): void;
}

/**
 * Enforces the production contract: a write fails when its parent directory was not
 * created first, and a repeated write replaces the file instead of appending.
 */
export function createTestCatalogCacheStorage(): TestCatalogCacheStorage {
  const files = new Map<string, string>();
  const directories = new Set<string>();

  function parentDirectory(path: string): string {
    const separator = path.lastIndexOf("/");
    return separator < 0 ? "" : path.slice(0, separator);
  }

  return {
    files,
    directories,
    setFile(path, contents) {
      files.set(path, contents);
    },
    async makeDirectory(path) {
      let current = "";
      for (const segment of path.split("/").filter(Boolean)) {
        current = current ? `${current}/${segment}` : segment;
        directories.add(current);
      }
    },
    async readTextFile(path) {
      return files.get(path) ?? null;
    },
    async writeTextFile(path, contents) {
      const parent = parentDirectory(path);
      if (parent && !directories.has(parent)) {
        throw new Error(`writeTextFile: directory does not exist: ${parent}`);
      }
      files.set(path, contents);
    },
  };
}
