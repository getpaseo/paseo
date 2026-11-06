import type { ChatHistoryAttachment } from "@getpaseo/protocol/messages";
import { restoreChatHistoryAttachment } from "@/attachments/chat-history";
import type { ComposerTextSource } from "@/composer/text-source";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

interface RewindComposerRestoreContextValue {
  completeRewind: (prompt: { text: string; chatHistory?: ChatHistoryAttachment }) => void;
}

interface RewindComposerRestoreProviderProps {
  attachmentScopeKey: string;
  textSource: ComposerTextSource;
  setText: (text: string) => void;
  onRewindComplete: () => void;
  children: ReactNode;
}

const RewindComposerRestoreContext = createContext<RewindComposerRestoreContextValue | null>(null);

export function restoreComposerPromptIfEmpty(input: {
  currentText: string;
  rewoundPrompt: { text: string; chatHistory?: ChatHistoryAttachment };
}): { text: string; chatHistory?: ChatHistoryAttachment } {
  if (input.currentText.length > 0) return { text: input.currentText };
  return input.rewoundPrompt;
}

export function RewindComposerRestoreProvider({
  attachmentScopeKey,
  textSource,
  setText,
  onRewindComplete,
  children,
}: RewindComposerRestoreProviderProps) {
  const completeRewind = useCallback(
    (prompt: { text: string; chatHistory?: ChatHistoryAttachment }) => {
      const currentText = textSource.getSnapshot();
      const restored = restoreComposerPromptIfEmpty({ currentText, rewoundPrompt: prompt });
      if (restored.chatHistory) {
        restoreChatHistoryAttachment(attachmentScopeKey, restored.chatHistory);
      }
      if (restored.text !== currentText) {
        setText(restored.text);
      }
      onRewindComplete();
    },
    [attachmentScopeKey, onRewindComplete, setText, textSource],
  );

  const value = useMemo(() => ({ completeRewind }), [completeRewind]);

  return (
    <RewindComposerRestoreContext.Provider value={value}>
      {children}
    </RewindComposerRestoreContext.Provider>
  );
}

export function useRewindComposerRestore(): RewindComposerRestoreContextValue | null {
  return useContext(RewindComposerRestoreContext);
}
