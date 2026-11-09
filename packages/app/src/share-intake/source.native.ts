import * as Linking from "expo-linking";
import { File } from "expo-file-system";
import {
  clearSharedPayloads,
  getResolvedSharedPayloadsAsync,
  getSharedPayloads,
} from "expo-sharing";
import { AppState } from "react-native";
import { generateMessageId } from "@/types/stream";
import {
  isShareIntakeUrl,
  readIncomingShare,
  type IncomingShareRead,
  type SharedFile,
} from "./model";

const source = { getSharedPayloads, getResolvedSharedPayloadsAsync, clearSharedPayloads };

export function readPendingShare(): Promise<IncomingShareRead> {
  return readIncomingShare(source, generateMessageId);
}

/**
 * Calls `onShare` when another app may have shared something. The app learns of a share through a
 * URL event on a warm start and through returning to the foreground; both can fire for one share.
 */
export function subscribeToShares(onShare: () => void): () => void {
  const urlSubscription = Linking.addEventListener("url", ({ url }) => {
    if (isShareIntakeUrl(url)) onShare();
  });
  const appStateSubscription = AppState.addEventListener("change", (state) => {
    if (state === "active") onShare();
  });
  return () => {
    urlSubscription.remove();
    appStateSubscription.remove();
  };
}

/** Deletes the temporary copies the share extension or intent handler made. */
export function discardSharedFiles(files: readonly SharedFile[]): void {
  for (const file of files) {
    try {
      const handle = new File(file.uri);
      if (handle.exists) handle.delete();
    } catch (error) {
      console.warn("[ShareIntake] Failed to delete a shared file copy", error);
    }
  }
}

export function readSharedFileBytes(file: SharedFile): Promise<Uint8Array> {
  return new File(file.uri).bytes();
}
