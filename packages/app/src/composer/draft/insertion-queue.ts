import { create } from "zustand";

export interface ComposerInsertionCommand {
  id: number;
  text: string;
}

interface ComposerInsertionQueueState {
  commandsByDraftKey: Record<string, ComposerInsertionCommand[]>;
  revisionByDraftKey: Record<string, number>;
}

const initialState: ComposerInsertionQueueState = {
  commandsByDraftKey: {},
  revisionByDraftKey: {},
};

const useComposerInsertionQueue = create<ComposerInsertionQueueState>()(() => initialState);
let nextCommandId = 1;

export function appendComposerInsertion(input: {
  currentText: string;
  insertionText: string;
}): string {
  if (input.currentText.length === 0 || /\s$/.test(input.currentText)) {
    return `${input.currentText}${input.insertionText}`;
  }
  return `${input.currentText}\n${input.insertionText}`;
}

export function enqueueComposerInsertion(input: { draftKey: string; text: string }): number {
  const id = nextCommandId;
  nextCommandId += 1;
  useComposerInsertionQueue.setState((state) => {
    const current = state.commandsByDraftKey[input.draftKey] ?? [];
    return {
      commandsByDraftKey: {
        ...state.commandsByDraftKey,
        [input.draftKey]: [...current, { id, text: input.text }],
      },
      revisionByDraftKey: {
        ...state.revisionByDraftKey,
        [input.draftKey]: (state.revisionByDraftKey[input.draftKey] ?? 0) + 1,
      },
    };
  });
  return id;
}

export function drainComposerInsertions(draftKey: string): ComposerInsertionCommand[] {
  const commands = useComposerInsertionQueue.getState().commandsByDraftKey[draftKey] ?? [];
  if (commands.length === 0) {
    return [];
  }
  useComposerInsertionQueue.setState((state) => {
    const commandsByDraftKey = { ...state.commandsByDraftKey };
    delete commandsByDraftKey[draftKey];
    return { commandsByDraftKey };
  });
  return commands;
}

export function useComposerInsertionRevision(draftKey: string): number {
  return useComposerInsertionQueue((state) => state.revisionByDraftKey[draftKey] ?? 0);
}

export function resetComposerInsertionQueue(): void {
  nextCommandId = 1;
  useComposerInsertionQueue.setState(initialState, true);
}
