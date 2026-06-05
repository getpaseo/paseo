import { useLocalSearchParams } from "expo-router";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";

export default function HostNewWorkspaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    projectId?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sourceDirectory = typeof params.dir === "string" ? params.dir : undefined;
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const projectId = typeof params.projectId === "string" ? params.projectId : undefined;

  return (
    <NewWorkspaceScreen
      serverId={serverId}
      sourceDirectory={sourceDirectory}
      displayName={displayName}
      projectId={projectId}
    />
  );
}
