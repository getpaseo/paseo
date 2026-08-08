/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig, TerminalProfile } from "@getpaseo/protocol/messages";

// host-page.tsx builds its icons as module-scope JSX and the app compiles JSX to
// `React.createElement`, so React has to be global before that module evaluates.
// The static `import React` above cannot do it: vitest hoists every static import
// to the top of the file, so any statement using it already runs too late. Only a
// hoisted block runs earlier, and a hoisted block has no static bindings to read.
await vi.hoisted(async () => {
  (globalThis as Record<string, unknown>).React = await import("react");
});

const { theme, hostState, configState, patchConfigMock, confirmDialogMock } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24 },
    iconSize: { sm: 14, md: 20 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400", medium: "500" },
    borderRadius: { md: 6, lg: 8, full: 9999 },
    opacity: { 50: 0.5 },
    colors: {
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      border: "#555",
      destructive: "#f00",
      statusDanger: "#f00",
      palette: { red: { 300: "#f88" }, green: { 400: "#8f8" }, amber: { 500: "#fc0" } },
    },
  },
  hostState: {
    supportsDefaultProfile: true,
    shells: [] as Array<{ id: string; path: string }>,
    systemShellPath: "C:\\Windows\\System32\\cmd.exe",
  },
  configState: {
    config: null as MutableDaemonConfig | null,
  },
  patchConfigMock: vi.fn(async () => undefined),
  confirmDialogMock: vi.fn(async () => true),
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  Platform: {
    OS: "web",
    select: (choices: Record<string, unknown>) => choices.web ?? choices.default,
  },
  View: ({
    children,
    testID,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    testID?: string;
    accessibilityLabel?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID, "aria-label": accessibilityLabel },
      children,
    ),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
  Pressable: ({
    children,
    onPress,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    testID?: string;
  }) => React.createElement("div", { "data-testid": testID, onClick: onPress }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme, rt: { breakpoint: "md" } }),
  withUnistyles: (component: unknown) => component,
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => React.createElement("span", { "data-icon": name });
  return {
    ArrowDown: icon("ArrowDown"),
    ArrowUp: icon("ArrowUp"),
    ArrowUpToLine: icon("ArrowUpToLine"),
    Check: icon("Check"),
    ChevronRight: icon("ChevronRight"),
    CircleCheck: icon("CircleCheck"),
    Globe: icon("Globe"),
    Monitor: icon("Monitor"),
    Pencil: icon("Pencil"),
    Plus: icon("Plus"),
    RotateCw: icon("RotateCw"),
    SquareTerminal: icon("SquareTerminal"),
    Trash2: icon("Trash2"),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "settings.host.terminalProfiles.sectionTitle": "Terminal profiles",
        "settings.host.terminalProfiles.addProfileTitle": "Add terminal profile",
        "settings.host.terminalProfiles.addProfile": "Add profile...",
        "settings.host.terminalProfiles.detectedShells": "Detected shells",
        "settings.host.terminalProfiles.setAsDefault": "Set as default",
        "settings.host.terminalProfiles.defaultMarker": "Default profile",
        "settings.host.terminalProfiles.systemShell": "System shell",
        "settings.host.terminalProfiles.systemShellUnknown": "Resolved by the host",
        "settings.host.terminalProfiles.defaultHint": "New terminal opens the marked row.",
        "settings.host.terminalProfiles.remove": "Remove",
        "settings.host.terminalProfiles.moveUp": "Move up",
        "settings.host.terminalProfiles.moveDown": "Move down",
        "settings.host.terminalProfiles.editProfile": "Edit profile",
        "settings.host.terminalProfiles.emptyState": "No profiles yet",
      })[key] ?? key,
  }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    accessibilityLabel,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        disabled,
        onClick: disabled ? undefined : onPress,
      },
      children,
    ),
}));

// The popover renders its sub pages as siblings of the root page, so the stub
// renders both: a submenu item is reachable without driving hover intent.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuContent: ({
    children,
    pages,
  }: {
    children?: React.ReactNode;
    pages?: readonly { id: string; title: string; content: React.ReactNode }[];
  }) =>
    React.createElement(
      "div",
      null,
      children,
      (pages ?? []).map((page) =>
        React.createElement("div", { key: page.id, "data-page": page.id }, page.content),
      ),
    ),
  DropdownMenuTrigger: ({
    children,
    accessibilityLabel,
    disabled,
    testID,
  }: {
    children?: React.ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        disabled,
      },
      children,
    ),
  DropdownMenuItem: ({
    children,
    description,
    onSelect,
    testID,
  }: {
    children?: React.ReactNode;
    description?: string;
    onSelect?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, "data-description": description, onClick: onSelect },
      children,
    ),
  DropdownMenuSubTrigger: ({
    children,
    id,
    testID,
  }: {
    children?: React.ReactNode;
    id?: string;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, "data-sub": id },
      children,
    ),
}));

vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/components/adaptive-modal-sheet", () => ({ AdaptiveModalSheet: () => null }));
vi.mock("@/components/settings-textarea", () => ({ SettingsTextAreaCard: () => null }));
vi.mock("@/components/ui/alert", () => ({ Alert: () => null }));
vi.mock("@/components/provider-icons", () => ({ getProviderIcon: () => () => null }));
vi.mock("@/screens/settings/terminal-profile-edit-modal", () => ({
  TerminalProfileEditModal: () => null,
}));
vi.mock("@/screens/settings/providers-section", () => ({ ProvidersSection: () => null }));
vi.mock("@/screens/settings/host-appearance-section", () => ({
  HostAppearanceSection: () => null,
}));
vi.mock("@/provider-usage/settings-section", () => ({ ProviderUsageSettingsSection: () => null }));
vi.mock("@/provider-usage/use-provider-usage", () => ({ useProviderUsage: () => ({}) }));
vi.mock("./browser-tools-card", () => ({ BrowserToolsOptInCard: () => null }));
vi.mock("@/desktop/components/desktop-updates-section", () => ({ LocalDaemonSection: () => null }));
vi.mock("@/desktop/components/pair-device-modal", () => ({ PairDeviceModal: () => null }));
vi.mock("@/desktop/hooks/use-daemon-status", () => ({ useDaemonStatus: () => ({ status: null }) }));
vi.mock("@/utils/app-version", () => ({ resolveAppVersion: () => "0.0.0" }));
vi.mock("@/desktop/settings/desktop-settings", () => ({
  loadDesktopSettings: vi.fn(),
  useDesktopSettings: () => ({}),
}));
vi.mock("@/desktop/daemon/desktop-daemon", () => ({
  getDesktopDaemonStatus: vi.fn(),
  restartDesktopDaemon: vi.fn(),
  startDesktopDaemon: vi.fn(),
  stopDesktopDaemon: vi.fn(),
}));
vi.mock("@/desktop/updates/desktop-updates", () => ({ isVersionMismatch: () => false }));
vi.mock("@/constants/platform", () => ({ getIsElectron: () => false }));
vi.mock("@/hooks/use-is-local-daemon", () => ({ useIsLocalDaemon: () => false }));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({
    config: configState.config,
    isLoading: false,
    patchConfig: patchConfigMock,
  }),
}));

// A single client object: the section keys its shell query on the server id, and
// a client recreated per render would be a dependency that never settles.
const stubClient = { listTerminalShells: vi.fn() };
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({ getSnapshot: () => null }),
  isHostRuntimeConnected: () => true,
  useHostMutations: () => ({}),
  useHostRuntimeClient: () => stubClient,
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeSnapshot: () => null,
  useHosts: () => [{ serverId: "server-1", label: "Host" }],
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      sessions: {
        "server-1": {
          serverInfo: { features: { defaultTerminalProfile: hostState.supportsDefaultProfile } },
        },
      },
    }),
}));

vi.mock("@/data/query", () => ({
  useFetchQuery: () => ({
    data: { shells: hostState.shells, systemShellPath: hostState.systemShellPath },
  }),
}));

vi.mock("@/utils/confirm-dialog", () => ({ confirmDialog: confirmDialogMock }));

import { HostTerminalsPage } from "./host-page";

const PWSH_PATH = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

const claudeProfile: TerminalProfile = { id: "claude", name: "Claude Code", command: "claude" };
const codexProfile: TerminalProfile = { id: "codex", name: "Codex", command: "codex" };

function makeConfig(overrides: Partial<MutableDaemonConfig> = {}): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { injectIntoAgents: false },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    terminalProfiles: [claudeProfile, codexProfile],
    defaultTerminalProfileId: "",
    ...overrides,
  };
}

