/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostRuntimeBootstrapState } from "./_layout";

const { state, startHostRuntimeBootstrapMock } = vi.hoisted(() => {
  return {
    state: {
      anyOnlineHostServerId: null as string | null,
      daemonStartError: null as string | null,
      daemonStartIsRunning: false,
      latestBootstrapState: null as HostRuntimeBootstrapState | null,
    },
    startHostRuntimeBootstrapMock: vi.fn(),
  };
});

vi.mock("@/styles/unistyles", () => ({}));
vi.mock("@gorhom/portal", () => ({
  PortalProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@tanstack/react-query", () => ({
  QueryClientProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("expo-linking", () => ({ addEventListener: vi.fn(), getInitialURL: vi.fn() }));
vi.mock("expo-notifications", () => ({
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(),
  setNotificationHandler: vi.fn(),
}));
vi.mock("expo-router", () => ({
  Stack: Object.assign(() => null, { Protected: () => null, Screen: () => null }),
  useGlobalSearchParams: () => ({}),
  usePathname: () => "/",
  useRouter: () => ({ navigate: vi.fn(), replace: vi.fn() }),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: React.ReactNode }) => children,
}));
vi.mock("react-native-gesture-handler", () => ({
  Gesture: { Pan: () => ({}) },
  GestureDetector: ({ children }: { children: React.ReactNode }) => children,
  GestureHandlerRootView: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-native-keyboard-controller", () => ({
  KeyboardProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-native-reanimated", () => ({
  Extrapolation: { CLAMP: "clamp" },
  interpolate: vi.fn(),
  runOnJS: (fn: () => void) => fn,
  useSharedValue: (value: unknown) => ({ value }),
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({ colors: { surface0: "#000", foreground: "#fff" } })
        : factory,
  },
  UnistylesRuntime: { setAdaptiveThemes: vi.fn(), setTheme: vi.fn() },
  useUnistyles: () => ({ theme: { colors: { surface0: "#000", foreground: "#fff" } } }),
}));

