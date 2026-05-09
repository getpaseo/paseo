import { useLocalSearchParams } from "expo-router";
import { NewWorkspaceScreen } from "@/screens/new-workspace-screen";

export default function HostNewWorkspaceRoute() {
  const params = useLocalSearchParams<{
    serverId?: string;
    dir?: string;
    name?: string;
    title?: string;
  }>();
  const serverId = typeof params.serverId === "string" ? params.serverId : "";
  const sourceDirectory = typeof params.dir === "string" ? params.dir : "";
  const displayName = typeof params.name === "string" ? params.name : undefined;
  const headerTitle = typeof params.title === "string" ? params.title : undefined;

  if (!sourceDirectory) {
    return null;
  }

  return (
    <NewWorkspaceScreen
      serverId={serverId}
      sourceDirectory={sourceDirectory}
      displayName={displayName}
      headerTitle={headerTitle}
    />
  );
}
