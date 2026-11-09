import type { IncomingShareRead, SharedFile } from "./model";

// Web and desktop are not share targets; other apps hand files over by drag and drop instead.

export function readPendingShare(): Promise<IncomingShareRead> {
  return Promise.resolve({ share: null, filesUnreadable: false });
}

export function subscribeToShares(_onShare: () => void): () => void {
  return () => {};
}

export function discardSharedFiles(_files: readonly SharedFile[]): void {}

export function readSharedFileBytes(_file: SharedFile): Promise<Uint8Array> {
  return Promise.reject(new Error("Shared files are only available on iOS and Android."));
}
