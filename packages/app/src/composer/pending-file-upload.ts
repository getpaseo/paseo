import type { SelectedFile } from "@/attachments/selected-file";
import type { FileUploadProgress } from "@getpaseo/client/internal/daemon-client";

/**
 * A file the composer is still sending to the daemon.
 *
 * Progress lives here rather than in composer state: the daemon acknowledges
 * every chunk, and re-rendering the whole composer for each one would stall
 * typing during a large upload. Only the file's own pill subscribes.
 */
export interface PendingFileUpload {
  readonly id: number;
  readonly file: SelectedFile;
  readonly controller: AbortController;
  /** Fraction of the file the daemon has written, or null until it reports. */
  getProgress(): number | null;
  subscribe(listener: () => void): () => void;
  reportProgress(progress: FileUploadProgress): void;
}

export function createPendingFileUpload(id: number, file: SelectedFile): PendingFileUpload {
  const controller = new AbortController();
  const listeners = new Set<() => void>();
  let progress: number | null = null;
  return {
    id,
    file,
    controller,
    getProgress: () => progress,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    reportProgress({ receivedBytes, totalBytes }) {
      const next = totalBytes > 0 ? Math.min(1, receivedBytes / totalBytes) : 1;
      // Whole percents are all the pill can show; skip updates that change nothing.
      if (progress !== null && Math.floor(next * 100) === Math.floor(progress * 100)) return;
      progress = next;
      for (const listener of listeners) listener();
    },
  };
}
