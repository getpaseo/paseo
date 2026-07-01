import {
  createContext,
  useContext,
  useMemo,
  type PropsWithChildren,
  type ReactElement,
} from "react";

interface ComposerKeyboardScopeValue {
  isActiveComposer: boolean;
}

const ComposerKeyboardScopeContext = createContext<ComposerKeyboardScopeValue>({
  isActiveComposer: false,
});

export function ComposerKeyboardScopeProvider({
  isActiveComposer,
  children,
}: PropsWithChildren<ComposerKeyboardScopeValue>): ReactElement {
  const value = useMemo(() => ({ isActiveComposer }), [isActiveComposer]);
  return (
    <ComposerKeyboardScopeContext.Provider value={value}>
      {children}
    </ComposerKeyboardScopeContext.Provider>
  );
}

export function useComposerKeyboardScope(): ComposerKeyboardScopeValue {
  return useContext(ComposerKeyboardScopeContext);
}
