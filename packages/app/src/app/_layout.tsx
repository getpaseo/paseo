import "@/styles/unistyles";
import { polyfillCrypto } from "@/polyfills/crypto";
import {
  Stack,
  useGlobalSearchParams,
  useNavigationContainerRef,
  usePathname,
  useRouter,
} from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { GestureHandlerRootView, Gesture, GestureDetector } from "react-native-gesture-handler";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { PortalProvider } from "@gorhom/portal";
import { VoiceProvider } from "@/contexts/voice-context";
import { useAppSettings } from "@/hooks/use-settings";
import { useFaviconStatus } from "@/hooks/use-favicon-status";
import { View, Text } from "react-native";
import { UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  getHostRuntimeStore,
  useHosts,
  useHostMutations,
  useHostRuntimeClient,
} from "@/runtime/host-runtime";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { loadSettingsFromStorage } from "@/hooks/use-settings";
import { useColorScheme } from "@/hooks/use-color-scheme";
import { useOpenProject } from "@/hooks/use-open-project";
import { SessionProvider } from "@/contexts/session-context";
import type { HostProfile } from "@/types/host-connection";
import {
  createContext,
  useCallback,
  useContext,
  useState,
  useEffect,
  type ReactNode,
  useMemo,
  useRef,
} from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { LeftSidebar } from "@/components/left-sidebar";
import { DownloadToast } from "@/components/download-toast";
import { UpdateBanner } from "@/desktop/updates/update-banner";
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
import { getIsElectronRuntime, isCompactFormFactor } from "@/constants/layout";
import { CommandCenter } from "@/components/command-center";
import { ProjectPickerModal } from "@/components/project-picker-modal";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { queryClient } from "@/query/query-client";
import {
  WEB_NOTIFICATION_CLICK_EVENT,
  type WebNotificationClickDetail,
  ensureOsNotificationPermission,
} from "@/utils/os-notifications";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { updateDesktopWindowControls } from "@/desktop/electron/window";
import { buildNotificationRoute } from "@/utils/notification-routing";
import {
  buildHostRootRoute,
  mapPathnameToServer,
  parseServerIdFromPathname,
  parseHostAgentRouteFromPathname,
  parseWorkspaceOpenIntent,
} from "@/utils/host-routes";
import { syncNavigationActiveWorkspace } from "@/stores/navigation-active-workspace-store";

polyfillCrypto();

export type HostRuntimeBootstrapState = {
  phase: "starting-daemon" | "connecting" | "online" | "error";
  error: string | null;
  retry: () => void;
};

const HostRuntimeBootstrapContext = createContext<HostRuntimeBootstrapState>({
  phase: "starting-daemon",
  error: null,
  retry: () => {},
});

function PushNotificationRouter() {
  const router = useRouter();
  const lastHandledIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (Platform.OS === "web") {
      let removeDesktopNotificationListener: (() => void) | null = null;
      let cancelled = false;

      if (getIsElectronRuntime()) {
        void ensureOsNotificationPermission();

        const unlistenResult = getDesktopHost()?.events?.on?.(
          "notification-click",
          (payload: unknown) => {
            const data =
              typeof payload === "object" &&
              payload !== null &&
              "data" in payload &&
              typeof (payload as { data?: unknown }).data === "object" &&
              (payload as { data?: unknown }).data !== null
                ? (payload as { data: Record<string, unknown> }).data
                : undefined;
            router.push(buildNotificationRoute(data) as any);
          },
        );

        void Promise.resolve(unlistenResult).then((unlisten) => {
          if (typeof unlisten !== "function") {
            return;
          }
          if (cancelled) {
            unlisten();
            return;
          }
          removeDesktopNotificationListener = unlisten;
        });
      }

      const target = globalThis as unknown as EventTarget;
      const openFromWebClick = (event: Event) => {
        const customEvent = event as CustomEvent<WebNotificationClickDetail>;
        event.preventDefault();
        router.push(buildNotificationRoute(customEvent.detail?.data) as any);
      };

      target.addEventListener(WEB_NOTIFICATION_CLICK_EVENT, openFromWebClick as EventListener);

      return () => {
        cancelled = true;
        removeDesktopNotificationListener?.();
        target.removeEventListener(WEB_NOTIFICATION_CLICK_EVENT, openFromWebClick as EventListener);
      };
    }

    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        // When the app is open, don't show OS banners.
        shouldShowAlert: false,
        shouldShowBanner: false,
        shouldShowList: false,
        shouldPlaySound: false,
        shouldSetBadge: false,
      }),
    });

    const openFromResponse = (response: Notifications.NotificationResponse) => {
      const identifier = response.notification.request.identifier;
      if (lastHandledIdRef.current === identifier) {
        return;
      }
      lastHandledIdRef.current = identifier;

      const data = response.notification.request.content.data as
        | Record<string, unknown>
        | undefined;
      router.push(buildNotificationRoute(data) as any);
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(openFromResponse);

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        openFromResponse(response);
      }
    });

    return () => {
      subscription.remove();
    };
  }, [router]);

  return null;
}

