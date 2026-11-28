import { create } from "zustand";
import type { IncomingShare } from "./model";
import { discardSharedFiles } from "./source";

interface ShareIntakeState {
  /** The share the target picker is showing. A newer share replaces it. */
  pending: IncomingShare | null;
}

export const useShareIntakeStore = create<ShareIntakeState>(() => ({ pending: null }));

export function offerShare(share: IncomingShare): void {
  const previous = useShareIntakeStore.getState().pending;
  useShareIntakeStore.setState({ pending: share });
  if (previous) discardSharedFiles(previous.files);
}

/** Closes the picker and deletes the share's temporary copies, delivered or not. */
export function finishShare(shareId: string): void {
  const pending = useShareIntakeStore.getState().pending;
  if (pending?.id !== shareId) return;
  useShareIntakeStore.setState({ pending: null });
  discardSharedFiles(pending.files);
}
