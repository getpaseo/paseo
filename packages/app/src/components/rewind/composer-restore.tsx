import type { UserComposerAttachment } from "@/attachments/types";
import type { AgentInputDraft } from "@/composer/draft/input-draft";
import type { UserMessageItem } from "@/types/stream";
import type { ComposerTextSource } from "@/composer/text-source";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

export type RewoundMessage = Pick<UserMessageItem, "text" | "images" | "attachments">;

interface RewindComposerRestoreContextValue {
  completeRewind: (message: RewoundMessage) => void;
}

interface RewindComposerRestoreProviderProps {
  textSource: ComposerTextSource;
  setText: (text: string) => void;
  setAttachments: AgentInputDraft["setAttachments"];
  onRewindComplete: () => void;
  children: ReactNode;
}

const RewindComposerRestoreContext = createContext<RewindComposerRestoreContextValue | null>(null);

export function restoreComposerTextIfEmpty(input: {
  currentText: string;
  rewoundText: string;
}): string {
  if (input.currentText.length > 0) {
    return input.currentText;
  }
  return input.rewoundText;
}

export function restoreComposerAttachmentsIfEmpty(input: {
  currentAttachments: UserComposerAttachment[];
  rewoundMessage: RewoundMessage;
}): UserComposerAttachment[] {
  if (input.currentAttachments.length > 0) {
    return input.currentAttachments;
  }
  const attachments: UserComposerAttachment[] = (input.rewoundMessage.images ?? []).map(
    (metadata) => ({ kind: "image", metadata }),
  );
  for (const attachment of input.rewoundMessage.attachments ?? []) {
    if (attachment.type === "uploaded_file") {
      attachments.push({ kind: "file", attachment });
    }
  }
  return attachments;
}

export function RewindComposerRestoreProvider({
  textSource,
  setText,
  setAttachments,
  onRewindComplete,
  children,
}: RewindComposerRestoreProviderProps) {
  const completeRewind = useCallback(
    (message: RewoundMessage) => {
      const currentText = textSource.getSnapshot();
      const nextText = restoreComposerTextIfEmpty({
        currentText: currentText,
        rewoundText: message.text,
      });
      if (nextText !== currentText) {
        setText(nextText);
      }
      setAttachments((currentAttachments) =>
        restoreComposerAttachmentsIfEmpty({ currentAttachments, rewoundMessage: message }),
      );
      onRewindComplete();
    },
    [onRewindComplete, setAttachments, setText, textSource],
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
