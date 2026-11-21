import { toErrorMessage } from "@/utils/error-messages";

/**
 * Copies a workspace directory into a folder on this device, one file at a time, the way VS Code
 * downloads a remote folder. Nothing is archived: the daemon serves each file through the same
 * reads as single-file downloads, so every connection type works and size limits apply per file.
 */

/** A folder on this device that a download writes into. */
export interface LocalFolder {
  /** Returns the named subfolder, creating it when missing. */
  folder(name: string): Promise<LocalFolder>;
  /** Writes the named file, replacing an existing one only once all bytes are written. */
  writeFile(name: string, contents: LocalFileContents, signal: AbortSignal): Promise<void>;
}

export type LocalFileContents = Uint8Array | ReadableStream<Uint8Array>;

export interface RemoteFolderEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
}

export interface CopyFolderProgress {
  completed: number;
  total: number;
}

export interface CopyFolderFailure {
  path: string;
  error: string;
}

export interface CopyFolderResult {
  total: number;
  failures: CopyFolderFailure[];
}

interface CopyFolderInput {
  path: string;
  destination: LocalFolder;
  /** Mirrors the Files tree: when false, dotfiles and dot-folders are left out. */
  includeHidden: boolean;
  listDirectory: (path: string) => Promise<readonly RemoteFolderEntry[]>;
  readFile: (file: RemoteFolderEntry, signal: AbortSignal) => Promise<LocalFileContents>;
  signal: AbortSignal;
  onProgress: (progress: CopyFolderProgress) => void;
  concurrency?: number;
}

interface PendingFile {
  entry: RemoteFolderEntry;
  destination: LocalFolder;
}

const DEFAULT_CONCURRENCY = 4;

/**
 * Lists the whole tree first so progress has a total, recreating folders (empty ones included)
 * as it goes, then copies files a few at a time. A file or folder that fails is recorded and the
 * copy continues; cancelling through `signal` rejects with the abort reason.
 */
export async function copyFolder(input: CopyFolderInput): Promise<CopyFolderResult> {
  const failures: CopyFolderFailure[] = [];
  const files: PendingFile[] = [];
  const directories: { path: string; destination: LocalFolder }[] = [
    { path: input.path, destination: input.destination },
  ];

  for (let next = directories.shift(); next; next = directories.shift()) {
    input.signal.throwIfAborted();
    let entries: readonly RemoteFolderEntry[];
    try {
      entries = await input.listDirectory(next.path);
    } catch (error) {
      failures.push({ path: next.path, error: toErrorMessage(error) });
      continue;
    }
    for (const entry of entries) {
      if (!input.includeHidden && entry.name.startsWith(".")) continue;
      if (entry.kind === "file") {
        files.push({ entry, destination: next.destination });
        continue;
      }
      try {
        directories.push({
          path: entry.path,
          destination: await next.destination.folder(entry.name),
        });
      } catch (error) {
        failures.push({ path: entry.path, error: toErrorMessage(error) });
      }
    }
  }

  let completed = 0;
  input.onProgress({ completed, total: files.length });
  let nextFile = 0;
  const copyNext = async (): Promise<void> => {
    for (let index = nextFile++; index < files.length; index = nextFile++) {
      input.signal.throwIfAborted();
      const { entry, destination } = files[index]!;
      try {
        const contents = await input.readFile(entry, input.signal);
        await destination.writeFile(entry.name, contents, input.signal);
      } catch (error) {
        if (input.signal.aborted) throw input.signal.reason;
        failures.push({ path: entry.path, error: toErrorMessage(error) });
      }
      completed += 1;
      input.onProgress({ completed, total: files.length });
    }
  };
  const workers = Array.from(
    { length: Math.min(input.concurrency ?? DEFAULT_CONCURRENCY, files.length) },
    copyNext,
  );
  await Promise.all(workers);
  return { total: files.length, failures };
}
