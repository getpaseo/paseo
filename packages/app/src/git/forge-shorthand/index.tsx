import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { createForgeShorthand, type ForgeShorthand } from "./shorthand";

export { createForgeShorthand, type ForgeShorthand } from "./shorthand";

import { useClientForgeHost } from "@/git/client-forge-registry";

const ForgeShorthandContext = createContext<ForgeShorthand | null>(null);

/** Makes `#12`-style references in descendant Markdown open on the workspace forge. */
export function ForgeShorthandProvider({
  forge,
  remoteUrl,
  serverId,
  children,
}: {
  forge: string | null | undefined;
  remoteUrl: string | null | undefined;
  children: ReactNode;
  serverId: string;
}) {
  const host = useClientForgeHost(serverId);
  const value = useMemo(
    () => createForgeShorthand({ forge, remoteUrl }, host),
    [forge, remoteUrl, host],
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
