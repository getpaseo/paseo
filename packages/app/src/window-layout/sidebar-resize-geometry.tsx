import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { createStore, type StoreApi } from "zustand/vanilla";

interface SidebarResizeWidth {
  viewportWidth: number;
  width: number;
}

interface ExplorerResizeWidth extends SidebarResizeWidth {
  workspaceKey: string;
  containerWidth: number;
}

export interface SidebarResizeGeometryState {
  left: SidebarResizeWidth | null;
  explorer: ExplorerResizeWidth | null;
  publishLeft: (viewportWidth: number, width: number | null) => void;
  publishExplorer: (input: {
    viewportWidth: number;
    workspaceKey: string;
    containerWidth: number;
    width: number | null;
  }) => void;
}

interface SidebarResizeGeometryRuntime {
  store: StoreApi<SidebarResizeGeometryState>;
  viewportWidth: number;
}

export function createSidebarResizeGeometryStore() {
  return createStore<SidebarResizeGeometryState>()((set) => ({
    left: null,
    explorer: null,
    publishLeft: (viewportWidth, width) =>
      set((current) => {
        if (width === null) {
          // A cancelled gesture from the old viewport must not clear a newer gesture.
          return current.left?.viewportWidth === viewportWidth ? { left: null } : current;
        }
        if (current.left?.viewportWidth === viewportWidth && current.left.width === width)
          return current;
        return { left: { viewportWidth, width } };
      }),
    publishExplorer: ({ viewportWidth, workspaceKey, containerWidth, width }) =>
      set((current) => {
        const previous = current.explorer;
        const sameOwner =
          previous?.viewportWidth === viewportWidth &&
          previous.workspaceKey === workspaceKey &&
          previous.containerWidth === containerWidth;
        if (width === null) return sameOwner ? { explorer: null } : current;
        if (sameOwner && previous.width === width) return current;
        return { explorer: { viewportWidth, workspaceKey, containerWidth, width } };
      }),
  }));
}

const SidebarResizeGeometryContext = createContext<SidebarResizeGeometryRuntime | null>(null);

export function SidebarResizeGeometryProvider({
  viewportWidth,
  children,
}: {
  viewportWidth: number;
  children: ReactNode;
}) {
  const [store] = useState(createSidebarResizeGeometryStore);
  const runtime = useMemo(() => ({ store, viewportWidth }), [store, viewportWidth]);
  return (
    <SidebarResizeGeometryContext.Provider value={runtime}>
      {children}
    </SidebarResizeGeometryContext.Provider>
  );
}

export function useSidebarResizeGeometry() {
  const runtime = useContext(SidebarResizeGeometryContext);
  if (!runtime) throw new Error("Sidebar resize geometry requires its window provider");
  return runtime;
}

export function usePublishSidebarResizeWidth() {
  const { store, viewportWidth } = useSidebarResizeGeometry();
  return useCallback(
    (width: number | null) => {
      store.getState().publishLeft(viewportWidth, width);
    },
    [store, viewportWidth],
  );
}

export function usePublishExplorerResizeWidth(workspaceKey: string, containerWidth: number) {
  const { store, viewportWidth } = useSidebarResizeGeometry();
  return useCallback(
    (width: number | null) => {
      store.getState().publishExplorer({ viewportWidth, workspaceKey, containerWidth, width });
    },
    [store, viewportWidth, workspaceKey, containerWidth],
  );
}
