import type { ForgeWeb } from "@getpaseo/protocol/messages";
import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { createForgeShorthand, type ForgeShorthand } from "./shorthand";

export { createForgeShorthand, type ForgeShorthand } from "./shorthand";

const ForgeShorthandContext = createContext<ForgeShorthand | null>(null);

/** Makes `#12`-style references in descendant Markdown open on the workspace forge. */
export function ForgeShorthandProvider({
  forge,
  remoteUrl,
  forgeWeb,
  children,
}: {
  forge: string | null | undefined;
  remoteUrl: string | null | undefined;
  forgeWeb: ForgeWeb | null | undefined;
  children: ReactNode;
}) {
  // Keyed on the strings: the descriptor hands over a new `forgeWeb` object whenever any
  // other workspace field changes, and a new context value re-renders every Markdown message.
  const webHost = forgeWeb?.host;
  const referenceRepository = forgeWeb?.referenceRepository;
  const value = useMemo(
    () =>
      createForgeShorthand({
        forge,
        remoteUrl,
        forgeWeb: webHost ? { host: webHost, referenceRepository } : null,
      }),
    [forge, remoteUrl, webHost, referenceRepository],
  );
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
