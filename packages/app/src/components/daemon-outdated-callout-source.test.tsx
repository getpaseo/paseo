/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
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

const host = vi.hoisted(() => ({
  serverInfo: {
    version: "0.11.4",
    desktopManaged: false,
    features: { daemonSelfUpdate: true, terminalsSurviveRestart: true },
  },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: { getItem: vi.fn(async () => null), setItem: vi.fn(async () => {}) },
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

vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "srv_alpha", label: "Workstation" }],
  useHostRuntimeClient: () => null,
  useHostRuntimeIsConnected: () => true,
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerId: () => "srv_alpha",
}));

vi.mock("@/stores/navigation-active-workspace-store", () => ({
  useLastWorkspaceSelection: () => null,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({ sessions: { srv_alpha: { serverInfo: host.serverInfo } } }),
}));

vi.mock("@/utils/app-version", () => ({
  resolveAppVersion: () => "0.12.0",
}));

vi.mock("@/screens/settings/daemon-lifecycle", () => ({
  updateDaemonFromSettings: vi.fn(),
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: vi.fn(),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { SidebarCalloutProvider } from "@/contexts/sidebar-callout-context";
import { DaemonOutdatedCalloutSource } from "./daemon-outdated-callout-source";
// The iOS and Android sidebar outlet, imported by its platform file.
import { SidebarCalloutSlot as NativeSidebarCalloutSlot } from "./sidebar-callout-slot.native";

describe("DaemonOutdatedCalloutSource on native", () => {
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

  it("shows the notice and its Update button in the native sidebar", async () => {
    await act(async () => {
      root?.render(
        <SidebarCalloutProvider>
          <DaemonOutdatedCalloutSource />
          <NativeSidebarCalloutSlot />
        </SidebarCalloutProvider>,
      );
      await Promise.resolve();
    });

    const callout = container?.querySelector('[data-testid="daemon-outdated-callout"]');
    expect(callout?.textContent).toContain("Daemon out of date");
    expect(callout?.textContent).toContain("Workstation runs daemon v0.11.4. This app is v0.12.0.");
    expect(callout?.textContent).toContain("Updating restarts the daemon. Terminals stay open.");
    expect(
      container?.querySelector('[data-testid="daemon-outdated-callout-update"]')?.textContent,
    ).toBe("Update");
  });
});
