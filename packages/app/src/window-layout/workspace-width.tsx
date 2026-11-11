import { createContext, useContext, useMemo, type ReactNode } from "react";
import {
  useDerivedValue,
  useSharedValue,
  type DerivedValue,
  type SharedValue,
} from "react-native-reanimated";
import { resolveWorkspaceContentWidth, type WorkspaceContentWidthInput } from "./model";

interface WorkspaceWidthAllocation {
  targetWidth: number;
  sidebarWidth: SharedValue<number>;
  contentWidth: DerivedValue<number>;
}

interface WorkspaceWidthProviderProps extends WorkspaceContentWidthInput {
  children: ReactNode;
}

const WorkspaceWidthContext = createContext<WorkspaceWidthAllocation | null>(null);

export function WorkspaceWidthProvider({
  viewportWidth,
  sidebarWidth: targetSidebarWidth,
  sidebarVisible,
  divisionContentWidth,
  children,
}: WorkspaceWidthProviderProps) {
  const sidebarWidth = useSharedValue(targetSidebarWidth);
  const targetWidth = resolveWorkspaceContentWidth({
    viewportWidth,
    sidebarWidth: targetSidebarWidth,
    sidebarVisible,
    divisionContentWidth,
  });
  const contentWidth = useDerivedValue(
    () =>
      resolveWorkspaceContentWidth({
        viewportWidth,
        sidebarWidth: sidebarWidth.value,
        sidebarVisible,
        divisionContentWidth,
      }),
    [viewportWidth, sidebarVisible, divisionContentWidth],
  );
  const value = useMemo(
    () => ({ targetWidth, sidebarWidth, contentWidth }),
    [targetWidth, sidebarWidth, contentWidth],
  );
  return <WorkspaceWidthContext.Provider value={value}>{children}</WorkspaceWidthContext.Provider>;
}

export function useWorkspaceWidth() {
  const allocation = useContext(WorkspaceWidthContext);
  if (!allocation) throw new Error("Workspace width requires its app layout provider");
  return allocation;
}
