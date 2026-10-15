import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
  type ReactElement,
} from "react";

interface ComposerKeyboardScopeValue {
  /**
   * The pane this composer sits in is the user's pane. Focus restoration follows it:
   * the editor keeps its focus intent across blurs that happen while the pane is not
   * the user's (a retained tab hidden, a sheet over it) and brings focus back when
   * the pane is theirs again.
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
