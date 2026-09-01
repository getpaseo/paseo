import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { resolveNewWorkspaceRouteParams } from "@/navigation/new-workspace-route-params";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";

export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    projectId?: string;
    draftId?: string;
    q?: string;
  }>();
  const { serverId, sourceDirectory, displayName, projectId, draftId, initialPrompt } =
    resolveNewWorkspaceRouteParams(params);
  const screenKey = JSON.stringify([
    serverId,
    sourceDirectory ?? null,
    displayName ?? null,
    projectId ?? null,
    draftId ?? null,
    initialPrompt ?? null,
  ]);

  return (
    <HostRouteBootstrapBoundary>
      <NewWorkspaceScreen
        key={screenKey}
        serverId={serverId}
        sourceDirectory={sourceDirectory}
        displayName={displayName}
        projectId={projectId}
        draftId={draftId}
        initialPrompt={initialPrompt}
      />
    </HostRouteBootstrapBoundary>
  );
}