function ManagedDaemonSession({ daemon }: { daemon: HostProfile }) {
  const client = useHostRuntimeClient(daemon.serverId);

  if (!client) {
    return null;
  }

  return (
    <SessionProvider key={daemon.serverId} serverId={daemon.serverId} client={client}>
      {null}
    </SessionProvider>
  );
}

function HostSessionManager() {
  const hosts = useHosts();

  if (hosts.length === 0) {
    return null;
  }

  return (
    <>
      {hosts.map((daemon) => (
        <ManagedDaemonSession key={daemon.serverId} daemon={daemon} />
      ))}
    </>
  );
}

function HostRuntimeBootstrapProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<HostRuntimeBootstrapState["phase"]>("starting-daemon");
  const [error, setError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const retry = useCallback(() => {
    setPhase("starting-daemon");
    setError(null);
    setRetryToken((current) => current + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    let cancelAnyOnline: (() => void) | null = null;
    const shouldManageDesktop = shouldUseDesktopDaemon();
    const store = getHostRuntimeStore();

    const init = async () => {
      const settings = await loadSettingsFromStorage();
      const isDesktopManaged = shouldManageDesktop && settings.manageBuiltInDaemon;
      await store.loadFromStorage();
      if (isDesktopManaged) {
        setPhase("starting-daemon");
        setError(null);

        let raceSettled = false;

        const anyOnline = store.waitForAnyConnectionOnline();
        cancelAnyOnline = anyOnline.cancel;

        const bootstrapPromise = (async (): Promise<
          { type: "online" } | { type: "error"; error: string }
        > => {
          try {
            const bootstrapResult = await store.bootstrapDesktop();
            if (!bootstrapResult.ok) {
              return { type: "error", error: bootstrapResult.error };
            }
            if (!cancelled && !raceSettled) {
              setPhase("connecting");
            }
            await store.addConnectionFromListenAndWaitForOnline({
              listenAddress: bootstrapResult.listenAddress,
              serverId: bootstrapResult.serverId,
              hostname: bootstrapResult.hostname,
            });
            return { type: "online" };
          } catch (err) {
            return {
              type: "error",
              error: err instanceof Error ? err.message : String(err),
            };
          }
        })();

        const result = await Promise.race([
          anyOnline.promise.then((): { type: "online" } => ({ type: "online" })),
          bootstrapPromise,
        ]);

        raceSettled = true;
        anyOnline.cancel();

        if (!cancelled) {
          if (result.type === "online") {
            setPhase("online");
            setError(null);
          } else {
            setPhase("error");
            setError(result.error);
          }
        }
      } else {
        void store.bootstrap({ manageBuiltInDaemon: settings.manageBuiltInDaemon });
        if (!cancelled) {
          setPhase("online");
          setError(null);
        }
      }
    };

    void init().catch((bootstrapError) => {
      console.error("[HostRuntime] Failed to initialize store", bootstrapError);
      if (cancelled) {
        return;
      }
      if (shouldManageDesktop) {
        setPhase("error");
        setError(bootstrapError instanceof Error ? bootstrapError.message : String(bootstrapError));
        return;
      }
      setPhase("online");
      setError(null);
    });

    return () => {
      cancelled = true;
      cancelAnyOnline?.();
    };
  }, [retryToken]);

  const state = useMemo<HostRuntimeBootstrapState>(
    () => ({
      phase,
      error,
      retry,
    }),
    [error, phase, retry],
  );

  return (
    <HostRuntimeBootstrapContext.Provider value={state}>
      {children}
    </HostRuntimeBootstrapContext.Provider>
  );
}

export function useStoreReady(): boolean {
  return useContext(HostRuntimeBootstrapContext).phase === "online";
}

export function useHostRuntimeBootstrapState(): HostRuntimeBootstrapState {
  return useContext(HostRuntimeBootstrapContext);
}

function QueryProvider({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

const rowStyle = { flex: 1, flexDirection: "row" } as const;
const flexStyle = { flex: 1 } as const;

interface AppContainerProps {
  children: ReactNode;
  selectedAgentId?: string;
  chromeEnabled?: boolean;
}

function AppContainer({
  children,
  selectedAgentId,
  chromeEnabled: chromeEnabledOverride,
}: AppContainerProps) {
  const { theme } = useUnistyles();
  const daemons = useHosts();
  const toggleAgentList = usePanelStore((state) => state.toggleAgentList);
  const toggleFileExplorer = usePanelStore((state) => state.toggleFileExplorer);
  const toggleBothSidebars = usePanelStore((state) => state.toggleBothSidebars);
  const toggleFocusMode = usePanelStore((state) => state.toggleFocusMode);
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const agentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);

  const isCompactLayout = isCompactFormFactor();
  const chromeEnabled = chromeEnabledOverride ?? daemons.length > 0;

  useEffect(() => {
    const bp = UnistylesRuntime.breakpoint;
    const screenW = UnistylesRuntime.screen.width;
    const screenH = UnistylesRuntime.screen.height;
    const isElectron = getIsElectronRuntime();
    const windowW = Platform.OS === "web" ? window.innerWidth : undefined;
    const windowH = Platform.OS === "web" ? window.innerHeight : undefined;
    const dpr = Platform.OS === "web" ? window.devicePixelRatio : undefined;
    const ua = Platform.OS === "web" ? navigator.userAgent : undefined;

    console.log(
      "[layout-debug]",
      JSON.stringify({
        breakpoint: bp,
        isCompactLayout,
        isElectron,
        chromeEnabled,
        isFocusModeEnabled,
        agentListOpen,
        sidebarWidth,
        sidebarRenderedInRow: !isCompactLayout && chromeEnabled && !isFocusModeEnabled,
        unistylesScreen: { w: screenW, h: screenH },
        window: { w: windowW, h: windowH },
        devicePixelRatio: dpr,
        userAgent: ua,
      }),
    );
  }, [isCompactLayout, chromeEnabled, isFocusModeEnabled, agentListOpen, sidebarWidth]);

  useKeyboardShortcuts({
    enabled: chromeEnabled,
    isMobile: isCompactLayout,
    toggleAgentList,
    selectedAgentId,
    toggleFileExplorer,
    toggleBothSidebars,
    toggleFocusMode,
  });

  const containerStyle = useMemo(
    () => ({ flex: 1 as const, backgroundColor: theme.colors.surface0 }),
    [theme.colors.surface0],
  );

  const content = (
    <View style={containerStyle}>
      <View style={rowStyle}>
        {!isCompactLayout && chromeEnabled && !isFocusModeEnabled && (
          <LeftSidebar selectedAgentId={selectedAgentId} />
        )}
        <View style={flexStyle}>{children}</View>
      </View>
      {isCompactLayout && chromeEnabled && <LeftSidebar selectedAgentId={selectedAgentId} />}
      <DownloadToast />
      <UpdateBanner />
      <CommandCenter />
      <ProjectPickerModal />
      <KeyboardShortcutsDialog />
    </View>
  );

  if (!isCompactLayout) {
    return content;
  }

  return <MobileGestureWrapper chromeEnabled={chromeEnabled}>{content}</MobileGestureWrapper>;
}

function MobileGestureWrapper({
  children,
  chromeEnabled,
}: {
  children: ReactNode;
  chromeEnabled: boolean;
}) {
  const mobileView = usePanelStore((state) => state.mobileView);
  const openAgentList = usePanelStore((state) => state.openAgentList);
  const horizontalScroll = useHorizontalScrollOptional();
  const {
    translateX,
    backdropOpacity,
    windowWidth,
    animateToOpen,
    animateToClose,
    isGesturing,
    gestureAnimatingRef,
    openGestureRef,
  } = useSidebarAnimation();
  const touchStartX = useSharedValue(0);
  const openGestureEnabled = chromeEnabled && mobileView === "agent";

  const handleGestureOpen = useCallback(() => {
    gestureAnimatingRef.current = true;
    openAgentList();
  }, [openAgentList, gestureAnimatingRef]);

  const openGesture = useMemo(
    () =>
      Gesture.Pan()
        .withRef(openGestureRef)
        .enabled(openGestureEnabled)
        .manualActivation(true)
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

          if (horizontalScroll?.isAnyScrolledRight.value) {
            stateManager.fail();
            return;
          }

          if (deltaX > 15) {
            stateManager.activate();
          }
        })
        .onStart(() => {
          isGesturing.value = true;
        })
        .onUpdate((event) => {
          const newTranslateX = Math.min(0, -windowWidth + event.translationX);
          translateX.value = newTranslateX;
          backdropOpacity.value = interpolate(
            newTranslateX,
            [-windowWidth, 0],
            [0, 1],
            Extrapolation.CLAMP,
          );
        })
        .onEnd((event) => {
          isGesturing.value = false;
          const shouldOpen = event.translationX > windowWidth / 3 || event.velocityX > 500;
          if (shouldOpen) {
            animateToOpen();
            runOnJS(handleGestureOpen)();
          } else {
            animateToClose();
          }
        })
        .onFinalize(() => {
          isGesturing.value = false;
        }),
    [
      openGestureEnabled,
      windowWidth,
      translateX,
      backdropOpacity,
      animateToOpen,
      animateToClose,
      handleGestureOpen,
      isGesturing,
      openGestureRef,
      horizontalScroll?.isAnyScrolledRight,
      touchStartX,
    ],
  );

  return (
    <GestureDetector gesture={openGesture} touchAction="pan-y">
      {children}
    </GestureDetector>
  );
}

