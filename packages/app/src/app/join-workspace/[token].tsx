import { useLocalSearchParams, useRouter } from "expo-router";
import { JoinWorkspaceScreen } from "@/components/sharing/join-workspace-screen";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";

export default function JoinWorkspaceRoute() {
  const { token, st } = useLocalSearchParams<{ token: string; st?: string }>();
  const router = useRouter();
  const { session } = useAuthSession();

  const sessionToken = session?.sessionToken ?? st ?? null;

  return (
    <JoinWorkspaceScreen
      shareToken={token ?? ""}
      sessionToken={sessionToken}
      onJoined={({ serverId, workspaceId }) =>
        router.replace(buildHostWorkspaceRoute(serverId, workspaceId))
      }
      onBack={() => router.replace("/")}
    />
  );
}
