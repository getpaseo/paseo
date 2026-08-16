import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { appendSlashCommandToken } from "@/assistant-file-links/slash-command";

interface ComposerInsertContextValue {
  insertSlashCommand: (token: string) => void;
  // The composer registers its focus function here so an insert can focus the
  // input afterwards. Called with `null` when the composer unmounts.
  registerFocusHandler: (focus: (() => void) | null) => void;
}

interface ComposerInsertProviderProps {
  text: string;
  setText: (text: string) => void;
  children: ReactNode;
}

const ComposerInsertContext = createContext<ComposerInsertContextValue | null>(null);

// Lets code outside the composer (e.g. a slash-command chip rendered inside an
// assistant message) append text to the active composer draft. Mirrors
// RewindComposerRestoreProvider: it is fed the same live `text`/`setText` from
// the agent input draft and holds a ref so consumers append relative to the
// latest value without re-subscribing on every keystroke.
export function ComposerInsertProvider({ text, setText, children }: ComposerInsertProviderProps) {
  const textRef = useRef(text);
  const focusRef = useRef<(() => void) | null>(null);

  // Keep the latest draft text in a ref via render-time assignment (same pattern
  // as AssistantFileLinkResolverProvider's configRef) so an insert reads the
  // current value with no one-render stale window.
  textRef.current = text;

  const registerFocusHandler = useCallback((focus: (() => void) | null) => {
    focusRef.current = focus;
  }, []);

  const insertSlashCommand = useCallback(
    (token: string) => {
      setText(appendSlashCommandToken({ text: textRef.current, token }));
      focusRef.current?.();
    },
    [setText],
  );

  const value = useMemo(
    () => ({ insertSlashCommand, registerFocusHandler }),
    [insertSlashCommand, registerFocusHandler],
  );

  return <ComposerInsertContext.Provider value={value}>{children}</ComposerInsertContext.Provider>;
}

export function useComposerInsert(): ComposerInsertContextValue | null {
  return useContext(ComposerInsertContext);
}
