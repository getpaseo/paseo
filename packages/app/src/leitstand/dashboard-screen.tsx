import { Redirect } from "expo-router";
import { useMemo } from "react";
import { View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { useHostRuntimeConnectionStatuses, useHosts } from "@/runtime/host-runtime";
import type { Theme } from "@/styles/theme";
import { buildOpenProjectRoute } from "@/utils/host-routes";
import { LeitstandScreen } from "./leitstand-screen";
import { useLeitstandSessions } from "./use-leitstand";

const ThemedLoadingSpinner = withUnistyles(LoadingSpinner);
const spinnerColor = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

/** The dashboard, opened on request only; without any project there is nothing to show yet. */
export function DashboardScreen() {
  const state = useLeitstandSessions();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const statuses = useHostRuntimeConnectionStatuses(serverIds);
  const values = [...statuses.values()];
  // Until every host has answered, "no projects" may only mean "not loaded yet".
  const isSettling =
    values.some((status) => status === "idle" || status === "connecting") ||
    (state.isInitialLoad && values.includes("online"));

  if (!state.hasProjects && !isSettling) return <Redirect href={buildOpenProjectRoute()} />;
  return (
    <View style={styles.container}>
      <MenuHeader borderless />
      {state.hasProjects ? (
        <LeitstandScreen state={state} />
      ) : (
        <View style={styles.loading}>
          <ThemedLoadingSpinner size="large" uniProps={spinnerColor} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  loading: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.colors.surface0,
  },
}));
