import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ToastViewport, useToastHost, type ToastApi } from "@/components/toast-host";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function mountToastHost(): ToastApi {
  let api: ToastApi | null = null;
  function Host() {
    const host = useToastHost();
    api = host.api;
    return <ToastViewport toast={host.toast} onDismiss={host.dismiss} placement="sidebar" />;
  }
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root?.render(
      <SafeAreaProvider>
        <Host />
      </SafeAreaProvider>,
    ),
  );
  if (!api) throw new Error("The toast host did not render");
  return api;
}

function shownMessage(): string | null {
  return document.querySelector('[data-testid="app-toast-message"]')?.textContent ?? null;
}

describe("ToastViewport", () => {
  it("keeps a new toast when the toast it replaced times out before the next render", () => {
    vi.useFakeTimers();
    const toast = mountToastHost();
    act(() => {
      toast.show("Installed review");
    });
    act(() => {
      vi.advanceTimersByTime(2199);
    });

    // The new toast is in state, but React has not rendered it, so the old toast's timer is
    // still scheduled when it expires.
    act(() => {
      toast.show("Reloaded review");
      vi.advanceTimersByTime(1);
    });

    expect(shownMessage()).toBe("Reloaded review");
    act(() => {
      vi.advanceTimersByTime(2199);
    });
    expect(shownMessage()).toBe("Reloaded review");
  });
});
