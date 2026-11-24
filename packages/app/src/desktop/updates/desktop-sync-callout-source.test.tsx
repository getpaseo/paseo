/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme, mocks } = vi.hoisted(() => ({
  theme: {
    iconSize: { sm: 16 },
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
    fontSize: { xs: 11, sm: 13, base: 14 },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    colors: {
      surface0: "#000",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      destructive: "#f44",
    },
  },
  mocks: {
    getDesktopRuntimeInfo: vi.fn(),
    relaunchDesktopApp: vi.fn(),
    localServerId: "srv_local",
    daemonVersion: "0.17.4" as string | null,
    keepRunningAfterQuit: true,
    asyncStorageGetItem: vi.fn(async () => null),
    asyncStorageSetItem: vi.fn(async () => {}),
  },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: mocks.asyncStorageGetItem,
    setItem: mocks.asyncStorageSetItem,
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  withUnistyles: <T,>(Component: T, mapping?: (t: typeof theme) => Record<string, unknown>) =>
    function ThemedComponent(props: Record<string, unknown>) {
      return React.createElement(Component as React.ElementType, {
        ...mapping?.(theme),
        ...props,
      });
    },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => ({
  RefreshCw: (props: Record<string, unknown>) => React.createElement("span", props),
  X: (props: Record<string, unknown>) => React.createElement("span", props),
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => mocks.localServerId,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: {
      sessions: Record<string, { serverInfo?: { version?: string | null } }>;
    }) => unknown,
  ) =>
    selector({
      sessions: mocks.localServerId
        ? { [mocks.localServerId]: { serverInfo: { version: mocks.daemonVersion } } }
        : {},
    }),
}));

vi.mock("@/desktop/settings/desktop-settings", () => ({
  useDesktopSettings: () => ({
    settings: {
      releaseChannel: "stable",
      notifications: { playSound: true },
      daemon: {
        manageBuiltInDaemon: true,
        keepRunningAfterQuit: mocks.keepRunningAfterQuit,
      },
    },
    isLoading: false,
    isSaving: false,
    error: null,
    updateSettings: vi.fn(),
  }),
}));

vi.mock("@/desktop/updates/desktop-updates", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/desktop/updates/desktop-updates")>();
  return {
    ...actual,
    shouldShowDesktopUpdateSection: () => true,
    getDesktopRuntimeInfo: mocks.getDesktopRuntimeInfo,
    relaunchDesktopApp: mocks.relaunchDesktopApp,
  };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { SidebarCalloutSlot } from "@/components/sidebar-callout-slot";
import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { DesktopSyncCalloutSource } from "./desktop-sync-callout-source";

describe("DesktopSyncCalloutSource", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    mocks.daemonVersion = "0.17.4";
    mocks.keepRunningAfterQuit = true;
    mocks.getDesktopRuntimeInfo.mockReset();
    mocks.getDesktopRuntimeInfo.mockResolvedValue({
      appVersion: "0.17.3",
      runningUnderARM64Translation: false,
      displacedBundle: true,
      onDiskAppVersion: "0.17.4",
    });
    mocks.relaunchDesktopApp.mockReset();
    mocks.relaunchDesktopApp.mockResolvedValue(undefined);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
  });

  it("renders a restart callout when Desktop lags behind local daemon and triggers relaunch", async () => {
    await act(async () => {
      root?.render(
        <SidebarCalloutProvider>
          <DesktopSyncCalloutSource />
          <SidebarCalloutSlot />
        </SidebarCalloutProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Restart Desktop to sync UI");
    expect(container?.textContent).toContain(
      "Paseo Desktop v0.17.3 is behind local Daemon v0.17.4.",
    );
    expect(container?.textContent).toContain(
      "Relaunching Desktop will not interrupt running agents.",
    );

    const restartButton = container?.querySelector('[data-testid="desktop-sync-callout-action-0"]');
    expect(restartButton).not.toBeNull();

    await act(async () => {
      restartButton?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await Promise.resolve();
    });

    expect(mocks.relaunchDesktopApp).toHaveBeenCalledTimes(1);
  });
});