function ProvidersWrapper({ children }: { children: ReactNode }) {
  const { settings, isLoading: settingsLoading } = useAppSettings();
  const { upsertConnectionFromOfferUrl } = useHostMutations();
  const systemColorScheme = useColorScheme();
  const { theme } = useUnistyles();
  const resolvedTheme = settings.theme === "auto" ? (systemColorScheme ?? "light") : settings.theme;

  // Apply theme setting on mount and when it changes
  useEffect(() => {
    if (settingsLoading) return;
    if (settings.theme === "auto") {
      UnistylesRuntime.setAdaptiveThemes(true);
    } else {
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(settings.theme);
    }
  }, [settingsLoading, settings.theme]);

  useEffect(() => {
    if (settingsLoading || Platform.OS !== "web") {
      return;
    }

    void updateDesktopWindowControls({
      backgroundColor: theme.colors.surface0,
      foregroundColor: theme.colors.foreground,
    }).catch((error) => {
      console.warn("[DesktopWindow] Failed to update window controls overlay", error);
    });
  }, [settingsLoading, resolvedTheme, theme.colors.foreground, theme.colors.surface0]);

  return (
    <VoiceProvider>
      <OfferLinkListener upsertDaemonFromOfferUrl={upsertConnectionFromOfferUrl} />
      <HostSessionManager />
      <FaviconStatusSync />
      {children}
    </VoiceProvider>
  );
}

