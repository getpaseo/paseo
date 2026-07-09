/**
 * @vitest-environment jsdom
 */
import React, { type ReactNode } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import {
  ExplorerSidebarAnimationProvider,
  useExplorerSidebarAnimation,
} from "@/contexts/explorer-sidebar-animation-context";
import {
  SidebarAnimationProvider,
  useSidebarAnimation,
} from "@/contexts/sidebar-animation-context";
import { usePanelStore } from "@/stores/panel-store";
import {
  MOBILE_PANEL_STATE_AGENT,
  MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN,
} from "@/utils/sidebar-animation-state";

const SCREEN_WIDTH = 390;

vi.mock("react-native", () => ({
  Keyboard: { dismiss: vi.fn() },
  useWindowDimensions: () => ({
    width: 390,
    height: 844,
    scale: 1,
    fontScale: 1,
  }),
}));

vi.mock("react-native-reanimated", () => ({
  Easing: {
    bezier: () => "bezier",
  },
  useSharedValue: (initialValue: unknown) => ({ value: initialValue }),
  withTiming: (value: unknown, _config?: unknown, callback?: (finished: boolean) => void) => {
    callback?.(true);
    return value;
  },
}));

vi.mock("react-native-unistyles", () => ({
  useUnistyles: () => ({
    rt: { breakpoint: "xs" },
  }),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn().mockResolvedValue(null),
    setItem: vi.fn().mockResolvedValue(undefined),
    removeItem: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/constants/platform", () => ({
  isNative: false,
  isWeb: true,
  getIsElectron: () => false,
  getIsElectronMac: () => false,
}));

function resetPanelStore(): void {
  usePanelStore.setState({
    mobileView: "agent",
    desktop: {
      agentListOpen: false,
      fileExplorerOpen: false,
      focusModeEnabled: false,
    },
    explorerTab: "changes",
    explorerTabByCheckout: {},
  });
}

function SidebarWrapper({ children }: { children: ReactNode }) {
  return <SidebarAnimationProvider>{children}</SidebarAnimationProvider>;
}

function ExplorerWrapper({ children }: { children: ReactNode }) {
  return (
    <SidebarAnimationProvider>
      <ExplorerSidebarAnimationProvider>{children}</ExplorerSidebarAnimationProvider>
    </SidebarAnimationProvider>
  );
}

describe("mobile sidebar animation authority", () => {
  beforeEach(() => {
    resetPanelStore();
  });

  afterEach(() => {
    cleanup();
    resetPanelStore();
  });

  it("reconciles the left sidebar shared values from the mobile panel store", () => {
    const { result } = renderHook(() => useSidebarAnimation(), {
      wrapper: SidebarWrapper,
    });

    result.current.translateX.value = -123;
    result.current.backdropOpacity.value = 0.4;

    act(() => {
      usePanelStore.getState().showMobileAgentList();
    });

    expect(result.current.translateX.value).toBe(0);
    expect(result.current.backdropOpacity.value).toBe(1);

    result.current.translateX.value = 0;
    result.current.backdropOpacity.value = 1;

    act(() => {
      usePanelStore.getState().showMobileAgent();
    });

    expect(result.current.translateX.value).toBe(-SCREEN_WIDTH);
    expect(result.current.backdropOpacity.value).toBe(0);
  });

  it("reconciles the right sidebar shared values from the mobile panel store", () => {
    const checkout = { serverId: "server-1", cwd: "/repo", isGit: true };
    const { result } = renderHook(
      () => ({
        explorer: useExplorerSidebarAnimation(),
        mobile: useSidebarAnimation(),
      }),
      { wrapper: ExplorerWrapper },
    );

    result.current.explorer.translateX.value = 77;
    result.current.explorer.backdropOpacity.value = 0.2;

    act(() => {
      usePanelStore.getState().openFileExplorerForCheckout({
        isCompact: true,
        checkout,
      });
    });

    expect(result.current.explorer.translateX.value).toBe(0);
    expect(result.current.explorer.backdropOpacity.value).toBe(1);
    expect(result.current.mobile.mobilePanelState.value).toBe(
      MOBILE_PANEL_STATE_FILE_EXPLORER_OPEN,
    );

    result.current.explorer.translateX.value = 0;
    result.current.explorer.backdropOpacity.value = 1;

    act(() => {
      usePanelStore.getState().showMobileAgent();
    });

    expect(result.current.explorer.translateX.value).toBe(SCREEN_WIDTH);
    expect(result.current.explorer.backdropOpacity.value).toBe(0);
    expect(result.current.mobile.mobilePanelState.value).toBe(MOBILE_PANEL_STATE_AGENT);
  });
});
