/** Resolves only after a confirmed write; unavailable or denied writes reject. */
export interface FilePathClipboard {
  writeText(text: string): Promise<void>;
}

export type FilePathCopyStatus = "idle" | "pending" | "copied" | "error";

/** Copy feedback and duplicate suppression, independent of the platform clipboard. */
export class FilePathCopyModel {
  private status: FilePathCopyStatus = "idle";
  private readonly listeners = new Set<() => void>();

  constructor(private readonly clipboard: FilePathClipboard) {}

  getSnapshot = (): FilePathCopyStatus => this.status;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private update(status: FilePathCopyStatus): void {
    this.status = status;
    for (const listener of this.listeners) listener();
  }

  copy = async (text: string): Promise<void> => {
    if (this.status === "pending") return;
    this.update("pending");
    try {
      await this.clipboard.writeText(text);
      this.update("copied");
    } catch {
      this.update("error");
    }
  };

  dismissError = (): void => {
    if (this.status === "error") this.update("idle");
  };
}
