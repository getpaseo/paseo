import { create } from "zustand";
import type { UserComposerAttachment } from "@/attachments/types";
import type { DraftInput } from "@/stores/draft-store";

export interface PendingComposerPrompt {
  text: string;
  attachments: UserComposerAttachment[];
}

interface PendingPromptStore {
  byDraftKey: Record<string, PendingComposerPrompt>;
  stage: (input: { draftKey: string; prompt: PendingComposerPrompt }) => void;
  take: (draftKey: string) => PendingComposerPrompt | null;
}

/**
 * Prompts handed to the app from outside (share sheet, paseo:// links) wait
 * here until the composer that owns the draft key mounts and hydrates, so a
 * cold start, a warm start, and an already-open composer all merge the same
 * way. Nothing here is persisted: an unconsumed prompt dies with the process.
 */
export const usePendingPromptStore = create<PendingPromptStore>()((set, get) => ({
  byDraftKey: {},
  stage: ({ draftKey, prompt }) => {
    set((state) => {
      const existing = state.byDraftKey[draftKey];
      return {
        byDraftKey: {
          ...state.byDraftKey,
          [draftKey]: existing ? mergePendingPrompt(existing, prompt) : prompt,
        },
      };
    });
  },
  take: (draftKey) => {
    const pending = get().byDraftKey[draftKey];
    if (!pending) {
      return null;
    }
    set((state) => {
      const { [draftKey]: _taken, ...rest } = state.byDraftKey;
      return { byDraftKey: rest };
    });
    return pending;
  },
}));

export function mergePendingPrompt(
  current: DraftInput | PendingComposerPrompt,
  pending: PendingComposerPrompt,
): PendingComposerPrompt {
  const currentText = current.text.trimEnd();
  const pendingText = pending.text.trim();
  let text: string;
  if (!currentText) {
    text = pendingText;
  } else if (!pendingText) {
    text = current.text;
  } else {
    text = `${currentText}\n\n${pendingText}`;
  }
  return {
    text,
    attachments: [...current.attachments, ...pending.attachments],
  };
}

export function stagePendingPrompt(input: { draftKey: string; prompt: PendingComposerPrompt }) {
  usePendingPromptStore.getState().stage(input);
}
