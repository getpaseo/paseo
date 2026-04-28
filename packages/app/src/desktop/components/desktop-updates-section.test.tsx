/**
 * @vitest-environment jsdom
 */
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalDaemonSection } from "./desktop-updates-section";

const { alertMock, confirmDialogMock, settingsState, daemonStatusState } = vi.hoisted(() => ({
  alertMock: vi.fn(),
  confirmDialogMock: vi.fn(),
  settingsState: {
    settings: {
      releaseChannel: "stable" as const,
      daemon: {
        manageBuiltInDaemon: true,
        keepRunningAfterQuit: true,
      },
    },
    updateSettings: vi.fn<
      (updates: {
        daemon?: {
          manageBuiltInDaemon?: boolean;
          keepRunningAfterQuit?: boolean;
        };
      }) => Promise<void>
    >(),
  },
  daemonStatusState: {
    data: {
      status: {
        serverId: "desktop",
        status: "running" as const,
        listen: null,
        hostname: null,
        pid: 123,
        home: "/tmp/paseo",
        version: "1.2.3",
        desktopManaged: true,
        error: null,
      },
      logs: {
        logPath: "/tmp/paseo/daemon.log",
        contents: "daemon log",
      },
    },
    isLoading: false,
    error: null as string | null,
    setStatus: vi.fn(),
    refetch: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  ActivityIndicator: () => React.createElement("div", { "data-testid": "loading-spinner" }),
  Alert: { alert: alertMock },
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  View: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (theme: Record<string, unknown>) => unknown)({
            spacing: { 1: 4, 2: 8, 3: 12, 6: 24 },
            borderRadius: { lg: 12 },
            fontSize: { xs: 12, sm: 14 },
            colors: {
              foreground: "#111",
              foregroundMuted: "#666",
              palette: { amber: { 500: "#f59e0b" } },
            },
          })
        : factory,
  },
  useUnistyles: () => ({
    theme: {
      iconSize: { sm: 14 },
      colors: {
        foreground: "#111",
        foregroundMuted: "#666",
      },
    },
  }),
}));

vi.mock("expo-clipboard", () => ({
  setStringAsync: vi.fn(() => Promise.resolve()),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    Activity: icon("Activity"),
    ArrowUpRight: icon("ArrowUpRight"),
    Copy: icon("Copy"),
    FileText: icon("FileText"),
  };
});

vi.mock("@/styles/settings", () => ({
  settingsStyles: new Proxy(
    {},
    {
      get: (_target, prop) => String(prop),
    },
  ),
}));

vi.mock("@/screens/settings/settings-section", () => ({
  SettingsSection: ({
    children,
    title,
    trailing,
  }: {
    children?: React.ReactNode;
    title: string;
    trailing?: React.ReactNode;
  }) =>
    React.createElement(
      "section",
      null,
      React.createElement("h2", null, title),
      trailing,
      children,
    ),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    children,
    visible,
    title,
  }: {
    children?: React.ReactNode;
    visible?: boolean;
    title?: string;
  }) => (visible ? React.createElement("div", { "data-title": title }, children) : null),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", onClick: onPress, disabled, "aria-label": accessibilityLabel },
      children,
    ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange?: (next: boolean) => void;
    disabled?: boolean;
    accessibilityLabel?: string;
  }) =>
    React.createElement("button", {
      type: "button",
      role: "switch",
      "aria-label": accessibilityLabel,
      "aria-checked": value,
      disabled,
      onClick: () => onValueChange?.(!value),
    }),
}));

vi.mock("@/desktop/settings/desktop-settings", () => ({
  useDesktopSettings: () => ({
    ...settingsState,
    isLoading: false,
    error: null,
  }),
}));

vi.mock("@/desktop/hooks/use-daemon-status", () => ({
  useDaemonStatus: () => daemonStatusState,
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: confirmDialogMock,
}));

vi.mock("@/utils/open-external-url", () => ({
  openExternalUrl: vi.fn(),
}));

vi.mock("@/desktop/updates/desktop-updates", () => ({
  isVersionMismatch: vi.fn(() => false),
}));

const daemonCommandMocks = vi.hoisted(() => ({
  getCliDaemonStatusMock: vi.fn(),
  stopDesktopDaemonMock: vi.fn(),
}));

vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  getCliDaemonStatus: daemonCommandMocks.getCliDaemonStatusMock,
  shouldUseDesktopDaemon: vi.fn(() => true),
  stopDesktopDaemon: daemonCommandMocks.stopDesktopDaemonMock,
}));

vi.mock("@/utils/app-version", () => ({
  resolveAppVersion: vi.fn(() => "1.2.3"),
}));

describe("LocalDaemonSection", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    alertMock.mockReset();
    confirmDialogMock.mockReset();
    settingsState.settings.daemon.manageBuiltInDaemon = true;
    settingsState.settings.daemon.keepRunningAfterQuit = true;
    settingsState.updateSettings.mockReset();
    settingsState.updateSettings.mockResolvedValue();
    daemonStatusState.data.status.status = "running";
    daemonStatusState.setStatus.mockReset();
    daemonStatusState.refetch.mockReset();
    daemonCommandMocks.stopDesktopDaemonMock.mockReset();
    daemonCommandMocks.stopDesktopDaemonMock.mockResolvedValue({
      ...daemonStatusState.data.status,
      status: "stopped",
    });
    daemonCommandMocks.getCliDaemonStatusMock.mockReset();
  });

  it("renders the daemon toggles as switches reflecting current settings", () => {
    const screen = render(<LocalDaemonSection />);

    expect(screen.getByText("Keep daemon running after quit")).toBeTruthy();
    expect(screen.getByText("Manage built-in daemon")).toBeTruthy();

    const keepRunningSwitch = screen.getByRole("switch", {
      name: "Keep daemon running after quit",
    });
    expect(keepRunningSwitch.getAttribute("aria-checked")).toBe("true");

    const manageSwitch = screen.getByRole("switch", { name: "Manage built-in daemon" });
    expect(manageSwitch.getAttribute("aria-checked")).toBe("true");
  });

  it("does not render a duplicate restart-daemon control", () => {
    const screen = render(<LocalDaemonSection />);

    expect(screen.queryByText("Restart daemon")).toBeNull();
    expect(screen.queryByText("Start daemon")).toBeNull();
  });

  it("updates keep-running-after-quit without changing daemon lifecycle", async () => {
    const screen = render(<LocalDaemonSection />);

    fireEvent.click(screen.getByRole("switch", { name: "Keep daemon running after quit" }));

    await waitFor(() => {
      expect(settingsState.updateSettings).toHaveBeenCalledWith({
        daemon: {
          keepRunningAfterQuit: false,
        },
      });
    });
    expect(confirmDialogMock).not.toHaveBeenCalled();
    expect(daemonCommandMocks.stopDesktopDaemonMock).not.toHaveBeenCalled();
  });

  it("pauses built-in daemon management and persists the setting through desktop settings", async () => {
    confirmDialogMock.mockResolvedValue(true);
    const screen = render(<LocalDaemonSection />);

    fireEvent.click(screen.getByRole("switch", { name: "Manage built-in daemon" }));

    await waitFor(() => {
      expect(daemonCommandMocks.stopDesktopDaemonMock).toHaveBeenCalledTimes(1);
    });
    expect(settingsState.updateSettings).toHaveBeenCalledWith({
      daemon: {
        manageBuiltInDaemon: false,
      },
    });
  });
});
