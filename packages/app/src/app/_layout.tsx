import { Stack } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { RealtimeProvider } from "@/contexts/realtime-context";
import { useAppSettings } from "@/hooks/use-settings";
import { View, ActivityIndicator, Text } from "react-native";
import { useUnistyles } from "react-native-unistyles";
import { DaemonRegistryProvider, useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { DaemonConnectionsProvider } from "@/contexts/daemon-connections-context";
import { MultiDaemonSessionHost } from "@/components/multi-daemon-session-host";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

function QueryProvider({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: Infinity,
            gcTime: Infinity,
            refetchOnMount: false,
            refetchOnReconnect: false,
            refetchOnWindowFocus: false,
          },
        },
      })
  );

  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function AppContainer({ children }: { children: ReactNode }) {
  const { theme } = useUnistyles();

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {children}
    </View>
  );
}

function ProvidersWrapper({ children }: { children: ReactNode }) {
  const { isLoading: settingsLoading } = useAppSettings();
  const { daemons, isLoading: registryLoading } = useDaemonRegistry();
  const isLoading = settingsLoading || registryLoading;

  if (isLoading) {
    return <LoadingView />;
  }

  if (daemons.length === 0) {
    return <MissingDaemonView />;
  }

  return <RealtimeProvider>{children}</RealtimeProvider>;
}

function LoadingView() {
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        backgroundColor: "#09090b",
      }}
    >
      <ActivityIndicator size="large" color="#fafafa" />
    </View>
  );
}

function MissingDaemonView() {
  return (
    <View
      style={{
        flex: 1,
        justifyContent: "center",
        alignItems: "center",
        padding: 24,
        backgroundColor: "#09090b",
      }}
    >
      <ActivityIndicator size="small" color="#fafafa" />
      <Text
        style={{
          color: "#fafafa",
          marginTop: 16,
          textAlign: "center",
        }}
      >
        No host configured. Open Settings to add a server URL.
      </Text>
    </View>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <KeyboardProvider>
          <BottomSheetModalProvider>
            <QueryProvider>
              <DaemonRegistryProvider>
                <DaemonConnectionsProvider>
                  <MultiDaemonSessionHost />
                  <ProvidersWrapper>
                    <AppContainer>
                      <Stack
                        screenOptions={{
                          headerShown: false,
                          animation: "none",
                          gestureEnabled: true,
                          gestureDirection: "horizontal",
                          fullScreenGestureEnabled: true,
                        }}
                      >
                        <Stack.Screen name="index" />
                        <Stack.Screen name="orchestrator" />
                        <Stack.Screen name="agent/[id]" />
                        <Stack.Screen name="agent/[serverId]/[agentId]" />
                        <Stack.Screen name="settings" />
                        <Stack.Screen name="audio-test" />
                        <Stack.Screen name="git-diff" />
                        <Stack.Screen name="file-explorer" />
                      </Stack>
                    </AppContainer>
                  </ProvidersWrapper>
                </DaemonConnectionsProvider>
              </DaemonRegistryProvider>
            </QueryProvider>
          </BottomSheetModalProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
