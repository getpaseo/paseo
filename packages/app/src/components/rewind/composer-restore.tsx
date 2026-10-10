import type { ComposerTextSource } from "@/composer/text-source";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";

interface RewindComposerRestoreContextValue {
  completeRewind: (text: string) => void;
}

interface RewindComposerRestoreProviderProps {
  textSource: ComposerTextSource;
  setText: (text: string) => void;
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

export function RewindComposerRestoreProvider({
  textSource,
  setText,
  onRewindComplete,
  children,
}: RewindComposerRestoreProviderProps) {
  const completeRewind = useCallback(
    (rewoundText: string) => {
      const currentText = textSource.getSnapshot();
      const nextText = restoreComposerTextIfEmpty({
        currentText: currentText,
        rewoundText,
      });
      if (nextText !== currentText) {
        setText(nextText);
      }
      onRewindComplete();
    },
    [onRewindComplete, setText, textSource],
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
