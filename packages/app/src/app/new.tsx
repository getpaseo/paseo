import { useLocalSearchParams } from "expo-router";
import { HostRouteBootstrapBoundary } from "@/components/host-route-bootstrap-boundary";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";

export default function NewWorkspaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    projectId?: string;
    draftId?: string;
    chat?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sourceDirectory = typeof params.dir === "string" ? params.dir : undefined;
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;
  const draftId = typeof params.draftId === "string" ? params.draftId : undefined;
  const initialChatMode = params.chat === "1";
  const screenKey = JSON.stringify([
    serverId,
    sourceDirectory ?? null,
    displayName ?? null,
    projectId ?? null,
    draftId ?? null,
    initialChatMode,
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
        initialChatMode={initialChatMode}
      />
    </HostRouteBootstrapBoundary>
  );
}
