import { useEffect, useMemo } from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { useUnistyles } from "react-native-unistyles";
import { DraftAgentScreen } from "@/screens/agent/draft-agent-screen";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { buildHostAgentDraftRoute } from "@/utils/host-routes";

export default function Index() {
  const router = useRouter();
  const params = useLocalSearchParams<{ serverId?: string }>();
  const { theme } = useUnistyles();
  const { daemons, isLoading: registryLoading } = useDaemonRegistry();
  const { preferences, isLoading: preferencesLoading } = useFormPreferences();
  const requestedServerId = useMemo(() => {
    return typeof params.serverId === "string" ? params.serverId.trim() : "";
  }, [params.serverId]);

  const targetServerId = useMemo(() => {
    if (daemons.length === 0) {
      return null;
    }
    if (requestedServerId) {
      const requested = daemons.find(
        (daemon) => daemon.serverId === requestedServerId
      );
      if (requested) {
        return requested.serverId;
      }
    }
    if (preferences.serverId) {
      const match = daemons.find((daemon) => daemon.serverId === preferences.serverId);
      if (match) {
        return match.serverId;
      }
    }
    return daemons[0]?.serverId ?? null;
  }, [daemons, preferences.serverId, requestedServerId]);

  useEffect(() => {
    if (registryLoading || preferencesLoading) {
      return;
    }
    if (!targetServerId) {
      return;
    }
    router.replace(buildHostAgentDraftRoute(targetServerId) as any);
  }, [preferencesLoading, registryLoading, router, targetServerId]);

  if (registryLoading || preferencesLoading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: theme.colors.surface0,
        }}
      >
        <ActivityIndicator size="small" color={theme.colors.foregroundMuted} />
      </View>
    );
  }

  if (!targetServerId) {
    return <DraftAgentScreen />;
  }

  return null;
}
