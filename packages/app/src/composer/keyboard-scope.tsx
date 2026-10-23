import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
  type ReactElement,
} from "react";

interface ComposerKeyboardScopeValue {
  /**
   * The pane this composer sits in is the user's pane. Mouse-driven focus
   * restoration follows it; touch navigation does not restore editor focus.
   */
  isPaneFocused: boolean;
  /**
   * The composer takes input right now: keyboard actions, shortcuts, autocomplete,
   * and the fullscreen exit action. False while a compact overlay panel covers the
   * pane, which does not take pane focus.
   */
  isActiveComposer: boolean;
}

const ComposerKeyboardScopeContext = createContext<ComposerKeyboardScopeValue>({
  isPaneFocused: false,
  isActiveComposer: false,
});

export function ComposerKeyboardScopeProvider({
  isPaneFocused,
  isActiveComposer,
  children,
}: PropsWithChildren<ComposerKeyboardScopeValue>): ReactElement {
  const value = useMemo(
    () => ({ isPaneFocused, isActiveComposer }),
    [isPaneFocused, isActiveComposer],
  );
  return (
    <ComposerKeyboardScopeContext.Provider value={value}>
      {children}
    </ComposerKeyboardScopeContext.Provider>
  );
}

export function useComposerKeyboardScope(): ComposerKeyboardScopeValue {
  return useContext(ComposerKeyboardScopeContext);
}
