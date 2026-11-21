import React, { act, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { View } from "react-native";
import { Gesture, GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaInsetsContext, useSafeAreaInsets } from "react-native-safe-area-context";
import { afterEach, expect, it, vi } from "vitest";
import { resolveDesktopSidebarInsetTop } from "@/components/desktop-sidebar-layout";
import { MobilePanelOverlay } from "@/mobile-panels/presentation";
import { MobilePanelsProvider } from "@/mobile-panels/provider";
import { usePanelStore } from "@/stores/panel-store";
import {
  WindowLayoutProvider,
  WindowLayoutSurface,
  useWindowSafeAreaInsets,
} from "@/window-layout";

vi.stubGlobal("React", React);
const statusBarInsets = { top: 24, right: 0, bottom: 0, left: 0 };
const fill = { flex: 1 };
const rowStyle = { height: 40 };
const container = document.createElement("div");
container.style.height = "800px";
document.body.appendChild(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
});

/** The first row of the sidebar, padded the way `DesktopSidebar` pads it. */
function SidebarFirstRow({ overlay }: { overlay: boolean }) {
  const insetTop = resolveDesktopSidebarInsetTop({
    overlay,
    safeAreaTop: useSafeAreaInsets().top,
    windowSafeAreaTop: useWindowSafeAreaInsets().top,
  });
  const style = useMemo(() => ({ paddingTop: insetTop }), [insetTop]);
  return (
    <View style={style}>
      <View testID="sidebar-first-row" style={rowStyle} />
    </View>
  );
}

function firstRowTop(): number {
  const row = document.querySelector<HTMLElement>('[data-testid="sidebar-first-row"]');
  expect(row).not.toBeNull();
  return row!.getBoundingClientRect().top - container.getBoundingClientRect().top;
}

async function renderSidebar(overlay: boolean) {
  const closeGesture = Gesture.Pan();
  await act(async () => {
    root.render(
      <GestureHandlerRootView style={fill}>
        <SafeAreaInsetsContext.Provider value={statusBarInsets}>
          <WindowLayoutProvider>
            <WindowLayoutSurface compact={false} style={fill}>
              <MobilePanelsProvider>
                <MobilePanelOverlay
                  panel="agent-list"
                  presentation={overlay ? "overlay" : "dock"}
                  dockVisible={!overlay}
                  closeGesture={closeGesture}
                >
                  <SidebarFirstRow overlay={overlay} />
                </MobilePanelOverlay>
              </MobilePanelsProvider>
            </WindowLayoutSurface>
          </WindowLayoutProvider>
        </SafeAreaInsetsContext.Provider>
      </GestureHandlerRootView>,
    );
  });
}

it("keeps the overlay sidebar's first row below the status bar on a wide layout", async () => {
  usePanelStore.getState().showMobileAgentList();
  await renderSidebar(true);
  expect(firstRowTop()).toBe(statusBarInsets.top);
});

it("keeps the docked sidebar's first row below the status bar without padding it twice", async () => {
  await renderSidebar(false);
  expect(firstRowTop()).toBe(statusBarInsets.top);
});
