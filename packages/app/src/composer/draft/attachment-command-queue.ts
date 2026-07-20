import { create } from "zustand";
import type { WorkspaceFileComposerAttachment } from "@/attachments/types";

export interface ComposerAttachmentCommand {
  id: number;
  attachment: WorkspaceFileComposerAttachment;
}

interface ComposerAttachmentCommandQueueState {
  commandsByDraftKey: Record<string, ComposerAttachmentCommand[]>;
  revisionByDraftKey: Record<string, number>;
}

const initialState: ComposerAttachmentCommandQueueState = {
  commandsByDraftKey: {},
  revisionByDraftKey: {},
};

const useComposerAttachmentCommandQueue = create<ComposerAttachmentCommandQueueState>()(
  () => initialState,
);
let nextCommandId = 1;

export function enqueueComposerAttachment(input: {
  draftKey: string;
  attachment: WorkspaceFileComposerAttachment;
}): number {
  const id = nextCommandId;
  nextCommandId += 1;
  useComposerAttachmentCommandQueue.setState((state) => {
    const current = state.commandsByDraftKey[input.draftKey] ?? [];
    return {
      commandsByDraftKey: {
        ...state.commandsByDraftKey,
        [input.draftKey]: [...current, { id, attachment: input.attachment }],
      },
      revisionByDraftKey: {
        ...state.revisionByDraftKey,
        [input.draftKey]: (state.revisionByDraftKey[input.draftKey] ?? 0) + 1,
      },
    };
  });
  return id;
}

export function drainComposerAttachmentCommands(draftKey: string): ComposerAttachmentCommand[] {
  const commands = useComposerAttachmentCommandQueue.getState().commandsByDraftKey[draftKey] ?? [];
  if (commands.length === 0) {
    return [];
  }
  useComposerAttachmentCommandQueue.setState((state) => {
    const commandsByDraftKey = { ...state.commandsByDraftKey };
    delete commandsByDraftKey[draftKey];
    return { commandsByDraftKey };
  });
  return commands;
}

export function useComposerAttachmentCommandRevision(draftKey: string): number {
  return useComposerAttachmentCommandQueue((state) => state.revisionByDraftKey[draftKey] ?? 0);
}

export function resetComposerAttachmentCommandQueue(): void {
  nextCommandId = 1;
  useComposerAttachmentCommandQueue.setState(initialState, true);
}
