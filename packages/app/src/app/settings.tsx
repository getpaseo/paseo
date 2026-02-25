import { useEffect, useMemo } from "react";
import { ActivityIndicator, View } from "react-native";
import { useRouter } from "expo-router";
import { useUnistyles } from "react-native-unistyles";
import { DraftAgentScreen } from "@/screens/agent/draft-agent-screen";
import { useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { useFormPreferences } from "@/hooks/use-form-preferences";
import { buildHostSettingsRoute } from "@/utils/host-routes";

export default function LegacySettingsRoute() {
  const router = useRouter();
  const { theme } = useUnistyles();
  const { daemons, isLoading: registryLoading } = useDaemonRegistry();
  const { preferences, isLoading: preferencesLoading } = useFormPreferences();

  const targetServerId = useMemo(() => {
    if (daemons.length === 0) {
      return null;
    }
    if (preferences.serverId) {
      const match = daemons.find(
        (daemon) => daemon.serverId === preferences.serverId
      );
      if (match) {
        return match.serverId;
      }
    }
    return daemons[0]?.serverId ?? null;
  }, [daemons, preferences.serverId]);

  useEffect(() => {
    if (registryLoading || preferencesLoading) {
      return;
    }
    if (!targetServerId) {
      return;
    }
    router.replace(buildHostSettingsRoute(targetServerId) as any);
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
