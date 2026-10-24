import { create } from "zustand";
import type { ConfirmDialogInput } from "@/utils/confirm-dialog";

interface PendingConfirm {
  id: number;
  input: ConfirmDialogInput;
  resolve: (confirmed: boolean) => void;
}

interface ConfirmDialogState {
  pending: PendingConfirm | null;
  request: (input: ConfirmDialogInput) => Promise<boolean>;
  /** Answers the request with this id; an answer for a replaced request is ignored. */
  answer: (id: number, confirmed: boolean) => void;
}

let nextRequestId = 0;

// Backs the browser confirm dialog. The browser's own window.confirm ignores the
// app theme and some browsers draw it unreadable, so web renders ConfirmDialogHost.
export const useConfirmDialogStore = create<ConfirmDialogState>((set, get) => ({
  pending: null,
  request: (input) =>
    new Promise<boolean>((resolve) => {
      // A newer request supersedes one still on screen; the older caller sees a cancel.
      get().pending?.resolve(false);
      nextRequestId += 1;
      set({ pending: { id: nextRequestId, input, resolve } });
    }),
  answer: (id, confirmed) => {
    const pending = get().pending;
    if (!pending || pending.id !== id) return;
    set({ pending: null });
    pending.resolve(confirmed);
  },
}));
