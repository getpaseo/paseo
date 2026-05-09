import "@/styles/unistyles";
import { PortalProvider } from "@gorhom/portal";
import { QueryClientProvider } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Stack, useGlobalSearchParams, usePathname, useRouter } from "expo-router";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { View } from "react-native";
import { Gesture, GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { Extrapolation, interpolate, runOnJS, useSharedValue } from "react-native-reanimated";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { CommandCenter } from "@/components/command-center";
import { WorktreeSetupCalloutSource } from "@/components/worktree-setup-callout-source";
import { DownloadToast } from "@/components/download-toast";
import { QuittingOverlay } from "@/components/quitting-overlay";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { LeftSidebar } from "@/components/left-sidebar";
import { ProjectPickerModal } from "@/components/project-picker-modal";
import { WorkspaceSetupDialog } from "@/components/workspace-setup-dialog";
import { WorkspaceShortcutTargetsSubscriber } from "@/components/workspace-shortcut-targets-subscriber";
import { getIsElectronRuntime, useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import {
  HorizontalScrollProvider,
  useHorizontalScrollOptional,
} from "@/contexts/horizontal-scroll-context";
import { SessionProvider } from "@/contexts/session-context";
import {
  SidebarAnimationProvider,
  useSidebarAnimation,
} from "@/contexts/sidebar-animation-context";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { ToastProvider } from "@/contexts/toast-context";
import { VoiceProvider } from "@/contexts/voice-context";
import { startDaemonIfGateAllows, startHostRuntimeBootstrap } from "@/app/host-runtime-bootstrap";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { updateDesktopWindowControls } from "@/desktop/electron/window";
import { getDesktopHost } from "@/desktop/host";
import { loadDesktopSettings } from "@/desktop/settings/desktop-settings";
import { RosettaCalloutSource } from "@/desktop/updates/rosetta-callout-source";
import { UpdateCalloutSource } from "@/desktop/updates/update-callout-source";
import { useActiveWorktreeNewAction } from "@/hooks/use-active-worktree-new-action";
import { useFaviconStatus } from "@/hooks/use-favicon-status";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { useLatchedBoolean } from "@/hooks/use-latched-boolean";
import { useOpenProject } from "@/hooks/use-open-project";
import { useAppSettings } from "@/hooks/use-settings";
import { useStableEvent } from "@/hooks/use-stable-event";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { polyfillCrypto } from "@/polyfills/crypto";
import { queryClient } from "@/query/query-client";
import {
  getHostRuntimeStore,
  hasConfiguredLocalDaemonOverride,
  useHostMutations,
  useHostRuntimeClient,
  useHosts,
} from "@/runtime/host-runtime";
import { getDaemonStartService } from "@/runtime/daemon-start-service";
import { usePanelStore } from "@/stores/panel-store";
import { THEME_TO_UNISTYLES, type ThemeName } from "@/styles/theme";
import type { HostProfile } from "@/types/host-connection";
import { resolveActiveHost } from "@/utils/active-host";
import { toggleDesktopSidebarsWithCheckoutIntent } from "@/utils/desktop-sidebar-toggle";
import {
  buildHostRootRoute,
  mapPathnameToServer,
  parseHostAgentRouteFromPathname,
  parseServerIdFromPathname,
  parseWorkspaceOpenIntent,
} from "@/utils/host-routes";
import { buildNotificationRoute, resolveNotificationTarget } from "@/utils/notification-routing";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import {
  ensureOsNotificationPermission,
  WEB_NOTIFICATION_CLICK_EVENT,
  type WebNotificationClickDetail,
} from "@/utils/os-notifications";

polyfillCrypto();

export interface HostRuntimeBootstrapState {
  splashError: string | null;
  retry: () => void;
  hasGivenUpWaitingForHost: boolean;
  storeReady: boolean;
}

const HostRuntimeBootstrapContext = createContext<HostRuntimeBootstrapState>({
  splashError: null,
  retry: () => {},
  hasGivenUpWaitingForHost: false,
  storeReady: false,
});

function PushNotificationRouter() {
  const router = useRouter();
  const pathname = usePathname();
  const lastHandledIdRef = useRef<string | null>(null);
  const openNotification = useStableEvent((data: Record<string, unknown> | undefined) => {
    const target = resolveNotificationTarget(data);
    const serverId = target.serverId;
    const agentId = target.agentId;
    if (serverId && agentId) {
      navigateToAgent({ serverId, agentId, currentPathname: pathname, pin: true });
      return;
    }

    router.navigate(buildNotificationRoute(data));
  });

  useEffect(() => {
    if (isWeb) {
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
            openNotification(data);
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
          return;
        });
      }

      const openFromWebClick = (event: Event) => {
        const customEvent = event as CustomEvent<WebNotificationClickDetail>;
        event.preventDefault();
        openNotification(customEvent.detail?.data);
      };

      window.addEventListener(WEB_NOTIFICATION_CLICK_EVENT, openFromWebClick as EventListener);

      return () => {
        cancelled = true;
        removeDesktopNotificationListener?.();
        window.removeEventListener(WEB_NOTIFICATION_CLICK_EVENT, openFromWebClick as EventListener);
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
      openNotification(data);
    };

    const subscription = Notifications.addNotificationResponseReceivedListener(openFromResponse);

    void Notifications.getLastNotificationResponseAsync().then((response) => {
      if (response) {
        openFromResponse(response);
      }
      return;
    });

    return () => {
      subscription.remove();
    };
  }, [openNotification]);

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

export function useEarliestOnlineHostServerId(): string | null {
  const store = getHostRuntimeStore();
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribeAll = store.subscribeAll(listener);
      const unsubscribeHostList = store.subscribeHostList(listener);
      return () => {
        unsubscribeAll();
        unsubscribeHostList();
      };
    },
    [store],
  );
  return useSyncExternalStore(
    subscribe,
    () => store.getEarliestOnlineHostServerId(),
    () => store.getEarliestOnlineHostServerId(),
  );
}

