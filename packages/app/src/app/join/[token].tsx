import { useLocalSearchParams, useRouter } from "expo-router";
import { JoinSessionScreen } from "@/components/sharing/join-session-screen";
import { useAuthSession } from "@/desktop/hooks/use-auth-session";
import { buildHostRootRoute } from "@/utils/host-routes";

export default function JoinSessionRoute() {
  const { token, st } = useLocalSearchParams<{ token: string; st?: string }>();
  const router = useRouter();
  const { session } = useAuthSession();

  const sessionToken = session?.sessionToken ?? st ?? null;

  return (
    <JoinSessionScreen
      shareToken={token ?? ""}
      sessionToken={sessionToken}
      onJoined={(serverId) => router.replace(buildHostRootRoute(serverId))}
      onBack={() => router.replace("/")}
    />
  );
}
