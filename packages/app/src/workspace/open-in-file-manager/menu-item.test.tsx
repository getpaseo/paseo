/**
 * @vitest-environment jsdom
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }),
  });
});

import React from "react";
import { OpenInFileManagerMenuItem } from "./menu-item";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" },
    iconSize: { sm: 14 },
    shadow: { md: {} },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
      borderAccent: "#555",
      palette: {
        green: { 500: "#22c55e" },
        amber: { 500: "#f59e0b" },
        red: { 500: "#ef4444" },
        blue: { 500: "#3b82f6" },
      },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  useUnistyles: () => ({ theme }),
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: {
      uniProps?: (theme: unknown) => Record<string, unknown>;
    } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("lucide-react-native", () => ({
  FolderOpen: () => React.createElement("span", { "data-icon": "FolderOpen" }),
}));

vi.mock("@/constants/platform", () => ({
  getIsElectron: vi.fn(),
  isWeb: true,
  isNative: false,
  isDev: false,
  getIsElectronMac: vi.fn().mockReturnValue(false),
}));

vi.mock("@/hooks/use-is-local-daemon", () => ({
  useIsLocalDaemon: vi.fn(),
}));

vi.mock("@/workspace/desktop-open-targets", () => ({
  useDesktopOpenTargets: vi.fn(),
  openDesktopTarget: vi.fn(),
}));

const mockT = vi.fn((key: string) => {
  const map: Record<string, string> = {
    "sidebar.project.actions.openFolder": "Open in file manager",
    "sidebar.project.actions.openFolderFailed": "Couldn't open folder",
  };
  return map[key] ?? key;
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mockT }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: vi.fn() }),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  DropdownMenuItem: ({
    children,
    testID,
    leading,
  }: {
    children?: React.ReactNode;
    testID?: string;
    leading?: React.ReactNode;
  }) => React.createElement("button", { type: "button", "data-testid": testID }, leading, children),
}));

import { getIsElectron } from "@/constants/platform";
import { useIsLocalDaemon } from "@/hooks/use-is-local-daemon";
import { useDesktopOpenTargets } from "@/workspace/desktop-open-targets";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function createFileManagerTargets() {
  return [
    {
      id: "explorer",
      label: "Explorer",
      kind: "file-manager" as const,
      icon: { kind: "symbol" as const, name: "folder" as const },
    },
  ];
}

describe("OpenInFileManagerMenuItem", () => {
  describe("visibility", () => {
    it("renders null when not in Electron", () => {
      vi.mocked(getIsElectron).mockReturnValue(false);
      vi.mocked(useIsLocalDaemon).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({
        targets: createFileManagerTargets(),
        isAvailable: true,
      });

      const { container } = render(
        <OpenInFileManagerMenuItem path="/home/user/project" testID="test-menu" />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("renders null when path is empty", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({
        targets: createFileManagerTargets(),
        isAvailable: true,
      });

      const { container } = render(<OpenInFileManagerMenuItem path="" testID="test-menu" />);
      expect(container.innerHTML).toBe("");
    });

    it("renders null when path is only whitespace", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({
        targets: createFileManagerTargets(),
        isAvailable: true,
      });

      const { container } = render(<OpenInFileManagerMenuItem path="   " testID="test-menu" />);
      expect(container.innerHTML).toBe("");
    });

    it("renders null when no file-manager targets are available", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({ targets: [], isAvailable: false });

      const { container } = render(
        <OpenInFileManagerMenuItem path="/home/user/project" testID="test-menu" />,
      );
      expect(container.innerHTML).toBe("");
    });
  });

  describe("serverId prop - remote host detection", () => {
    it("renders null when serverId is provided and daemon is remote", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(false);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({ targets: [], isAvailable: false });

      const { container } = render(
        <OpenInFileManagerMenuItem
          path="/home/user/project"
          serverId="remote-host-123"
          testID="test-menu"
        />,
      );
      expect(container.innerHTML).toBe("");
    });

    it("passes isLocalExecution=false to useDesktopOpenTargets when serverId is remote", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(false);

      render(
        <OpenInFileManagerMenuItem
          path="/home/user/project"
          serverId="remote-host-123"
          testID="test-menu"
        />,
      );

      expect(useDesktopOpenTargets).toHaveBeenCalledWith({ isLocalExecution: false });
    });

    it("renders menu item when serverId is provided and daemon is local", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({
        targets: createFileManagerTargets(),
        isAvailable: true,
      });

      const { getByText } = render(
        <OpenInFileManagerMenuItem
          path="/home/user/project"
          serverId="local-host-123"
          testID="test-menu"
        />,
      );
      expect(getByText("Open in file manager")).toBeDefined();
    });

    it("passes isLocalExecution=true to useDesktopOpenTargets when serverId is local", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(true);

      render(
        <OpenInFileManagerMenuItem
          path="/home/user/project"
          serverId="local-host-123"
          testID="test-menu"
        />,
      );

      expect(useDesktopOpenTargets).toHaveBeenCalledWith({ isLocalExecution: true });
    });

    it("calls useIsLocalDaemon with the provided serverId", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);

      render(
        <OpenInFileManagerMenuItem
          path="/home/user/project"
          serverId="some-host-456"
          testID="test-menu"
        />,
      );

      expect(useIsLocalDaemon).toHaveBeenCalledWith("some-host-456");
    });

    it("trims serverId before passing to useIsLocalDaemon", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);

      render(
        <OpenInFileManagerMenuItem
          path="/home/user/project"
          serverId="  spaced-host  "
          testID="test-menu"
        />,
      );

      expect(useIsLocalDaemon).toHaveBeenCalledWith("spaced-host");
    });
  });

  describe("backward compatibility - no serverId prop", () => {
    it("renders menu item when serverId is not provided and all other conditions are met", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({
        targets: createFileManagerTargets(),
        isAvailable: true,
      });

      const { getByText } = render(
        <OpenInFileManagerMenuItem path="/home/user/project" testID="test-menu" />,
      );
      expect(getByText("Open in file manager")).toBeDefined();
    });

    it("passes isLocalExecution=true to useDesktopOpenTargets when serverId is absent", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);

      render(<OpenInFileManagerMenuItem path="/home/user/project" testID="test-menu" />);

      expect(useDesktopOpenTargets).toHaveBeenCalledWith({ isLocalExecution: true });
    });

    it("renders menu item when serverId is null and all other conditions are met", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({
        targets: createFileManagerTargets(),
        isAvailable: true,
      });

      const { getByText } = render(
        <OpenInFileManagerMenuItem path="/home/user/project" serverId={null} testID="test-menu" />,
      );
      expect(getByText("Open in file manager")).toBeDefined();
    });
  });

  describe("rendering", () => {
    it("renders the menu item with correct testID", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({
        targets: createFileManagerTargets(),
        isAvailable: true,
      });

      const { getByTestId } = render(
        <OpenInFileManagerMenuItem path="/home/user/project" testID="custom-test-id" />,
      );
      expect(getByTestId("custom-test-id")).toBeDefined();
    });

    it("renders the translated 'Open in file manager' label", () => {
      vi.mocked(getIsElectron).mockReturnValue(true);
      vi.mocked(useIsLocalDaemon).mockReturnValue(true);
      vi.mocked(useDesktopOpenTargets).mockReturnValue({
        targets: createFileManagerTargets(),
        isAvailable: true,
      });

      const { getByText } = render(
        <OpenInFileManagerMenuItem path="/home/user/project" testID="test-menu" />,
      );
      expect(getByText("Open in file manager")).toBeDefined();
    });
  });
});