function OfferLinkListener({
  upsertDaemonFromOfferUrl,
}: {
  upsertDaemonFromOfferUrl: (offerUrlOrFragment: string) => Promise<unknown>;
}) {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    const handleUrl = (url: string | null) => {
      if (!url) return;
      if (!url.includes("#offer=")) return;
      void upsertDaemonFromOfferUrl(url)
        .then((profile) => {
          if (cancelled) return;
          const serverId = (profile as any)?.serverId;
          if (typeof serverId !== "string" || !serverId) return;
          router.replace(buildHostRootRoute(serverId));
        })
        .catch((error) => {
          if (cancelled) return;
          console.warn("[Linking] Failed to import pairing offer", error);
        });
    };

    void Linking.getInitialURL()
      .then(handleUrl)
      .catch(() => undefined);

    const subscription = Linking.addEventListener("url", (event) => {
      handleUrl(event.url);
    });

    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [router, upsertDaemonFromOfferUrl]);

  return null;
}

interface OpenProjectEventPayload {
  path?: unknown;
}

function OpenProjectListener() {
  const hosts = useHosts();
  const serverId = hosts[0]?.serverId ?? null;
  const client = useHostRuntimeClient(serverId ?? "");
  const openProject = useOpenProject(serverId);
  const pendingPathRef = useRef<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    const maybeOpenProject = (inputPath: string) => {
      const nextPath = inputPath.trim();
      if (!nextPath) {
        return;
      }

      pendingPathRef.current = nextPath;

      if (!serverId || !client) {
        return;
      }

      const pathToOpen = pendingPathRef.current;
      pendingPathRef.current = null;
      if (!pathToOpen) {
        return;
      }

      void openProject(pathToOpen).catch(() => undefined);
    };

    // Pull any path that was passed on cold start (before the listener existed).
    // Store in the ref even if this effect instance is disposed — the next
    // effect run picks it up via maybeOpenProject(pendingPathRef.current).
    void getDesktopHost()
      ?.getPendingOpenProject?.()
      ?.then((pending) => {
        if (pending) {
          pendingPathRef.current = pending;
        }
        if (!disposed && pending) {
          maybeOpenProject(pending);
        }
      })
      .catch(() => undefined);

    // Listen for hot-start paths relayed via the second-instance event.
    void listenToDesktopEvent<OpenProjectEventPayload>("open-project", (payload) => {
      if (disposed) {
        return;
      }
      const nextPath = typeof payload?.path === "string" ? payload.path.trim() : "";
      maybeOpenProject(nextPath);
    })
      .then((dispose) => {
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
      })
      .catch(() => undefined);

    maybeOpenProject(pendingPathRef.current ?? "");

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [client, openProject, serverId]);

  return null;
}

