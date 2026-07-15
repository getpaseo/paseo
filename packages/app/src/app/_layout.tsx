import "@/styles/unistyles";
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet";
import { PortalProvider } from "@gorhom/portal";
import { QueryClientProvider } from "@tanstack/react-query";
import * as Linking from "expo-linking";
import * as Notifications from "expo-notifications";
import { Stack, useNavigationContainerRef, usePathname, useRouter } from "expo-router";
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
import { AppState, useWindowDimensions, View } from "react-native";
import { GestureDetector, GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StyleSheet, UnistylesRuntime, useUnistyles } from "react-native-unistyles";
import { CommandCenter } from "@/components/command-center";
import { WorktreeSetupCalloutSource } from "@/components/worktree-setup-callout-source";
import { DownloadToast } from "@/components/download-toast";
import { QuittingOverlay } from "@/components/quitting-overlay";
import { KeyboardShortcutsDialog } from "@/components/keyboard-shortcuts-dialog";
import { AppDiagnosticHost } from "@/components/app-diagnostic-host";
import { LeftSidebar } from "@/components/left-sidebar";
import { WindowSidebarMenuToggle } from "@/components/headers/menu-header";
import { SidebarModelProvider } from "@/components/sidebar/sidebar-model";
import { CompactExplorerSidebarHost } from "@/components/compact-explorer-sidebar-host";
import { ProjectPickerModal } from "@/components/project-picker-modal";
import { ProviderSettingsHost } from "@/components/provider-settings-host";
import { RootErrorBoundary } from "@/components/root-error-boundary";
import { WorkspaceSetupDialog } from "@/components/workspace-setup-dialog";
import { WorkspaceShortcutTargetsSubscriber } from "@/components/workspace-shortcut-targets-subscriber";
import { FloatingPanelPortalHost } from "@/components/ui/floating-panel-portal";
import { HostChooserModal, useHostChooser } from "@/hosts/host-chooser";
import {
  getIsElectronRuntime,
  HEADER_INNER_HEIGHT,
  useIsCompactFormFactor,
} from "@/constants/layout";
import {
  canDesktopAppSidebarShare,
  resolveDesktopAppChromeLayout,
  resolveDesktopAppContentMinimum,
} from "@/components/desktop-sidebar-layout";
import { isNative, isWeb } from "@/constants/platform";
import { HorizontalScrollProvider } from "@/contexts/horizontal-scroll-context";
import { SessionProvider } from "@/contexts/session-context";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { ToastProvider } from "@/contexts/toast-context";
import { VoiceProvider } from "@/contexts/voice-context";
import {
  resolveStartupBlocker,
  resolveStartupNavigationReady,
  shouldRunStartupGiveUpTimer,
  startDaemonIfGateAllows,
  startHostRuntimeBootstrap,
  type StartupBlocker,
} from "@/navigation/host-runtime-bootstrap";
import { registerWorkspaceRouteNavigationRef } from "@/navigation/workspace-route-navigation";
import { ThemedStack } from "@/navigation/themed-stack";
import { shouldUseDesktopDaemon } from "@/desktop/daemon/desktop-daemon";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { updateDesktopWindowControls } from "@/desktop/electron/window";
import { getDesktopHost } from "@/desktop/host";
import { loadDesktopSettings } from "@/desktop/settings/desktop-settings";
import { RosettaCalloutSource } from "@/desktop/updates/rosetta-callout-source";
import { UpdateCalloutSource } from "@/desktop/updates/update-callout-source";
import { useActiveWorktreeNewAction } from "@/hooks/use-active-worktree-new-action";
import { useGlobalNewWorkspaceAction } from "@/hooks/use-global-new-workspace-action";
import { useFaviconStatus } from "@/hooks/use-favicon-status";
import { useKeyboardShortcuts } from "@/hooks/use-keyboard-shortcuts";
import { KeyboardShiftProvider } from "@/hooks/use-keyboard-shift-style";
import { useCompactWebViewportZoomLock } from "@/hooks/use-compact-web-viewport-zoom-lock";
import { useOpenProject } from "@/hooks/use-open-project";
import { useAppSettings } from "@/hooks/use-settings";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useOpenAgentListGesture } from "@/mobile-panels/gestures";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { I18nProvider } from "@/i18n/provider";
import { keyboardActionDispatcher } from "@/keyboard/keyboard-action-dispatcher";
import { polyfillCrypto } from "@/polyfills/crypto";
import { queryClient } from "@/data/query-client";
import {
  getHostRuntimeStore,
  hasConfiguredLocalDaemonOverride,
  useHostRegistryLoaded,
  useHostMutations,
  useHostRuntimeClient,
  useHosts,
} from "@/runtime/host-runtime";
import { getDaemonStartService } from "@/runtime/daemon-start-service";
import { applyAppearance } from "@/screens/settings/appearance/apply-appearance";
import { selectIsAgentListOpen, usePanelStore } from "@/stores/panel-store";
import { flushDraftPersistStorage } from "@/stores/draft-store";
import { THEME_TO_UNISTYLES, type ThemeName } from "@/styles/theme";
import { installWebScrollbarStyles } from "@/styles/install-web-scrollbar-styles";
import type { HostProfile } from "@/types/host-connection";
import { toggleDesktopSidebarsWithCheckoutIntent } from "@/utils/desktop-sidebar-toggle";
import {
  useHasWindowChromeObstruction,
  WindowChromeProvider,
  WindowChromeRegion,
  WindowChromeSafeArea,
} from "@/utils/desktop-window";
import { buildOpenProjectRoute, parseServerIdFromPathname } from "@/utils/host-routes";
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
  startupBlocker: StartupBlocker;
}