describe("HostTerminalsPage terminal profiles", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    hostState.supportsDefaultProfile = true;
    hostState.shells = [];
    configState.config = makeConfig();
    patchConfigMock.mockReset();
    patchConfigMock.mockResolvedValue(undefined);
    confirmDialogMock.mockReset();
    confirmDialogMock.mockResolvedValue(true);
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
    vi.unstubAllGlobals();
  });

  function render(): void {
    act(() => {
      root?.render(<HostTerminalsPage serverId="server-1" />);
    });
  }

  function find(testID: string): HTMLElement | null {
    return container?.querySelector<HTMLElement>(`[data-testid="${testID}"]`) ?? null;
  }

  async function press(testID: string): Promise<void> {
    const element = find(testID);
    if (!element) throw new Error(`Expected an element with testID "${testID}"`);
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });
    // confirmDialog and patchConfig both settle a microtask after the press.
    await act(async () => {});
  }

  // Without a row of its own the system shell was unreachable: the marker could
  // only move between profiles, so marking one was a one-way door.
  it("shows the system shell as a row carrying the mark when no profile is default", () => {
    render();

    const row = find("terminal-profile-row-system-shell");
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("System shell");
    expect(row?.textContent).toContain("C:\\Windows\\System32\\cmd.exe");
    expect(find("terminal-profile-default-system-shell")).not.toBeNull();
    expect(find("terminal-profile-set-default-system-shell")?.hasAttribute("disabled")).toBe(true);
  });

  it("returns to the system shell by clearing the default id", async () => {
    configState.config = makeConfig({ defaultTerminalProfileId: "codex" });

    render();

    expect(find("terminal-profile-default-system-shell")).toBeNull();
    expect(find("terminal-profile-set-default-system-shell")?.hasAttribute("disabled")).toBe(false);

    await press("terminal-profile-set-default-system-shell");

    expect(patchConfigMock).toHaveBeenCalledTimes(1);
    expect(patchConfigMock).toHaveBeenCalledWith({ defaultTerminalProfileId: "" });
  });

  it("hides the system shell row on a host that cannot honor a default", () => {
    hostState.supportsDefaultProfile = false;

    render();

    expect(find("terminal-profile-row-system-shell")).toBeNull();
  });

  it("marks only the profile the host opens by default", () => {
    configState.config = makeConfig({ defaultTerminalProfileId: "codex" });

    render();

    expect(find("terminal-profile-default-codex")).not.toBeNull();
    expect(find("terminal-profile-default-claude")).toBeNull();
    expect(find("terminal-profile-default-codex")?.getAttribute("aria-label")).toBe(
      "Default profile",
    );
    // The row that already is the default has nothing left to set.
    expect(find("terminal-profile-set-default-codex")?.hasAttribute("disabled")).toBe(true);
    expect(find("terminal-profile-set-default-claude")?.hasAttribute("disabled")).toBe(false);
  });

  it("patches defaultTerminalProfileId when a row is set as default", async () => {
    render();

    await press("terminal-profile-set-default-claude");

    expect(patchConfigMock).toHaveBeenCalledTimes(1);
    expect(patchConfigMock).toHaveBeenCalledWith({ defaultTerminalProfileId: "claude" });
  });

  it("clears the default in the same patch that removes its profile", async () => {
    configState.config = makeConfig({ defaultTerminalProfileId: "codex" });

    render();

    await press("terminal-profile-remove-codex");

    expect(patchConfigMock).toHaveBeenCalledWith({
      terminalProfiles: [claudeProfile],
      defaultTerminalProfileId: "",
    });
  });

  it("leaves the default alone when a different profile is removed", async () => {
    configState.config = makeConfig({ defaultTerminalProfileId: "codex" });

    render();

    await press("terminal-profile-remove-claude");

    expect(patchConfigMock).toHaveBeenCalledWith({ terminalProfiles: [codexProfile] });
  });

  it("creates a profile carrying the detected shell's resolved path", async () => {
    hostState.shells = [{ id: "pwsh", path: PWSH_PATH }];

    render();

    // The item shows only the label; the path is what the profile has to carry.
    await press("terminal-profiles-add-shell-pwsh");

    expect(patchConfigMock).toHaveBeenCalledTimes(1);
    expect(patchConfigMock).toHaveBeenCalledWith({
      terminalProfiles: [
        claudeProfile,
        codexProfile,
        {
          id: expect.stringMatching(/^profile_/),
          name: "PowerShell 7 (pwsh)",
          command: PWSH_PATH,
          args: [],
        },
      ],
    });
  });

  it("does not offer a shell that already backs a profile", () => {
    configState.config = makeConfig({
      terminalProfiles: [{ id: "shell", name: "PowerShell 7 (pwsh)", command: PWSH_PATH }],
    });
    hostState.shells = [
      { id: "pwsh", path: PWSH_PATH },
      { id: "cmd", path: "C:\\Windows\\system32\\cmd.exe" },
    ];

    render();

    expect(find("terminal-profiles-add-shell-pwsh")).toBeNull();
    expect(find("terminal-profiles-add-shell-cmd")).not.toBeNull();
  });

  it("renders the list without any default affordance on a host that lacks the feature", () => {
    hostState.supportsDefaultProfile = false;
    configState.config = makeConfig({ defaultTerminalProfileId: "codex" });

    render();

    expect(find("terminal-profile-row-codex")).not.toBeNull();
    expect(find("terminal-profile-default-codex")).toBeNull();
    expect(find("terminal-profile-set-default-codex")).toBeNull();
    expect(find("terminal-profiles-add-profile")).not.toBeNull();
  });
});