function AppWithSidebar({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useGlobalSearchParams<{ open?: string | string[] }>();
  const hosts = useHosts();
  const activeServerId = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  const shouldShowAppChrome = activeServerId !== null;

  useEffect(() => {
    if (!activeServerId || hosts.length === 0) {
      return;
    }
    if (hosts.some((host) => host.serverId === activeServerId)) {
      return;
    }
    router.replace(mapPathnameToServer(pathname, hosts[0]!.serverId));
  }, [activeServerId, hosts, pathname, router]);

  // Parse selectedAgentKey directly from pathname
  // useLocalSearchParams doesn't update when navigating between same-pattern routes
  const selectedAgentKey = useMemo(() => {
    const workspaceMatch = pathname.match(/^\/h\/([^/]+)\/workspace\/[^/]+(?:\/|$)/);
    const workspaceServerId = workspaceMatch?.[1]?.trim() ?? "";
    const openValue = Array.isArray(params.open) ? params.open[0] : params.open;
    const openIntent = parseWorkspaceOpenIntent(openValue);
    if (workspaceServerId && openIntent?.kind === "agent") {
      const agentId = openIntent.agentId.trim();
      return agentId ? `${workspaceServerId}:${agentId}` : undefined;
    }

    const match = parseHostAgentRouteFromPathname(pathname);
    return match ? `${match.serverId}:${match.agentId}` : undefined;
  }, [params.open, pathname]);

  return (
    <AppContainer
      selectedAgentId={shouldShowAppChrome ? selectedAgentKey : undefined}
      chromeEnabled={shouldShowAppChrome}
    >
      {children}
    </AppContainer>
  );
}

function FaviconStatusSync() {
  useFaviconStatus();
  return null;
}

function RootStack() {
  const storeReady = useStoreReady();
  const { theme } = useUnistyles();

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        animation: "none",
        contentStyle: {
          backgroundColor: theme.colors.surface0,
        },
      }}
    >
      <Stack.Protected guard={storeReady}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="settings" />
        <Stack.Screen name="h/[serverId]/workspace/[workspaceId]" />
        <Stack.Screen
          name="h/[serverId]/agent/[agentId]"
          options={{ gestureEnabled: false }}
        />
        <Stack.Screen name="h/[serverId]/index" />
        <Stack.Screen name="h/[serverId]/sessions" />
        <Stack.Screen name="h/[serverId]/open-project" />
        <Stack.Screen name="h/[serverId]/settings" />
        <Stack.Screen name="pair-scan" />
      </Stack.Protected>
      <Stack.Screen name="index" />
    </Stack>
  );
}

function NavigationActiveWorkspaceObserver() {
  const navigationRef = useNavigationContainerRef();

  useEffect(() => {
    syncNavigationActiveWorkspace(navigationRef);
    const unsubscribeState = navigationRef.addListener("state", () => {
      syncNavigationActiveWorkspace(navigationRef);
    });
    const unsubscribeReady = navigationRef.addListener("ready" as never, () => {
      syncNavigationActiveWorkspace(navigationRef);
    });
    return () => {
      unsubscribeState();
      unsubscribeReady();
    };
  }, [navigationRef]);

  return null;
}

export default function RootLayout() {
  const { theme } = useUnistyles();

  return (
    <GestureHandlerRootView style={{ flex: 1, backgroundColor: theme.colors.surface0 }}>
      <NavigationActiveWorkspaceObserver />
      <PortalProvider>
        <SafeAreaProvider>
          <KeyboardProvider>
            <QueryProvider>
              <BottomSheetModalProvider>
                <HostRuntimeBootstrapProvider>
                  <PushNotificationRouter />
                  <ProvidersWrapper>
                    <SidebarAnimationProvider>
                      <HorizontalScrollProvider>
                        <ToastProvider>
                          <OpenProjectListener />
                          <AppWithSidebar>
                            <RootStack />
                          </AppWithSidebar>
                        </ToastProvider>
                      </HorizontalScrollProvider>
                    </SidebarAnimationProvider>
                  </ProvidersWrapper>
                </HostRuntimeBootstrapProvider>
              </BottomSheetModalProvider>
            </QueryProvider>
          </KeyboardProvider>
        </SafeAreaProvider>
      </PortalProvider>
    </GestureHandlerRootView>
  );
}