function useDaemonStartLastError(): string | null {
  const service = getDaemonStartService({ store: getHostRuntimeStore() });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.getLastError(),
    () => service.getLastError(),
  );
}

function useDaemonStartIsRunning(): boolean {
  const service = getDaemonStartService({ store: getHostRuntimeStore() });
  return useSyncExternalStore(
    (listener) => service.subscribe(listener),
    () => service.isRunning(),
    () => service.isRunning(),
  );
}

const STARTUP_GIVE_UP_TIMEOUT_MS = 5_000;

async function shouldStartBuiltInDaemon(): Promise<boolean> {
  if (!shouldUseDesktopDaemon()) {
    return false;
  }
  const settings = await loadDesktopSettings();
  return settings.daemon.manageBuiltInDaemon;
}

function HostRuntimeBootstrapProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    const store = getHostRuntimeStore();
    const daemonStartService = getDaemonStartService({ store });
    startHostRuntimeBootstrap({
      store,
      daemonStartService,
      shouldStartDaemon: shouldStartBuiltInDaemon,
      onGateError: (message) => daemonStartService.recordError(message),
    });
  }, []);

  const anyOnlineHostServerId = useEarliestOnlineHostServerId();
  const daemonStartError = useDaemonStartLastError();
  const daemonStartIsRunning = useDaemonStartIsRunning();
  const waitForConfiguredLocalDaemon =
    hasConfiguredLocalDaemonOverride() && !shouldUseDesktopDaemon();

  const [hasGivenUpWaitingForHost, setHasGivenUpWaitingForHost] = useState(false);
  useEffect(() => {
    if (
      anyOnlineHostServerId ||
      daemonStartError ||
      daemonStartIsRunning ||
      waitForConfiguredLocalDaemon ||
      hasGivenUpWaitingForHost
    ) {
      return;
    }
    const handle = setTimeout(() => {
      setHasGivenUpWaitingForHost(true);
    }, STARTUP_GIVE_UP_TIMEOUT_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [
    anyOnlineHostServerId,
    daemonStartError,
    daemonStartIsRunning,
    waitForConfiguredLocalDaemon,
    hasGivenUpWaitingForHost,
  ]);

  const retry = useCallback(() => {
    const daemonStartService = getDaemonStartService({ store: getHostRuntimeStore() });
    startDaemonIfGateAllows({
      daemonStartService,
      shouldStartDaemon: shouldStartBuiltInDaemon,
      onGateError: (message) => daemonStartService.recordError(message),
    });
  }, []);

  const splashError = !anyOnlineHostServerId ? daemonStartError : null;
  const isCurrentlyStoreReady =
    Boolean(anyOnlineHostServerId) || Boolean(splashError) || hasGivenUpWaitingForHost;
  const storeReady = useLatchedBoolean(isCurrentlyStoreReady);

  const state = useMemo<HostRuntimeBootstrapState>(
    () => ({ splashError, retry, hasGivenUpWaitingForHost, storeReady }),
    [splashError, retry, hasGivenUpWaitingForHost, storeReady],
  );

  return (
    <HostRuntimeBootstrapContext.Provider value={state}>
      {children}
    </HostRuntimeBootstrapContext.Provider>
  );
}

export function useStoreReady(): boolean {
  return useContext(HostRuntimeBootstrapContext).storeReady;
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

const THEME_CYCLE_ORDER: ThemeName[] = ["dark", "zinc", "midnight", "claude", "ghostty", "light"];

function AppContainer({
  children,
  selectedAgentId,
  chromeEnabled: chromeEnabledOverride,
}: AppContainerProps) {
  const daemons = useHosts();
  const { settings, updateSettings } = useAppSettings();
  const toggleMobileAgentList = usePanelStore((state) => state.toggleMobileAgentList);
  const toggleDesktopAgentList = usePanelStore((state) => state.toggleDesktopAgentList);
  const openDesktopAgentList = usePanelStore((state) => state.openDesktopAgentList);
  const closeDesktopAgentList = usePanelStore((state) => state.closeDesktopAgentList);
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const toggleFocusMode = usePanelStore((state) => state.toggleFocusMode);
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);

  const cycleTheme = useCallback(() => {
    const currentIndex = THEME_CYCLE_ORDER.indexOf(settings.theme as ThemeName);
    const nextIndex = (currentIndex + 1) % THEME_CYCLE_ORDER.length;
    void updateSettings({ theme: THEME_CYCLE_ORDER[nextIndex] });
  }, [settings.theme, updateSettings]);

  const isCompactLayout = useIsCompactFormFactor();
  const chromeEnabled = chromeEnabledOverride ?? daemons.length > 0;
  const pathname = usePathname();
  const activeServerId = useMemo(
    () => resolveActiveHost({ hosts: daemons, pathname })?.serverId ?? null,
    [daemons, pathname],
  );
  const toggleAgentList = isCompactLayout ? toggleMobileAgentList : toggleDesktopAgentList;
  const toggleDesktopSidebars = useCallback(() => {
    const { desktop } = usePanelStore.getState();
    toggleDesktopSidebarsWithCheckoutIntent({
      isAgentListOpen: desktop.agentListOpen,
      isFileExplorerOpen: desktop.fileExplorerOpen,
      openAgentList: openDesktopAgentList,
      closeAgentList: closeDesktopAgentList,
      closeFileExplorer: closeDesktopFileExplorer,
      toggleFocusedFileExplorer: () =>
        keyboardActionDispatcher.dispatch({
          id: "sidebar.toggle.right",
          scope: "sidebar",
        }),
    });
  }, [closeDesktopAgentList, closeDesktopFileExplorer, openDesktopAgentList]);
  // TODO: stop matching pathname here as a branch. `chromeEnabled` should not
  // conflate workspace/project-specific chrome (sidebar, mobile gesture) with
  // global concerns like keyboard shortcuts. Split those out so settings (and
  // other non-workspace routes) don't need a special-case to keep shortcuts alive.
  const keyboardShortcutsEnabled = chromeEnabled || pathname.startsWith("/settings");

  useKeyboardShortcuts({
    enabled: keyboardShortcutsEnabled,
    isMobile: isCompactLayout,
    toggleAgentList,
    toggleBothSidebars: toggleDesktopSidebars,
    toggleFocusMode,
    cycleTheme,
  });

  useActiveWorktreeNewAction();

  const content = (
    <View style={layoutStyles.surfaceFill}>
      <View style={rowStyle}>
        {!isCompactLayout && chromeEnabled && !isFocusModeEnabled && (
          <LeftSidebar selectedAgentId={selectedAgentId} />
        )}
        <View style={flexStyle}>{children}</View>
      </View>
      {isCompactLayout && chromeEnabled && <LeftSidebar selectedAgentId={selectedAgentId} />}
      <DownloadToast />
      <RosettaCalloutSource />
      <UpdateCalloutSource />
      <WorktreeSetupCalloutSource />
      <CommandCenter />
      <ProjectPickerModal />
      <WorkspaceShortcutTargetsSubscriber
        enabled={keyboardShortcutsEnabled}
        serverId={activeServerId}
      />
      <WorkspaceSetupDialog />
      <KeyboardShortcutsDialog />
      <QuittingOverlay />
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
  const showMobileAgentList = usePanelStore((state) => state.showMobileAgentList);
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
    showMobileAgentList();
  }, [showMobileAgentList, gestureAnimatingRef]);

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

  // Apply theme setting on mount and when it changes
  useEffect(() => {
    if (settingsLoading) return;
    if (settings.theme === "auto") {
      UnistylesRuntime.setAdaptiveThemes(true);
    } else {
      UnistylesRuntime.setAdaptiveThemes(false);
      UnistylesRuntime.setTheme(THEME_TO_UNISTYLES[settings.theme]);
    }
  }, [settingsLoading, settings.theme]);

  return (
    <VoiceProvider>
      <DesktopWindowControlsSync enabled={!settingsLoading} />
      <OfferLinkListener upsertDaemonFromOfferUrl={upsertConnectionFromOfferUrl} />
      <HostSessionManager />
      <FaviconStatusSync />
      {children}
    </VoiceProvider>
  );
}

