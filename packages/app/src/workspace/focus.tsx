import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from "react";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";

interface WorkspaceFocusContextValue {
  workspaceKey: string | null;
  unfocusPane: (workspaceKey: string) => string | null;
  restorePaneFocus: (workspaceKey: string, token: string) => void;
}

export interface WorkspaceFocusRestoration {
  unfocus: () => void;
  restore: () => void;
}

const WorkspaceFocusContext = createContext<WorkspaceFocusContextValue | null>(null);

const noopFocusRestoration: WorkspaceFocusRestoration = {
  unfocus: () => {},
  restore: () => {},
};

export function WorkspaceFocusProvider({
  workspaceKey,
  children,
}: {
  workspaceKey: string | null;
  children: ReactNode;
}) {
  const unfocusPane = useWorkspaceLayoutStore((state) => state.unfocusPane);
  const restorePaneFocus = useWorkspaceLayoutStore((state) => state.restorePaneFocus);
  const value = useMemo<WorkspaceFocusContextValue>(
    () => ({
      workspaceKey,
      unfocusPane,
      restorePaneFocus,
    }),
    [restorePaneFocus, unfocusPane, workspaceKey],
  );

  return <WorkspaceFocusContext.Provider value={value}>{children}</WorkspaceFocusContext.Provider>;
}

export function useWorkspaceFocusRestoration(): WorkspaceFocusRestoration {
  const context = useContext(WorkspaceFocusContext);
  const tokenRef = useRef<string | null>(null);

  const restore = useCallback(() => {
    const token = tokenRef.current;
    if (!context?.workspaceKey || !token) {
      tokenRef.current = null;
      return;
    }
    tokenRef.current = null;
    context.restorePaneFocus(context.workspaceKey, token);
  }, [context]);

  const unfocus = useCallback(() => {
    if (!context?.workspaceKey || tokenRef.current) {
      return;
    }
    tokenRef.current = context.unfocusPane(context.workspaceKey);
  }, [context]);

  useEffect(() => restore, [restore]);

  return context ? { unfocus, restore } : noopFocusRestoration;
}
