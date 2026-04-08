import { useEffect, useMemo } from "react";
import { useRouter } from "expo-router";
import { DraftAgentScreen } from "@/screens/agent/draft-agent-screen";
import { useHosts } from "@/runtime/host-runtime";
import { buildHostSettingsRoute } from "@/utils/host-routes";

export default function LegacySettingsRoute() {
  const router = useRouter();
  const daemons = useHosts();

  const targetServerId = useMemo(() => {
    return daemons[0]?.serverId ?? null;
  }, [daemons]);

  useEffect(() => {
    if (!targetServerId) {
      return;
    }
    router.replace(buildHostSettingsRoute(targetServerId));
  }, [router, targetServerId]);

  if (!targetServerId) {
    return <DraftAgentScreen />;
  }

  return null;
}
