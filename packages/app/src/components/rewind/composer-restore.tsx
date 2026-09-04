import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";

interface RewindComposerRestoreContextValue {
  completeRewind: (text: string) => void;
}

interface RewindComposerRestoreProviderProps {
  text: string;
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
  text,
  setText,
  onRewindComplete,
  children,
}: RewindComposerRestoreProviderProps) {
  const textRef = useRef(text);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  const completeRewind = useCallback(
    (rewoundText: string) => {
      const nextText = restoreComposerTextIfEmpty({
        currentText: textRef.current,
        rewoundText,
      });
      if (nextText !== textRef.current) {
        setText(nextText);
      }
      onRewindComplete();
    },
    [onRewindComplete, setText],
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
