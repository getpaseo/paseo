import { Stack, usePathname } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView, Gesture, GestureDetector } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { RealtimeProvider } from "@/contexts/realtime-context";
import { useAppSettings } from "@/hooks/use-settings";
import { View, ActivityIndicator, Text } from "react-native";
import { UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { DaemonRegistryProvider, useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { DaemonConnectionsProvider } from "@/contexts/daemon-connections-context";
import { MultiDaemonSessionHost } from "@/components/multi-daemon-session-host";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode, useMemo } from "react";
import { SlidingSidebar } from "@/components/sliding-sidebar";
import { useSidebarStore } from "@/stores/sidebar-store";
import { runOnJS, interpolate, Extrapolation } from "react-native-reanimated";
import {
  SidebarAnimationProvider,
  useSidebarAnimation,
} from "@/contexts/sidebar-animation-context";

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

interface AppContainerProps {
  children: ReactNode;
  selectedAgentId?: string;
}

function AppContainer({ children, selectedAgentId }: AppContainerProps) {
  const { theme } = useUnistyles();
  const { isOpen, open } = useSidebarStore();
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
  } = useSidebarAnimation();
  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";

  // Open gesture: swipe right from anywhere to open sidebar (interactive drag)
  const openGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(isMobile && !isOpen)
        // Only activate after 15px horizontal movement to the right
        .activeOffsetX(15)
        // Fail if 10px vertical movement happens first (allow vertical scroll)
        .failOffsetY([-10, 10])
        .onStart(() => {
          isGesturing.value = true;
        })
        .onUpdate((event) => {
          // Start from closed position (-windowWidth) and move towards 0
          const newTranslateX = Math.min(0, -windowWidth + event.translationX);
          translateX.value = newTranslateX;
          backdropOpacity.value = interpolate(
            newTranslateX,
            [-windowWidth, 0],
            [0, 1],
            Extrapolation.CLAMP
          );
        })
        .onEnd((event) => {
          isGesturing.value = false;
          // Open if dragged more than 1/3 of sidebar or fast swipe
          const shouldOpen = event.translationX > windowWidth / 3 || event.velocityX > 500;
          if (shouldOpen) {
            animateToOpen();
            runOnJS(open)();
          } else {
            animateToClose();
          }
        })
        .onFinalize(() => {
          isGesturing.value = false;
        }),
    [isMobile, isOpen, windowWidth, translateX, backdropOpacity, animateToOpen, animateToClose, open, isGesturing]
  );

  const content = (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <View style={{ flex: 1, flexDirection: "row" }}>
        {!isMobile && <SlidingSidebar selectedAgentId={selectedAgentId} />}
        <View style={{ flex: 1 }}>{children}</View>
      </View>
      {isMobile && <SlidingSidebar selectedAgentId={selectedAgentId} />}
    </View>
  );

  if (!isMobile) {
    return content;
  }

  return (
    <GestureDetector gesture={openGesture} touchAction="pan-y">
      {content}
    </GestureDetector>
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

function AppWithSidebar({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  // Parse selectedAgentKey directly from pathname
  // useLocalSearchParams doesn't update when navigating between same-pattern routes
  const selectedAgentKey = useMemo(() => {
    // Match /agent/[serverId]/[agentId] pattern
    const match = pathname.match(/^\/agent\/([^/]+)\/([^/]+)$/);
    if (match) {
      const [, serverId, agentId] = match;
      return `${serverId}:${agentId}`;
    }
    return undefined;
  }, [pathname]);

  return (
    <AppContainer selectedAgentId={selectedAgentKey}>{children}</AppContainer>
  );
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
                    <SidebarAnimationProvider>
                      <AppWithSidebar>
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
                      </AppWithSidebar>
                    </SidebarAnimationProvider>
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
