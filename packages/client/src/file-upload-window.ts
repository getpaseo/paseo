export interface FileUploadProgress {
  receivedBytes: number;
  totalBytes: number;
}

export class FileUploadAbortedError extends Error {
  constructor() {
    super("File upload aborted");
    this.name = "FileUploadAbortedError";
  }
}

// Unacknowledged bytes allowed in flight when the daemon reports progress.
// Without a bound the whole file is queued into the socket at once, so progress
// would only describe what was queued and an abort could not stop the transfer.
// 2 MiB keeps a 200 ms round trip from capping throughput below ~80 Mbit/s.
export const FILE_UPLOAD_WINDOW_BYTES = 2 * 1024 * 1024;

/**
 * How far one upload may run ahead of what the daemon has written.
 *
 * With acknowledgements the sender waits once `FILE_UPLOAD_WINDOW_BYTES` are
 * unacknowledged. Without them (daemons before `fileUploadProgress`) it never
 * waits and never reports progress. An abort or a settled response releases a
 * waiting sender at once.
 */
export class FileUploadWindow {
  private receivedBytes = 0;
  private closed = false;
  private resume: (() => void) | null = null;

  constructor(
    private readonly options: {
      acknowledged: boolean;
      totalBytes: number;
      onProgress?: (progress: FileUploadProgress) => void;
    },
  ) {}

  acknowledge(receivedBytes: number): void {
    if (receivedBytes <= this.receivedBytes) return;
    this.receivedBytes = receivedBytes;
    this.options.onProgress?.({ receivedBytes, totalBytes: this.options.totalBytes });
    this.release();
  }

  /** Stops every current and future wait, for an abort or a settled response. */
  close(): void {
    this.closed = true;
    this.release();
  }

  async waitForRoom(offset: number): Promise<void> {
    while (this.mustWait(offset)) {
      await new Promise<void>((resolve) => {
        this.resume = resolve;
      });
    }
  }

  private mustWait(offset: number): boolean {
    return (
      this.options.acknowledged &&
      !this.closed &&
      offset - this.receivedBytes >= FILE_UPLOAD_WINDOW_BYTES
    );
  }

  private release(): void {
    const resume = this.resume;
    this.resume = null;
    resume?.();
  }
}
