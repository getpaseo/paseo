import { usePathname } from "expo-router";
import { useCallback, useEffect, useRef } from "react";

const NEW_WORKSPACE_PATHNAME = "/new";

export interface NewWorkspaceScreenPresence {
  isMounted: boolean;
  pathname: string;
}

/**
 * Workspace creation blocks on a slow daemon RPC, so by the time it resolves the user may have
 * moved on. Both signals are needed: popping to a workspace unmounts the screen while its last
 * observed pathname stays "/new", and pushing a route on top of it keeps it mounted underneath.
 */
export function isNewWorkspaceScreenActive(input: NewWorkspaceScreenPresence): boolean {
  return input.isMounted && input.pathname === NEW_WORKSPACE_PATHNAME;
}

export function useNewWorkspaceScreenPresence(): () => boolean {
  const pathname = usePathname();
  const pathnameRef = useRef(pathname);
  pathnameRef.current = pathname;
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  return useCallback(
    () =>
      isNewWorkspaceScreenActive({
        isMounted: isMountedRef.current,
        pathname: pathnameRef.current,
      }),
    [],
  );
}
