import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { createForgeShorthand, type ForgeShorthand } from "./shorthand";

export { createForgeShorthand, type ForgeShorthand } from "./shorthand";

const ForgeShorthandContext = createContext<ForgeShorthand | null>(null);

/** Makes `#12`-style references in descendant Markdown open on the workspace forge. */
export function ForgeShorthandProvider({
  forge,
  remoteUrl,
  children,
}: {
  forge: string | null | undefined;
  remoteUrl: string | null | undefined;
  children: ReactNode;
}) {
  const value = useMemo(() => createForgeShorthand({ forge, remoteUrl }), [forge, remoteUrl]);
  return <ForgeShorthandContext.Provider value={value}>{children}</ForgeShorthandContext.Provider>;
}

export function useForgeShorthand(): ForgeShorthand | null {
  return useContext(ForgeShorthandContext);
}

/** Carries the shorthand environment across a portal. */
export function useForgeShorthandBridge() {
  const value = useContext(ForgeShorthandContext);
  return useCallback(
    (children: ReactNode) => (
      <ForgeShorthandContext.Provider value={value}>{children}</ForgeShorthandContext.Provider>
    ),
    [value],
  );
}