function DesktopWindowControlsSync({ enabled }: { enabled: boolean }) {
  const { theme } = useUnistyles();
  const surface0 = theme.colors.surface0;
  const foreground = theme.colors.foreground;

  useEffect(() => {
    if (!enabled || isNative) return;
    void updateDesktopWindowControls({
      backgroundColor: surface0,
      foregroundColor: foreground,
    }).catch((error) => {
      console.warn("[DesktopWindow] Failed to update window controls overlay", error);
    });
  }, [enabled, surface0, foreground]);

  return null;
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
          const serverId = (profile as { serverId?: unknown } | null)?.serverId;
          if (typeof serverId !== "string" || !serverId) return;
          router.replace(buildHostRootRoute(serverId));
          return;
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
        return;
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
        return;
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
  const storeReady = useStoreReady();
  const activeServerId = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  const shouldShowAppChrome =
    storeReady && activeServerId !== null && hosts.some((host) => host.serverId === activeServerId);

  useEffect(() => {
    if (!activeServerId || hosts.length === 0) {
      return;
    }
    if (hosts.some((host) => host.serverId === activeServerId)) {
      return;
    }
    router.replace(mapPathnameToServer(pathname, hosts[0].serverId));
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

const AGENT_SCREEN_OPTIONS = { gestureEnabled: false };

function RootStack() {
  const storeReady = useStoreReady();
  const { theme } = useUnistyles();
  const stackScreenOptions = useMemo(
    () => ({
      headerShown: false,
      animation: "none" as const,
      contentStyle: {
        backgroundColor: theme.colors.surface0,
      },
    }),
    [theme.colors.surface0],
  );
  return (
    <Stack screenOptions={stackScreenOptions}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={storeReady}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/[section]" />
        <Stack.Screen name="settings/projects/index" />
        <Stack.Screen name="settings/projects/[projectKey]" />
        <Stack.Screen name="pair-scan" />
      </Stack.Protected>
      {/*
        Do not add getId or dangerouslySingular back to the workspace route.
        Expo Router maps dangerouslySingular to React Navigation getId, and
        getId repeatedly breaks Android native-stack/Fabric by reordering an
        already-mounted workspace screen. Keep workspace identity/retention
        outside this route-level native-stack API.
      */}
      <Stack.Screen name="h/[serverId]/workspace/[workspaceId]" />
      <Stack.Screen name="h/[serverId]/agent/[agentId]" options={AGENT_SCREEN_OPTIONS} />
      <Stack.Screen name="h/[serverId]/index" />
      <Stack.Screen name="h/[serverId]/sessions" />
      <Stack.Screen name="h/[serverId]/open-project" />
      <Stack.Screen name="h/[serverId]/settings" />
      <Stack.Screen name="settings/hosts/[serverId]" />
    </Stack>
  );
}

function AppShell() {
  return (
    <SidebarAnimationProvider>
      <HorizontalScrollProvider>
        <OpenProjectListener />
        <AppWithSidebar>
          <RootStack />
        </AppWithSidebar>
      </HorizontalScrollProvider>
    </SidebarAnimationProvider>
  );
}

function RuntimeProviders({ children }: { children: ReactNode }) {
  return (
    <HostRuntimeBootstrapProvider>
      <PushNotificationRouter />
      <SidebarCalloutProvider>
        <ToastProvider>
          <ProvidersWrapper>{children}</ProvidersWrapper>
        </ToastProvider>
      </SidebarCalloutProvider>
    </HostRuntimeBootstrapProvider>
  );
}

// PortalProvider must remain the innermost global provider here.
// `@gorhom/portal` renders portaled children at the host's location in the
// tree, so any context a portaled sheet might consume (QueryClient, theme,
// auth, settings, …) must wrap PortalProvider — not be wrapped by it.
// Adding a new global provider? Put it above PortalProvider.
function RootProviders({ children }: { children: ReactNode }) {
  return (
    <QueryProvider>
      <SafeAreaProvider>
        <KeyboardProvider>
          <PortalProvider>{children}</PortalProvider>
        </KeyboardProvider>
      </SafeAreaProvider>
    </QueryProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={flexStyle}>
      <View style={layoutStyles.surfaceFill}>
        <RootProviders>
          <RuntimeProviders>
            <AppShell />
          </RuntimeProviders>
        </RootProviders>
      </View>
    </GestureHandlerRootView>
  );
}

const layoutStyles = StyleSheet.create((theme) => ({
  surfaceFill: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
}));
