import "@/styles/unistyles";
import { Stack, usePathname } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView, Gesture, GestureDetector } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { PortalProvider } from "@gorhom/portal";
import { VoiceProvider } from "@/contexts/voice-context";
import { useAppSettings } from "@/hooks/use-settings";
import { useFaviconStatus } from "@/hooks/use-favicon-status";
import { View, ActivityIndicator, Text } from "react-native";
import { UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { darkTheme } from "@/styles/theme";
import { DaemonRegistryProvider, useDaemonRegistry } from "@/contexts/daemon-registry-context";
import { DaemonConnectionsProvider } from "@/contexts/daemon-connections-context";
import { MultiDaemonSessionHost } from "@/components/multi-daemon-session-host";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, useEffect, type ReactNode, useMemo } from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import { SlidingSidebar } from "@/components/sliding-sidebar";
import { DownloadToast } from "@/components/download-toast";
import { ToastProvider } from "@/contexts/toast-context";
import { usePanelStore } from "@/stores/panel-store";
import { runOnJS, interpolate, Extrapolation, useSharedValue } from "react-native-reanimated";
import {
  SidebarAnimationProvider,
  useSidebarAnimation,
} from "@/contexts/sidebar-animation-context";
import {
  HorizontalScrollProvider,
  useHorizontalScrollOptional,
} from "@/contexts/horizontal-scroll-context";
import { getIsTauriMac } from "@/constants/layout";
import { useTrafficLightPadding } from "@/utils/tauri-window";

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
  const { daemons } = useDaemonRegistry();
  const mobileView = usePanelStore((state) => state.mobileView);
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const openAgentList = usePanelStore((state) => state.openAgentList);
  const toggleAgentList = usePanelStore((state) => state.toggleAgentList);
  const horizontalScroll = useHorizontalScrollOptional();

  const isMobile =
    UnistylesRuntime.breakpoint === "xs" || UnistylesRuntime.breakpoint === "sm";
  const chromeEnabled = daemons.length > 0;
  const isOpen = chromeEnabled
    ? isMobile
      ? mobileView === "agent-list"
      : desktopAgentListOpen
    : false;

  // Cmd+B to toggle sidebar (web only)
  useEffect(() => {
    if (!chromeEnabled) return;
    if (Platform.OS !== "web") return;
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "b") {
        event.preventDefault();
        toggleAgentList();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [chromeEnabled, toggleAgentList]);
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
  } = useSidebarAnimation();

  // Track initial touch position for manual activation
  const touchStartX = useSharedValue(0);

  // Open gesture: swipe right from anywhere to open sidebar (interactive drag)
  // If any horizontal scroll is scrolled right, let the scroll view handle the gesture first
  const openGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(chromeEnabled && isMobile && !isOpen)
        .manualActivation(true)
        // Fail if 10px vertical movement happens first (allow vertical scroll)
        .failOffsetY([-10, 10])
        .onTouchesDown((event) => {
          const touch = event.changedTouches[0];
          if (touch) {
            touchStartX.value = touch.absoluteX;
          }
        })
        .onTouchesMove((event, stateManager) => {
          const touch = event.changedTouches[0];
          if (!touch || event.numberOfTouches !== 1) return;

          const deltaX = touch.absoluteX - touchStartX.value;

          // If horizontal scroll is scrolled right, fail so ScrollView handles it
          if (horizontalScroll?.isAnyScrolledRight.value) {
            stateManager.fail();
            return;
          }

          // Activate after 15px rightward movement
          if (deltaX > 15) {
            stateManager.activate();
          }
        })
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
            runOnJS(openAgentList)();
          } else {
            animateToClose();
          }
        })
        .onFinalize(() => {
          isGesturing.value = false;
        }),
    [
      chromeEnabled,
      isMobile,
      isOpen,
      windowWidth,
      translateX,
      backdropOpacity,
      animateToOpen,
      animateToClose,
      openAgentList,
      isGesturing,
      horizontalScroll?.isAnyScrolledRight,
      touchStartX,
    ]
  );

  // When sidebar is collapsed on desktop Tauri macOS, add left padding for traffic lights
  const trafficLightPadding = useTrafficLightPadding();
  const needsTrafficLightPadding = !isMobile && !isOpen && getIsTauriMac();

  const content = (
    <View style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <View style={{ flex: 1, flexDirection: "row" }}>
        {!isMobile && chromeEnabled && <SlidingSidebar selectedAgentId={selectedAgentId} />}
        <View style={{ flex: 1, paddingLeft: needsTrafficLightPadding ? trafficLightPadding.left : 0 }}>
          {children}
        </View>
      </View>
      {isMobile && chromeEnabled && <SlidingSidebar selectedAgentId={selectedAgentId} />}
      <DownloadToast />
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
  const { settings, isLoading: settingsLoading } = useAppSettings();
  const { daemons, isLoading: registryLoading, upsertDaemonFromOfferUrl } = useDaemonRegistry();
  const isLoading = settingsLoading || registryLoading;

  // Apply theme setting on mount and when it changes
  useEffect(() => {
    if (isLoading) return;
    if (settings.theme === "auto") {
      UnistylesRuntime.setAdaptiveThemes(true);
    } else {
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(settings.theme);
    }
  }, [isLoading, settings.theme]);

  if (isLoading) {
    return <LoadingView />;
  }

  return (
    <VoiceProvider>
      <OfferLinkListener upsertDaemonFromOfferUrl={upsertDaemonFromOfferUrl} />
      {children}
    </VoiceProvider>
  );
}

