import type { NavigationProp } from "@react-navigation/native";
import { useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useMemo, useRef, useState } from "react";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import {
  ComposerEditingScope,
  WorkspaceComposerEditingSessionsProvider,
} from "@/composer/editing-session";
import { NewWorkspaceScreen, type NewWorkspacePlacement } from "@/screens/new-workspace-screen";
import { buildNewWorkspaceDraftKey } from "@/stores/draft-keys";

/** New workspace drafts share one editing-session home, keyed like a tab by draft. */
const NEW_WORKSPACE_SESSIONS_KEY = "new-workspace";

function placementKey(
  placement: {
    serverId: string;
    sourceDirectory?: string;
    displayName?: string;
    projectId?: string;
  },
  draftId?: string,
) {
  return JSON.stringify([
    draftId ?? null,
    placement.serverId,
    placement.sourceDirectory ?? null,
    placement.displayName ?? null,
    placement.projectId ?? null,
  ]);
}

type NewWorkspaceRouteParams = Partial<
  Record<"serverId" | "dir" | "name" | "projectId" | "draftId", string>
>;

export default function NewWorkspaceRoute() {
  const navigation = useNavigation<NavigationProp<{ new: NewWorkspaceRouteParams }, "new">>();
  const params = useLocalSearchParams<NewWorkspaceRouteParams>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sourceDirectory = typeof params.dir === "string" ? params.dir : undefined;
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  const draftId = typeof params.draftId === "string" ? params.draftId : undefined;
  const routePlacementKey = placementKey(
    { serverId, sourceDirectory, displayName, projectId },
    draftId,
  );
  const publishedPlacementKey = useRef<string | null>(null);
  const [routeIdentity, setRouteIdentity] = useState({
    placementKey: routePlacementKey,
    generation: 0,
  });
  if (routeIdentity.placementKey !== routePlacementKey) {
    // Our URL mirror preserves the draft; a new navigation owns a new selection context.
    const isPlacementMirror = publishedPlacementKey.current === routePlacementKey;
    publishedPlacementKey.current = null;
    setRouteIdentity({
      placementKey: routePlacementKey,
      generation: routeIdentity.generation + (isPlacementMirror ? 0 : 1),
    });
  }
  const handlePlacementChange = useCallback(
    (placement: NewWorkspacePlacement) => {
      publishedPlacementKey.current = placementKey(placement, draftId);
      navigation.setParams({
        serverId: placement.serverId,
        dir: placement.sourceDirectory,
        name: placement.displayName,
        projectId: placement.projectId,
      });
    },
    [draftId, navigation],
  );
  const draftKey = buildNewWorkspaceDraftKey(draftId);
  const sessionTabIds = useMemo(() => [draftKey], [draftKey]);

  return (
    <HostRouteBootstrapBoundary>
      <WorkspaceComposerEditingSessionsProvider
        workspaceKey={NEW_WORKSPACE_SESSIONS_KEY}
        tabIds={sessionTabIds}
      >
        <ComposerEditingScope tabId={draftKey} targetKey={draftKey}>
          <NewWorkspaceScreen
            key={`${draftKey}:${routeIdentity.generation}`}
            serverId={serverId}
            sourceDirectory={sourceDirectory}
            displayName={displayName}
            projectId={projectId}
            draftId={draftId}
            onPlacementChange={handlePlacementChange}
          />
        </ComposerEditingScope>
      </WorkspaceComposerEditingSessionsProvider>
    </HostRouteBootstrapBoundary>
  );
}
