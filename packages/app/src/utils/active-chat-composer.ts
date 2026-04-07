interface ActiveChatComposerHandle {
  insertText: (text: string) => boolean;
  activateTab?: () => void;
}

const activeChatComposerHandles = new Map<string, ActiveChatComposerHandle>();
let activeChatComposerId: string | null = null;

export function registerActiveChatComposer(input: {
  id: string;
  handle: ActiveChatComposerHandle;
}): () => void {
  activeChatComposerHandles.set(input.id, input.handle);

  return () => {
    const current = activeChatComposerHandles.get(input.id);
    if (current === input.handle) {
      activeChatComposerHandles.delete(input.id);
    }
    if (activeChatComposerId === input.id) {
      activeChatComposerId = null;
    }
  };
}

export function markActiveChatComposer(id: string): void {
  if (!activeChatComposerHandles.has(id)) {
    return;
  }
  activeChatComposerId = id;
}

export function insertIntoActiveChatComposer(text: string): boolean {
  if (!activeChatComposerId) {
    return false;
  }

  const handle = activeChatComposerHandles.get(activeChatComposerId);
  if (!handle) {
    activeChatComposerId = null;
    return false;
  }

  const inserted = handle.insertText(text);
  if (inserted) {
    handle.activateTab?.();
  }
  return inserted;
}

export const __activeChatComposerTestUtils = {
  reset() {
    activeChatComposerHandles.clear();
    activeChatComposerId = null;
  },
};
