// @vitest-environment jsdom

import { render } from "@testing-library/react";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { describe, expect, it, vi } from "vitest";
import type { ToastApi } from "@/components/toast-host";
import { ToastApiProvider, useToast } from "@/contexts/toast-context";
import { SidebarToastRegion } from "./sidebar-toast-region";

const safeAreaMetrics = {
  frame: { x: 0, y: 0, width: 800, height: 600 },
  insets: { top: 0, left: 0, right: 0, bottom: 0 },
};

function createFakeToast(): ToastApi {
  return { show: vi.fn(() => () => {}), copied: vi.fn(), error: vi.fn() };
}

function renderRegion(active: boolean) {
  const appToast = createFakeToast();
  let regionToast: ToastApi | null = null;
  function CaptureToast() {
    regionToast = useToast();
    return null;
  }
  const tree = (isActive: boolean) => (
    <SafeAreaProvider initialMetrics={safeAreaMetrics}>
      <ToastApiProvider api={appToast}>
        <SidebarToastRegion active={isActive}>
          <CaptureToast />
        </SidebarToastRegion>
      </ToastApiProvider>
    </SafeAreaProvider>
  );
  const view = render(tree(active));
  return {
    appToast,
    toast: () => regionToast as unknown as ToastApi,
    setActive: (next: boolean) => view.rerender(tree(next)),
    unmount: view.unmount,
  };
}

describe("SidebarToastRegion", () => {
  it("keeps toasts in the sidebar while it is visible", () => {
    const { appToast, toast } = renderRegion(true);

    toast().error("Archive failed");

    expect(appToast.error).not.toHaveBeenCalled();
  });

  it("sends toasts to the app while the sidebar is hidden", () => {
    const { appToast, toast, setActive } = renderRegion(true);

    setActive(false);
    toast().error("Archive failed");

    expect(appToast.error).toHaveBeenCalledWith("Archive failed");
  });

  it("sends a late failure to the app after the sidebar unmounts", () => {
    const { appToast, toast, unmount } = renderRegion(true);
    const savedToast = toast();

    unmount();
    savedToast.error("Archive failed");

    expect(appToast.error).toHaveBeenCalledWith("Archive failed");
  });
});
