/**
 * @vitest-environment jsdom
 */
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 0: 0, 1: 4, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
    fontSize: { xs: 11, sm: 13 },
    fontWeight: { medium: "500", semibold: "600" },
    colors: {
      surface0: "#000",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      destructive: "#f44",
    },
  },
}));

const asyncStorage = vi.hoisted(() => ({
  values: new Map<string, string>(),
  getItem: vi.fn(async (key: string) => asyncStorage.values.get(key) ?? null),
  setItem: vi.fn(async (key: string, value: string) => {
    asyncStorage.values.set(key, value);
  }),
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: asyncStorage,
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const X = (props: Record<string, unknown>) => React.createElement("span", props);
  return { X };
});

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import {
  SidebarCalloutProvider,
  type SidebarCalloutsApi,
  SidebarCalloutViewport,
  useSidebarCallouts,
} from "./sidebar-callout-context";

const apiSink: { current: SidebarCalloutsApi | null } = { current: null };

function handleApi(nextApi: SidebarCalloutsApi): void {
  apiSink.current = nextApi;
}

function CaptureApi({ onApi }: { onApi: (api: SidebarCalloutsApi) => void }) {
  const api = useSidebarCallouts();
  onApi(api);
  return null;
}

describe("SidebarCalloutProvider", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;
  let api: SidebarCalloutsApi | null = null;

  beforeEach(async () => {
    api = null;
    apiSink.current = null;
    asyncStorage.values.clear();
    asyncStorage.getItem.mockClear();
    asyncStorage.setItem.mockClear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        <SidebarCalloutProvider>
          <CaptureApi onApi={handleApi} />
          <SidebarCalloutViewport />
        </SidebarCalloutProvider>,
      );
      await Promise.resolve();
    });
    api = apiSink.current;
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
    api = null;
  });

  it("shows the highest-priority callout first, then reveals the next when dismissed", () => {
    act(() => {
      api?.show({ id: "onboarding", priority: 10, title: "Set up scripts" });
      api?.show({ id: "update", priority: 200, title: "Update available" });
    });

    expect(container?.textContent).toContain("Update available");
    expect(container?.textContent).not.toContain("Set up scripts");

    act(() => {
      api?.dismiss("update");
    });

    expect(container?.textContent).toContain("Set up scripts");
    expect(container?.textContent).not.toContain("Update available");
  });

  it("replaces a callout by id without duplicating the queue item", () => {
    act(() => {
      api?.show({ id: "daemon", title: "Old daemon", description: "v1" });
      api?.show({ id: "daemon", title: "New daemon", description: "v2" });
    });

    expect(container?.textContent).toContain("New daemon");
    expect(container?.textContent).toContain("v2");
    expect(container?.textContent).not.toContain("Old daemon");
  });

  it("keeps API consumers from rerendering when callout state changes", () => {
    const renders = vi.fn();
    function Producer() {
      const callouts = useSidebarCallouts();
      renders(callouts);
      useEffect(() => {
        callouts.show({ id: "initial", title: "Initial" });
      }, [callouts]);
      return null;
    }

    act(() => {
      root?.render(
        <SidebarCalloutProvider>
          <Producer />
          <CaptureApi onApi={handleApi} />
          <SidebarCalloutViewport />
        </SidebarCalloutProvider>,
      );
    });
    api = apiSink.current;
    const firstApi = renders.mock.calls[0]?.[0];

    act(() => {
      api?.show({ id: "later", priority: 10, title: "Later" });
    });

    expect(renders).toHaveBeenCalledTimes(1);
    expect(renders.mock.calls[0]?.[0]).toBe(firstApi);
  });

  it("unregisters only the registration returned by show", () => {
    let unregisterOld: (() => void) | null = null;
    act(() => {
      unregisterOld = api?.show({ id: "update", title: "Old" }) ?? null;
      api?.show({ id: "update", title: "New" });
    });

    act(() => {
      unregisterOld?.();
    });

    expect(container?.textContent).toContain("New");
  });

  it("persists dismissals by dismissal key", () => {
    act(() => {
      api?.show({
        id: "update",
        dismissalKey: "desktop-update:available:1.2.3",
        title: "Update available",
      });
    });

    expect(container?.textContent).toContain("Update available");

    act(() => {
      api?.dismiss("update");
    });

    expect(container?.textContent).not.toContain("Update available");
    expect(asyncStorage.setItem).toHaveBeenCalledWith(
      "@paseo:sidebar-callout-dismissals",
      JSON.stringify(["desktop-update:available:1.2.3"]),
    );

    act(() => {
      api?.show({
        id: "update",
        dismissalKey: "desktop-update:available:1.2.3",
        title: "Dismissed update",
      });
    });

    expect(container?.textContent).not.toContain("Dismissed update");

    act(() => {
      api?.show({
        id: "update",
        dismissalKey: "desktop-update:available:1.2.4",
        title: "New update",
      });
    });

    expect(container?.textContent).toContain("New update");
  });
});
