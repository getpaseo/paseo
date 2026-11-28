import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaInsetsContext } from "react-native-safe-area-context";
import { afterEach, expect, it, vi } from "vitest";
import { WindowLayoutProvider, WindowLayoutSurface } from "@/window-layout";
import { MermaidFullscreenViewer } from "./fullscreen-viewer.web";

vi.stubGlobal("React", React);
const statusBarInsets = { top: 32, right: 0, bottom: 20, left: 0 };
const surfaceStyle = { flex: 1 };
function noClose() {}
const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
afterEach(() => {
  act(() => root.render(null));
});

it("keeps the close button below the status bar when opened from a wide layout", async () => {
  await act(async () => {
    root.render(
      <SafeAreaInsetsContext.Provider value={statusBarInsets}>
        <WindowLayoutProvider>
          <WindowLayoutSurface compact={false} style={surfaceStyle}>
            <MermaidFullscreenViewer
              source={"graph TD\n  A --> B"}
              colorScheme="light"
              onClose={noClose}
            />
          </WindowLayoutSurface>
        </WindowLayoutProvider>
      </SafeAreaInsetsContext.Provider>,
    );
  });

  const close = document.querySelector<HTMLElement>('[data-testid="mermaid-fullscreen-close"]');
  expect(close).not.toBeNull();
  expect(close!.getBoundingClientRect().top).toBeGreaterThanOrEqual(statusBarInsets.top);
});
