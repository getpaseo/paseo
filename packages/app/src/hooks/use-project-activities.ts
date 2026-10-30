import { useMemo } from "react";
import { useSessionStore } from "@/stores/session-store";
import { useCreateFlowStore } from "@/stores/create-flow-store";
import {
  createProjectActivitiesSelector,
  type SidebarWorkspacePlacement,
} from "./sidebar-workspaces-view-model";

export function useProjectActivities(
  workspaces: readonly SidebarWorkspacePlacement[],
  enabled: boolean,
) {
  const pendingCreateAttempts = useCreateFlowStore((state) => state.pendingByDraftId);
  const select = useMemo(
    () =>
      createProjectActivitiesSelector({
        workspaces,
        enabled,
        pendingCreateAttempts,
      }),
    [workspaces, enabled, pendingCreateAttempts],
  );
  return useSessionStore(select);
}