vi.mock("@/components/command-center", () => ({ CommandCenter: () => null }));
vi.mock("@/components/worktree-setup-callout-source", () => ({
  WorktreeSetupCalloutSource: () => null,
}));
vi.mock("@/components/download-toast", () => ({ DownloadToast: () => null }));
vi.mock("@/components/quitting-overlay", () => ({ QuittingOverlay: () => null }));
vi.mock("@/components/keyboard-shortcuts-dialog", () => ({ KeyboardShortcutsDialog: () => null }));
vi.mock("@/components/left-sidebar", () => ({ LeftSidebar: () => null }));
vi.mock("@/components/project-picker-modal", () => ({ ProjectPickerModal: () => null }));
vi.mock("@/components/workspace-setup-dialog", () => ({ WorkspaceSetupDialog: () => null }));
vi.mock("@/components/workspace-shortcut-targets-subscriber", () => ({
  WorkspaceShortcutTargetsSubscriber: () => null,
}));
vi.mock("@/constants/layout", () => ({
  getIsElectronRuntime: () => false,
  useIsCompactFormFactor: () => false,
}));
vi.mock("@/constants/platform", () => ({ isNative: false, isWeb: true }));
vi.mock("@/contexts/horizontal-scroll-context", () => ({
  HorizontalScrollProvider: ({ children }: { children: React.ReactNode }) => children,
  useHorizontalScrollOptional: () => null,
}));
vi.mock("@/contexts/session-context", () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/contexts/sidebar-animation-context", () => ({
  SidebarAnimationProvider: ({ children }: { children: React.ReactNode }) => children,
  useSidebarAnimation: () => ({
    animateToClose: vi.fn(),
    animateToOpen: vi.fn(),
    backdropOpacity: { value: 0 },
    gestureAnimatingRef: { current: false },
    isGesturing: { value: false },
    openGestureRef: {},
    translateX: { value: 0 },
    windowWidth: 320,
  }),
}));
vi.mock("@/contexts/sidebar-callout-context", () => ({
  SidebarCalloutProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/contexts/toast-context", () => ({
  ToastProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/contexts/voice-context", () => ({
  VoiceProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/app/host-runtime-bootstrap", () => ({
  startDaemonIfGateAllows: vi.fn(),
  startHostRuntimeBootstrap: startHostRuntimeBootstrapMock,
}));
vi.mock("@/desktop/daemon/desktop-daemon", () => ({ shouldUseDesktopDaemon: () => false }));
vi.mock("@/desktop/electron/events", () => ({ listenToDesktopEvent: vi.fn() }));
vi.mock("@/desktop/electron/window", () => ({ updateDesktopWindowControls: vi.fn() }));
vi.mock("@/desktop/host", () => ({ getDesktopHost: () => null }));
vi.mock("@/desktop/settings/desktop-settings", () => ({ loadDesktopSettings: vi.fn() }));
vi.mock("@/desktop/updates/rosetta-callout-source", () => ({ RosettaCalloutSource: () => null }));
vi.mock("@/desktop/updates/update-callout-source", () => ({ UpdateCalloutSource: () => null }));
vi.mock("@/hooks/use-active-worktree-new-action", () => ({ useActiveWorktreeNewAction: vi.fn() }));
vi.mock("@/hooks/use-favicon-status", () => ({ useFaviconStatus: vi.fn() }));
vi.mock("@/hooks/use-keyboard-shortcuts", () => ({ useKeyboardShortcuts: vi.fn() }));
vi.mock("@/hooks/use-latched-boolean", () => ({ useLatchedBoolean: (value: boolean) => value }));
vi.mock("@/hooks/use-open-project", () => ({ useOpenProject: () => vi.fn() }));
vi.mock("@/hooks/use-settings", () => ({
  useAppSettings: () => ({
    isLoading: false,
    settings: { theme: "dark" },
    updateSettings: vi.fn(),
  }),
}));
vi.mock("@/hooks/use-stable-event", () => ({ useStableEvent: (fn: unknown) => fn }));
vi.mock("@/hooks/use-workspace-navigation", () => ({ navigateToWorkspace: vi.fn() }));
vi.mock("@/keyboard/keyboard-action-dispatcher", () => ({
  keyboardActionDispatcher: { dispatch: vi.fn() },
}));
vi.mock("@/polyfills/crypto", () => ({ polyfillCrypto: vi.fn() }));
vi.mock("@/query/query-client", () => ({ queryClient: {} }));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    boot: vi.fn(),
    getEarliestOnlineHostServerId: () => state.anyOnlineHostServerId,
    subscribeAll: () => vi.fn(),
    subscribeHostList: () => vi.fn(),
  }),
  useHostMutations: () => ({ upsertConnectionFromOfferUrl: vi.fn() }),
  useHostRuntimeClient: () => null,
  useHosts: () => [],
}));
vi.mock("@/runtime/daemon-start-service", () => ({
  getDaemonStartService: () => ({
    getLastError: () => state.daemonStartError,
    isRunning: () => state.daemonStartIsRunning,
    recordError: vi.fn(),
    start: vi.fn(),
    subscribe: () => vi.fn(),
  }),
}));
vi.mock("@/stores/panel-store", () => ({ usePanelStore: vi.fn(() => vi.fn()) }));
vi.mock("@/stores/session-store", () => ({
  useSessionStore: { getState: () => ({ sessions: {} }) },
}));
vi.mock("@/styles/theme", () => ({ THEME_TO_UNISTYLES: { dark: "dark" } }));
vi.mock("@/utils/active-host", () => ({ resolveActiveHost: () => null }));
vi.mock("@/utils/desktop-sidebar-toggle", () => ({
  toggleDesktopSidebarsWithCheckoutIntent: vi.fn(),
}));
vi.mock("@/utils/host-routes", () => ({
  buildHostRootRoute: (serverId: string) => `/h/${serverId}`,
  mapPathnameToServer: () => null,
  parseHostAgentRouteFromPathname: () => null,
  parseServerIdFromPathname: () => null,
  parseWorkspaceOpenIntent: () => null,
}));
vi.mock("@/utils/notification-routing", () => ({
  buildNotificationRoute: () => "/",
  resolveNotificationTarget: () => ({}),
}));
vi.mock("@/utils/os-notifications", () => ({
  WEB_NOTIFICATION_CLICK_EVENT: "notification-click",
  ensureOsNotificationPermission: vi.fn(),
}));
vi.mock("@/utils/workspace-execution", () => ({
  resolveWorkspaceIdByExecutionDirectory: () => null,
}));
vi.mock("@/utils/workspace-navigation", () => ({ prepareWorkspaceTab: vi.fn() }));

let useHostRuntimeBootstrapState: typeof import("./_layout").useHostRuntimeBootstrapState;

function BootstrapStateProbe() {
  state.latestBootstrapState = useHostRuntimeBootstrapState();
  return null;
}

describe("HostRuntimeBootstrapProvider startup give-up timer", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    state.anyOnlineHostServerId = null;
    state.daemonStartError = null;
    state.daemonStartIsRunning = false;
    state.latestBootstrapState = null;
    startHostRuntimeBootstrapMock.mockClear();

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
  });

  async function renderProvider() {
    const layout = await import("./_layout");
    useHostRuntimeBootstrapState = layout.useHostRuntimeBootstrapState;
    await act(async () => {
      root.render(
        <layout.HostRuntimeBootstrapProvider>
          <BootstrapStateProbe />
        </layout.HostRuntimeBootstrapProvider>,
      );
    });
  }

  it("gives up after 5s when the env override host is not online", async () => {
    await renderProvider();

    expect(state.latestBootstrapState?.hasGivenUpWaitingForHost).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(state.latestBootstrapState?.hasGivenUpWaitingForHost).toBe(true);
  });

  it("does not give up after 5s when an env override host is online", async () => {
    state.anyOnlineHostServerId = "server-local";

    await renderProvider();

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });

    expect(state.latestBootstrapState?.hasGivenUpWaitingForHost).toBe(false);
  });
});