const HostRuntimeBootstrapContext = createContext<HostRuntimeBootstrapState>({
  splashError: null,
  retry: () => {},
  hasGivenUpWaitingForHost: false,
  storeReady: false,
  startupBlocker: { kind: "none" },
});

function PushNotificationRouter() {
  const router = useRouter();
  const lastHandledIdRef = useRef<string | null>(null);
  const openNotification = useStableEvent((data: Record<string, unknown> | undefined) => {
    const target = resolveNotificationTarget(data);
    const serverId = target.serverId;
    const agentId = target.agentId;
    if (serverId && agentId) {
      navigateToAgent({ serverId, agentId, pin: true });
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
  if (hasConfiguredLocalDaemonOverride()) {
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
  const [hasGivenUpWaitingForHost, setHasGivenUpWaitingForHost] = useState(false);
  const isDesktopRuntime = shouldUseDesktopDaemon();
  const startupBlocker = useMemo(
    () =>
      resolveStartupBlocker({
        isDesktopRuntime,
        anyOnlineHostServerId,
        daemonStartIsRunning,
        daemonStartError,
      }),
    [anyOnlineHostServerId, daemonStartError, daemonStartIsRunning, isDesktopRuntime],
  );
  const shouldRunGiveUpTimer = shouldRunStartupGiveUpTimer({
    startupBlocker,
    anyOnlineHostServerId,
    hasGivenUpWaitingForHost,
  });

  useEffect(() => {
    if (!shouldRunGiveUpTimer) {
      return;
    }
    const handle = setTimeout(() => {
      setHasGivenUpWaitingForHost(true);
    }, STARTUP_GIVE_UP_TIMEOUT_MS);
    return () => {
      clearTimeout(handle);
    };
  }, [shouldRunGiveUpTimer]);

  const retry = useCallback(() => {
    const daemonStartService = getDaemonStartService({ store: getHostRuntimeStore() });
    startDaemonIfGateAllows({
      daemonStartService,
      shouldStartDaemon: shouldStartBuiltInDaemon,
      onGateError: (message) => daemonStartService.recordError(message),
    });
  }, []);

  const splashError =
    startupBlocker.kind === "managed-daemon-error" ? startupBlocker.message : null;
  const storeReady = resolveStartupNavigationReady({ startupBlocker });

  const state = useMemo<HostRuntimeBootstrapState>(
    () => ({ splashError, retry, hasGivenUpWaitingForHost, storeReady, startupBlocker }),
    [splashError, retry, hasGivenUpWaitingForHost, storeReady, startupBlocker],
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
const MOBILE_WEB_GESTURE_TOUCH_ACTION = isWeb ? "auto" : "pan-y";

interface AppContainerProps {
  children: ReactNode;
  chromeEnabled?: boolean;
}

const THEME_CYCLE_ORDER: ThemeName[] = ["dark", "zinc", "midnight", "claude", "ghostty", "light"];
const WINDOW_SIDEBAR_TOGGLE_HORIZONTAL_PADDING = 12;

function AppContainer({ children, chromeEnabled: chromeEnabledOverride }: AppContainerProps) {
  const daemons = useHosts();
  const { settings, updateSettings } = useAppSettings();
  const toggleMobileAgentList = usePanelStore((state) => state.toggleMobileAgentList);
  const toggleDesktopAgentList = usePanelStore((state) => state.toggleDesktopAgentList);
  const openDesktopAgentList = usePanelStore((state) => state.openDesktopAgentList);
  const closeDesktopAgentList = usePanelStore((state) => state.closeDesktopAgentList);
  const closeDesktopFileExplorer = usePanelStore((state) => state.closeDesktopFileExplorer);
  const toggleFocusMode = usePanelStore((state) => state.toggleFocusMode);
  const isFocusModeEnabled = usePanelStore((state) => state.desktop.focusModeEnabled);
  const isDesktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const isDesktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen);
  const sidebarWidth = usePanelStore((state) => state.sidebarWidth);
  const explorerWidth = usePanelStore((state) => state.explorerWidth);
  const { width: viewportWidth } = useWindowDimensions();

  const cycleTheme = useCallback(() => {
    const currentIndex = THEME_CYCLE_ORDER.indexOf(settings.theme as ThemeName);
    const nextIndex = (currentIndex + 1) % THEME_CYCLE_ORDER.length;
    void updateSettings({ theme: THEME_CYCLE_ORDER[nextIndex] });
  }, [settings.theme, updateSettings]);

  const isCompactLayout = useIsCompactFormFactor();
  useCompactWebViewportZoomLock(isCompactLayout);
  const pathname = usePathname();
  const chromeEnabled = chromeEnabledOverride ?? daemons.length > 0;
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
  useGlobalNewWorkspaceAction();

  const appContentMinimumWidth = resolveDesktopAppContentMinimum({
    isSettingsRoute: pathname.includes("/settings"),
    isWorkspaceExplorerOpen: pathname.includes("/workspace/") && isDesktopFileExplorerOpen,
    requestedExplorerWidth: explorerWidth,
    viewportWidth,
  });
  const desktopSidebarMounted = chromeEnabled && !isFocusModeEnabled;
  const desktopSidebarVisible =
    !isCompactLayout &&
    desktopSidebarMounted &&
    isDesktopAgentListOpen &&
    canDesktopAppSidebarShare({
      contentMinimumWidth: appContentMinimumWidth,
      requestedSidebarWidth: sidebarWidth,
      viewportWidth,
    });
  const hasTopLeftWindowControls = useHasWindowChromeObstruction("top-left");
  const appChromeLayout = resolveDesktopAppChromeLayout({
    desktopSidebarRendered: desktopSidebarVisible,
    hasTopLeftWindowControls,
    sidebarControlsEnabled: chromeEnabled && !isFocusModeEnabled,
  });
  const sidebarChrome = (
    <SidebarChrome
      mounted={isCompactLayout ? chromeEnabled : desktopSidebarMounted}
      visible={isCompactLayout ? chromeEnabled : desktopSidebarVisible}
      keyboardShortcutsEnabled={keyboardShortcutsEnabled}
    />
  );
  const workspaceChrome = (
    <View style={rowStyle}>
      {!isCompactLayout ? (
        <WindowChromeRegion corners={appChromeLayout.sidebarCorners}>
          {sidebarChrome}
        </WindowChromeRegion>
      ) : null}
      {isCompactLayout && chromeEnabled ? (
        <CompactExplorerSidebarHost enabled={chromeEnabled}>
          <WindowChromeRegion corners="both">
            <View style={flexStyle}>{children}</View>
          </WindowChromeRegion>
        </CompactExplorerSidebarHost>
      ) : (
        <WindowChromeRegion corners={appChromeLayout.contentCorners}>
          <View style={flexStyle}>{children}</View>
        </WindowChromeRegion>
      )}
    </View>
  );

  const surface = (
    <View style={layoutStyles.surfaceFill}>
      {workspaceChrome}
      {!isCompactLayout && appChromeLayout.sidebarToggleOwner === "window" ? (
        <WindowChromeRegion corners="top-left">
          <WindowChromeSafeArea
            placement="inline"
            horizontalPadding={WINDOW_SIDEBAR_TOGGLE_HORIZONTAL_PADDING}
            pointerEvents="box-none"
            style={layoutStyles.windowSidebarToggle}
          >
            <WindowSidebarMenuToggle />
          </WindowChromeSafeArea>
        </WindowChromeRegion>
      ) : null}
      <FloatingPanelPortalHost />
      {isCompactLayout ? sidebarChrome : null}
      <DownloadToast />
      <RosettaCalloutSource />
      <UpdateCalloutSource />
      <WorktreeSetupCalloutSource />
      <CommandCenter />
      <HostChooserModal />
      <ProjectPickerModal />
      <ProviderSettingsHost />
      <WorkspaceSetupDialog />
      <KeyboardShortcutsDialog />
      <AppDiagnosticHost />
      <QuittingOverlay />
    </View>
  );

  const content = isCompactLayout ? (
    <MobileGestureWrapper chromeEnabled={chromeEnabled}>{surface}</MobileGestureWrapper>
  ) : (
    surface
  );

  return content;
}

function SidebarChrome({
  mounted,
  visible,
  keyboardShortcutsEnabled,
}: {
  mounted: boolean;
  visible: boolean;
  keyboardShortcutsEnabled: boolean;
}) {
  const isCompactLayout = useIsCompactFormFactor();
  const isOpen = usePanelStore((state) =>
    selectIsAgentListOpen(state, { isCompact: isCompactLayout }),
  );
  const active = visible && isOpen;
  return (
    <SidebarModelProvider active={active}>
      {mounted ? <LeftSidebar active={active} /> : null}
      <WorkspaceShortcutTargetsSubscriber enabled={keyboardShortcutsEnabled} />
    </SidebarModelProvider>
  );
}

function MobileGestureWrapper({
  children,
  chromeEnabled,
}: {
  children: ReactNode;
  chromeEnabled: boolean;
}) {
  const openGesture = useOpenAgentListGesture(chromeEnabled);

  return (
    <GestureDetector gesture={openGesture} touchAction={MOBILE_WEB_GESTURE_TOUCH_ACTION}>
      <View collapsable={false} style={layoutStyles.surfaceFill}>
        {children}
      </View>
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

  // Apply font / size / syntax appearance settings on mount and when they change.
  // Sibling to the theme effect above; order is irrelevant because both patch all
  // six registered theme keys, so the active key is always current.
  useEffect(() => {
    if (settingsLoading) return;
    applyAppearance({
      uiFontFamily: settings.uiFontFamily,
      monoFontFamily: settings.monoFontFamily,
      uiFontSize: settings.uiFontSize,
      codeFontSize: settings.codeFontSize,
      syntaxTheme: settings.syntaxTheme,
    });
  }, [
    settingsLoading,
    settings.uiFontFamily,
    settings.monoFontFamily,
    settings.uiFontSize,
    settings.codeFontSize,
    settings.syntaxTheme,
  ]);

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
          router.replace(buildOpenProjectRoute());
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

interface PendingOpenProjectRequest {
  id: number;
  serverId: string;
  path: string;
}

let nextOpenProjectRequestId = 1;

function OpenProjectListener() {
  const chooseHost = useHostChooser();
  const hostRegistryLoaded = useHostRegistryLoaded();
  const [request, setRequest] = useState<PendingOpenProjectRequest | null>(null);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const openProject = useOpenProject(request?.serverId ?? null);

  const openPathOnChosenHost = useCallback(
    (path: string) => {
      const nextPath = path.trim();
      if (!nextPath) {
        return;
      }

      if (!hostRegistryLoaded) {
        setPendingPath(nextPath);
        return;
      }

      chooseHost({
        title: "Choose host",
        onChooseHost: (serverId) => {
          setRequest({
            id: nextOpenProjectRequestId++,
            serverId,
            path: nextPath,
          });
        },
      });
    },
    [chooseHost, hostRegistryLoaded],
  );

  useEffect(() => {
    if (!hostRegistryLoaded || !pendingPath) {
      return;
    }
    const nextPath = pendingPath;
    setPendingPath(null);
    openPathOnChosenHost(nextPath);
  }, [hostRegistryLoaded, openPathOnChosenHost, pendingPath]);

  useEffect(() => {
    if (!request) {
      return;
    }
    let cancelled = false;
    void openProject(request.path).then((result) => {
      if (cancelled) {
        return null;
      }

      if (!result.ok) {
        setRequest((current) => (current?.id === request.id ? null : current));
        return null;
      }

      setRequest((current) => (current?.id === request.id ? null : current));
      return null;
    });
    return () => {
      cancelled = true;
    };
  }, [openProject, request]);

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | null = null;
    void getDesktopHost()
      ?.getPendingOpenProject?.()
      ?.then((pending) => {
        if (!disposed && pending) {
          openPathOnChosenHost(pending);
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
      openPathOnChosenHost(nextPath);
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

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [openPathOnChosenHost]);

  return null;
}

function AppWithSidebar({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const hosts = useHosts();
  const storeReady = useStoreReady();
  const routeServerId = useMemo(() => parseServerIdFromPathname(pathname), [pathname]);
  const routeHasKnownHost =
    routeServerId !== null && hosts.some((host) => host.serverId === routeServerId);
  const shouldShowAppChrome =
    storeReady &&
    (pathname === "/open-project" ||
      pathname === "/new" ||
      pathname === "/sessions" ||
      pathname === "/schedules" ||
      routeHasKnownHost);

  return <AppContainer chromeEnabled={shouldShowAppChrome}>{children}</AppContainer>;
}

function FaviconStatusSync() {
  useFaviconStatus();
  return null;
}

const ROOT_STACK_SCREEN_OPTIONS = {
  headerShown: false,
  animation: "none" as const,
};

function RootStack() {
  const storeReady = useStoreReady();
  return (
    <ThemedStack screenOptions={ROOT_STACK_SCREEN_OPTIONS}>
      <Stack.Screen name="index" />
      <Stack.Protected guard={storeReady}>
        <Stack.Screen name="welcome" />
        <Stack.Screen name="settings/index" />
        <Stack.Screen name="settings/[section]" />
        <Stack.Screen name="settings/projects/index" />
        <Stack.Screen name="settings/projects/[projectKey]" />
        <Stack.Screen name="new" />
        <Stack.Screen name="open-project" />
        <Stack.Screen name="sessions" />
        <Stack.Screen name="schedules" />
        <Stack.Screen name="pair-scan" />
      </Stack.Protected>
      <Stack.Screen name="h/[serverId]" />
      <Stack.Screen name="settings/hosts/[serverId]/index" />
      <Stack.Screen name="settings/hosts/[serverId]/[hostSection]" />
    </ThemedStack>
  );
}

function WorkspaceRouteNavigationBridge() {
  const navigationRef = useNavigationContainerRef();

  useEffect(() => {
    return registerWorkspaceRouteNavigationRef(navigationRef);
  }, [navigationRef]);

  return null;
}

function AppShell() {
  return (
    <MobilePanelsProvider>
      <HorizontalScrollProvider>
        <OpenProjectListener />
        <AppWithSidebar>
          <WorkspaceRouteNavigationBridge />
          <RootStack />
        </AppWithSidebar>
      </HorizontalScrollProvider>
    </MobilePanelsProvider>
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

// PortalProvider must stay inside normal app-wide context providers.
// `@gorhom/portal` renders portaled children at the host's location in the
// tree, so any context a portaled sheet might consume (QueryClient, theme,
// auth, settings, ...) must wrap PortalProvider, not be wrapped by it.
// BottomSheetModalProvider is the exception: Gorhom modals consume portal
// context and need one shared provider for sibling sheets to stack.
function RootProviders({ children }: { children: ReactNode }) {
  return (
    <SafeAreaProvider>
      <WindowChromeProvider>
        <KeyboardProvider>
          <KeyboardShiftProvider>
            <PortalProvider>
              <BottomSheetModalProvider>{children}</BottomSheetModalProvider>
            </PortalProvider>
          </KeyboardShiftProvider>
        </KeyboardProvider>
      </WindowChromeProvider>
    </SafeAreaProvider>
  );
}

function RootAppTree() {
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

export default function RootLayout() {
  useEffect(() => installWebScrollbarStyles(), []);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (nextState) => {
      if (nextState !== "active") {
        void flushDraftPersistStorage();
      }
    });
    return () => subscription.remove();
  }, []);

  return (
    <QueryProvider>
      <I18nProvider>
        <RootErrorBoundary>
          <RootAppTree />
        </RootErrorBoundary>
      </I18nProvider>
    </QueryProvider>
  );
}

const layoutStyles = StyleSheet.create((theme) => ({
  surfaceFill: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  windowSidebarToggle: {
    position: "absolute",
    top: 0,
    left: 0,
    zIndex: 20,
    height: HEADER_INNER_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: "transparent",
  },
}));