function OfferLinkListener({
  upsertDaemonFromOfferUrl,
}: {
  upsertDaemonFromOfferUrl: (offerUrlOrFragment: string) => Promise<unknown>;
}) {
  useEffect(() => {
    let cancelled = false;
    const handleUrl = (url: string | null) => {
      if (!url) return;
      if (!url.includes("#offer=")) return;
      void upsertDaemonFromOfferUrl(url).catch((error) => {
        if (cancelled) return;
        console.warn("[Linking] Failed to import pairing offer", error);
      });
    };

    void Linking.getInitialURL().then(handleUrl).catch(() => undefined);

    const subscription = Linking.addEventListener("url", (event) => {
      handleUrl(event.url);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [upsertDaemonFromOfferUrl]);

  return null;
}

function AppWithSidebar({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  useFaviconStatus();

  // Parse selectedAgentKey directly from pathname
  // useLocalSearchParams doesn't update when navigating between same-pattern routes
  const selectedAgentKey = useMemo(() => {
    // Match /agent/[serverId]/[agentId] pattern
    const match = pathname.match(/^\/agent\/([^/]+)\/([^/]+)\/?$/);
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
        backgroundColor: darkTheme.colors.surface0,
      }}
    >
      <ActivityIndicator size="large" color={darkTheme.colors.foreground} />
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
        backgroundColor: darkTheme.colors.surface0,
      }}
    >
      <ActivityIndicator size="small" color={darkTheme.colors.foreground} />
      <Text
        style={{
          color: darkTheme.colors.foreground,
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
      <PortalProvider>
        <SafeAreaProvider>
          <KeyboardProvider>
            <BottomSheetModalProvider>
              <QueryProvider>
                <DaemonRegistryProvider>
                  <DaemonConnectionsProvider>
                    <MultiDaemonSessionHost />
                    <ProvidersWrapper>
                      <SidebarAnimationProvider>
                        <HorizontalScrollProvider>
                          <ToastProvider>
                            <AppWithSidebar>
                              <Stack
                                screenOptions={{
                                  headerShown: false,
                                  animation: "none",
                                }}
                              >
                                <Stack.Screen name="index" />
                                <Stack.Screen name="agents" />
                                <Stack.Screen name="agent" />
                                <Stack.Screen name="agent/[id]" options={{ gestureEnabled: false }} />
                                <Stack.Screen
                                  name="agent/[serverId]/[agentId]"
                                  options={{ gestureEnabled: false }}
                                />
                                <Stack.Screen name="settings" />
                                <Stack.Screen name="audio-test" />
                                <Stack.Screen name="pair-scan" />
                              </Stack>
                            </AppWithSidebar>
                          </ToastProvider>
                        </HorizontalScrollProvider>
                      </SidebarAnimationProvider>
                    </ProvidersWrapper>
                  </DaemonConnectionsProvider>
                </DaemonRegistryProvider>
              </QueryProvider>
            </BottomSheetModalProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </PortalProvider>
    </GestureHandlerRootView>
  );
}
