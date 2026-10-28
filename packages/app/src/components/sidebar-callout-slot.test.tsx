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
  getItem: vi.fn(async () => null),
  setItem: vi.fn(async () => {}),
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

import { SidebarCalloutProvider, useSidebarCallouts } from "@/contexts/sidebar-callout-context";
import { SidebarCalloutSlot } from "./sidebar-callout-slot";

function RegisterCallout() {
  const callouts = useSidebarCallouts();
  useEffect(
    () =>
      callouts.show({
        id: "slot-test",
        title: "Update available",
        description: "v1 is ready.",
        testID: "slot-test-callout",
      }),
    [callouts],
  );
  return null;
}

describe("SidebarCalloutSlot", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
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

  it("renders the active sidebar callout", async () => {
    await act(async () => {
      root?.render(
        <SidebarCalloutProvider>
          <RegisterCallout />
          <SidebarCalloutSlot />
        </SidebarCalloutProvider>,
      );
      await Promise.resolve();
    });

    expect(container?.textContent).toContain("Update available");
    expect(container?.textContent).toContain("v1 is ready.");
  });

  it("renders nothing when there is no active callout", async () => {
    await act(async () => {
      root?.render(
        <SidebarCalloutProvider>
          <SidebarCalloutSlot />
        </SidebarCalloutProvider>,
      );
      await Promise.resolve();
    });

    expect(container?.querySelector('[data-testid="slot-test-callout"]')).toBeNull();
  });
});
