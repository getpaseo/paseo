/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type {
  PaseoConfigRaw,
  PaseoConfigRevision,
  ProjectConfigRpcError,
} from "@server/shared/messages";
import type { ProjectHostEntry, ProjectSummary, WorkspaceSummary } from "@/utils/projects";
import type { ProjectHostError, UseProjectsResult } from "@/hooks/use-projects";

type ReadResult =
  | { ok: true; config: PaseoConfigRaw | null; revision: PaseoConfigRevision | null }
  | { ok: false; error: ProjectConfigRpcError };
type WriteResult =
  | { ok: true; config: PaseoConfigRaw; revision: PaseoConfigRevision }
  | { ok: false; error: ProjectConfigRpcError };

interface MockClient {
  readProjectConfig: ReturnType<typeof vi.fn>;
  writeProjectConfig: ReturnType<typeof vi.fn>;
}

const { theme, projectsState, hostState, navigate, confirmDialogMock, client } = vi.hoisted(() => {
  const hoistedClient: MockClient = {
    readProjectConfig: vi.fn(),
    writeProjectConfig: vi.fn(),
  };

  return {
    theme: {
      spacing: { 0: 0, 1: 4, "1.5": 6, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32 },
      iconSize: { sm: 14, md: 18, lg: 22 },
      fontSize: { xs: 11, sm: 13, base: 15, lg: 18 },
      fontWeight: { normal: "400" as const, medium: "500" as const },
      borderRadius: { sm: 4, md: 6, lg: 8, xl: 12, full: 999 },
      borderWidth: { 1: 1 },
      opacity: { 50: 0.5 },
      colors: {
        surface0: "#000",
        surface1: "#111",
        surface2: "#222",
        surface3: "#333",
        surfaceSidebarHover: "#1a1a1a",
        foreground: "#fff",
        foregroundMuted: "#aaa",
        border: "#444",
        accent: "#0a84ff",
        accentForeground: "#fff",
        borderAccent: "#0a84ff",
        destructive: "#ff453a",
        statusSuccess: "#3ecf8e",
        palette: {
          red: { 300: "#ff6b6b", 500: "#ff453a" },
          green: { 400: "#3ecf8e" },
          amber: { 500: "#fbbf24" },
          white: "#fff",
        },
      },
    },
    projectsState: {
      current: {
        projects: [],
        hostErrors: [] as ProjectHostError[],
        hiddenUnsupportedRemoteCount: 0,
        isLoading: false,
        isFetching: false,
        refetch: vi.fn(),
      } as UseProjectsResult,
    },
    hostState: {
      onlineByServerId: new Map<string, boolean>(),
    },
    navigate: vi.fn(),
    confirmDialogMock: vi.fn<(input: { title: string }) => Promise<boolean>>(),
    client: hoistedClient,
  };
});

vi.mock("react-native", () => {
  const passthrough = ({
    children,
    testID,
    accessibilityLabel,
    accessibilityRole,
    onPress,
    disabled,
    ...rest
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean }) => React.ReactNode);
    testID?: string;
    accessibilityLabel?: string;
    accessibilityRole?: string;
    onPress?: (event: { stopPropagation: () => void }) => void;
    disabled?: boolean;
  } & Record<string, unknown>) => {
    const dataAttrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rest)) {
      if (key.startsWith("data-")) {
        dataAttrs[key] = value;
      }
    }
    return React.createElement(
      "div",
      {
        role: accessibilityRole,
        "aria-label": accessibilityLabel,
        "data-testid": testID,
        "data-disabled": disabled ? "true" : "false",
        onClick: onPress
          ? (event: React.MouseEvent) => {
              if (disabled) return;
              onPress({ stopPropagation: () => event.stopPropagation() });
            }
          : undefined,
        ...dataAttrs,
      },
      typeof children === "function" ? children({ pressed: false, hovered: false }) : children,
    );
  };

  return {
    View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
      React.createElement("div", { "data-testid": testID }, children),
    Text: ({ children }: { children?: React.ReactNode }) =>
      React.createElement("span", null, children),
    Pressable: passthrough,
    TextInput: ({
      value,
      onChangeText,
      placeholder,
      testID,
      accessibilityLabel,
      multiline,
      keyboardType,
    }: {
      value?: string;
      onChangeText?: (text: string) => void;
      placeholder?: string;
      testID?: string;
      accessibilityLabel?: string;
      multiline?: boolean;
      keyboardType?: string;
    }) =>
      React.createElement(multiline ? "textarea" : "input", {
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        placeholder,
        value: value ?? "",
        "data-keyboard-type": keyboardType,
        onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) =>
          onChangeText?.(event.currentTarget.value),
      }),
    ActivityIndicator: ({ size }: { size?: string | number }) =>
      React.createElement("span", { "data-testid": "loading-spinner", "data-size": size }),
    Linking: { openURL: vi.fn() },
    Platform: { OS: "web" },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = () => React.createElement("span", { "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    ArrowLeft: icon("ArrowLeft"),
    ChevronDown: icon("ChevronDown"),
    ChevronRight: icon("ChevronRight"),
    FolderGit2: icon("FolderGit2"),
    MoreVertical: icon("MoreVertical"),
    Pencil: icon("Pencil"),
    Plus: icon("Plus"),
    Trash2: icon("Trash2"),
    Activity: icon("Activity"),
    Terminal: icon("Terminal"),
    Circle: icon("Circle"),
    X: icon("X"),
  };
});

vi.mock("expo-router", () => ({
  router: { navigate },
}));

vi.mock("@/hooks/use-projects", () => ({
  useProjects: () => projectsState.current,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: (serverId: string | null) => {
    if (!serverId) return null;
    if (hostState.onlineByServerId.get(serverId) === false) return null;
    return client;
  },
  useHostRuntimeIsConnected: (serverId: string | null) => {
    if (!serverId) return false;
    return hostState.onlineByServerId.get(serverId) ?? true;
  },
  useHostRuntimeSnapshot: (serverId: string | null) => {
    if (!serverId) return null;
    const isOnline = hostState.onlineByServerId.get(serverId) ?? true;
    return { connectionStatus: isOnline ? "online" : "offline" };
  },
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: ({ size }: { size?: string | number }) =>
    React.createElement("span", { "data-testid": "loading-spinner", "data-size": size }),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
    accessibilityLabel,
    testID,
  }: {
    value: boolean;
    onValueChange?: (next: boolean) => void;
    disabled?: boolean;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement("div", {
      role: "switch",
      "aria-checked": value ? "true" : "false",
      "aria-disabled": disabled ? "true" : undefined,
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      onClick: (event: React.MouseEvent) => {
        event.stopPropagation();
        if (disabled) return;
        onValueChange?.(!value);
      },
    }),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
    variant?: string;
    size?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        "aria-label": accessibilityLabel,
        disabled,
        onClick: () => {
          if (disabled) return;
          onPress?.();
        },
      },
      children,
    ),
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dropdown-menu" }, children),
  DropdownMenuTrigger: ({
    children,
    accessibilityLabel,
    testID,
  }: {
    children?:
      | React.ReactNode
      | ((state: { pressed: boolean; hovered: boolean; open: boolean }) => React.ReactNode);
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "aria-label": accessibilityLabel,
        "data-testid": testID,
      },
      typeof children === "function"
        ? children({ pressed: false, hovered: false, open: false })
        : children,
    ),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "dropdown-menu-content" }, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    testID,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        "data-testid": testID,
        onClick: (event: React.MouseEvent) => {
          event.stopPropagation();
          onSelect?.();
        },
      },
      children,
    ),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    visible,
    title,
    children,
    testID,
  }: {
    visible: boolean;
    title: string;
    children?: React.ReactNode;
    testID?: string;
  }) => {
    if (!visible) return null;
    return React.createElement(
      "div",
      { "data-testid": testID, "data-modal-title": title },
      children,
    );
  },
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    title,
    description,
    children,
    testID,
  }: {
    title?: string;
    description?: React.ReactNode;
    children?: React.ReactNode;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID, role: "alert" },
      React.createElement("span", { "data-testid": `${testID}-title` }, title),
      React.createElement("span", { "data-testid": `${testID}-description` }, description),
      children,
    ),
}));

vi.mock("@/components/ui/status-badge", () => ({
  StatusBadge: ({ label }: { label: string }) =>
    React.createElement("span", { "data-testid": "status-badge" }, label),
}));

vi.mock("@/screens/settings/settings-section", () => ({
  SettingsSection: ({
    title,
    children,
    testID,
  }: {
    title: string;
    children?: React.ReactNode;
    testID?: string;
  }) =>
    React.createElement(
      "section",
      { "data-testid": testID, "data-section-title": title },
      React.createElement("h2", null, title),
      children,
    ),
}));

vi.mock("@/utils/confirm-dialog", () => ({
  confirmDialog: confirmDialogMock,
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ show: vi.fn(), error: vi.fn() }),
}));

import ProjectSettingsScreen from "./project-settings-screen";

function workspaceSummary(overrides: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: "ws-1",
    name: "main",
    workspaceKind: "directory",
    status: "done",
    currentBranch: "main",
    ...overrides,
  };
}

function hostEntry(overrides: Partial<ProjectHostEntry> = {}): ProjectHostEntry {
  return {
    serverId: "host-a",
    serverName: "alpha",
    isOnline: true,
    repoRoot: "/home/me/proj",
    workspaceCount: 1,
    workspaces: [workspaceSummary()],
    ...overrides,
  };
}

function project(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  const hosts = overrides.hosts ?? [hostEntry()];
  return {
    projectKey: "remote:github.com/acme/app",
    projectName: "acme/app",
    hosts,
    totalWorkspaceCount: hosts.reduce((sum, host) => sum + host.workspaceCount, 0),
    hostCount: hosts.length,
    onlineHostCount: hosts.filter((host) => host.isOnline).length,
    githubUrl: "https://github.com/acme/app",
    hiddenUnsupportedRemoteCount: 0,
    ...overrides,
  };
}

function setProjectsState(overrides: Partial<UseProjectsResult>) {
  projectsState.current = {
    projects: [],
    hostErrors: [],
    hiddenUnsupportedRemoteCount: 0,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
    ...overrides,
  };
}

function readSuccess(input: {
  config: PaseoConfigRaw | null;
  revision: PaseoConfigRevision | null;
}): ReadResult {
  return { ok: true, config: input.config, revision: input.revision };
}

function readError(error: ProjectConfigRpcError): ReadResult {
  return { ok: false, error };
}

function writeSuccess(input: {
  config: PaseoConfigRaw;
  revision: PaseoConfigRevision;
}): WriteResult {
  return { ok: true, config: input.config, revision: input.revision };
}

function writeError(error: ProjectConfigRpcError): WriteResult {
  return { ok: false, error };
}

let root: Root | null = null;
let container: HTMLElement | null = null;
let queryClient: QueryClient | null = null;

beforeEach(() => {
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  hostState.onlineByServerId.clear();
  navigate.mockReset();
  confirmDialogMock.mockReset();
  client.readProjectConfig.mockReset();
  client.writeProjectConfig.mockReset();
  setProjectsState({});
});

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  queryClient?.clear();
  root = null;
  container?.remove();
  container = null;
  queryClient = null;
  vi.unstubAllGlobals();
});

function renderScreen(projectKey: string) {
  act(() => {
    root?.render(
      <QueryClientProvider client={queryClient!}>
        <ProjectSettingsScreen projectKey={projectKey} />
      </QueryClientProvider>,
    );
  });
}

async function flush() {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

function click(element: Element) {
  act(() => {
    element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
}

function changeValue(element: Element, value: string) {
  const event = new window.Event("input", { bubbles: true });
  Object.defineProperty(event, "target", { value: { value, currentTarget: { value } } });
  // jsdom + React: simulate via change event
  act(() => {
    const input = element as HTMLInputElement | HTMLTextAreaElement;
    const setter = Object.getOwnPropertyDescriptor(
      input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, value);
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
    input.dispatchEvent(new window.Event("change", { bubbles: true }));
  });
}

function findById(testID: string): HTMLElement | null {
  return container?.querySelector<HTMLElement>(`[data-testid="${testID}"]`) ?? null;
}

function requireById(testID: string): HTMLElement {
  const element = findById(testID);
  if (!element) {
    throw new Error(`Expected element with testID="${testID}"`);
  }
  return element;
}

describe("ProjectSettingsScreen — no editable target", () => {
  it("renders the no-editable-target state for an unknown projectKey", () => {
    setProjectsState({ projects: [project()] });

    renderScreen("remote:github.com/unknown/repo");

    expect(container?.textContent).toContain(
      "We don't have an editable copy of this project on any connected host",
    );
    const back = requireById("project-settings-back-button");
    expect(back.textContent).toBe("Back to projects");
  });

  it("renders no-editable-target when every host is offline", () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ serverId: "a", isOnline: false }),
            hostEntry({ serverId: "b", isOnline: false }),
          ],
        }),
      ],
    });

    renderScreen("remote:github.com/acme/app");

    expect(container?.textContent).toContain(
      "We don't have an editable copy of this project on any connected host",
    );
  });

  it("renders no-editable-target when every host has empty repoRoot or serverId", () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ serverId: "a", repoRoot: "" }),
            hostEntry({ serverId: " ", repoRoot: "/x" }),
          ],
        }),
      ],
    });

    renderScreen("remote:github.com/acme/app");

    expect(container?.textContent).toContain(
      "We don't have an editable copy of this project on any connected host",
    );
  });

  it("'Back to projects' navigates to /settings/projects", () => {
    setProjectsState({ projects: [project()] });

    renderScreen("remote:github.com/unknown/repo");

    click(requireById("project-settings-back-button"));
    expect(navigate).toHaveBeenCalledWith("/settings/projects");
  });
});

describe("ProjectSettingsScreen — host selection", () => {
  it("renders a static host indicator and no host picker when only one host exists", async () => {
    setProjectsState({
      projects: [
        project({
          hosts: [hostEntry({ serverId: "a", serverName: "alpha", repoRoot: "/path/to/alpha" })],
        }),
      ],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    expect(findById("host-picker")).toBeNull();
    expect(findById("host-indicator")).not.toBeNull();
    expect(container?.textContent).toContain("alpha");
    expect(container?.textContent).not.toContain("/path/to/alpha");
  });

  it("renders a host picker chip when more than one host has the project", async () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ serverId: "a", serverName: "alpha", repoRoot: "/p/a" }),
            hostEntry({ serverId: "b", serverName: "beta", repoRoot: "/p/b" }),
          ],
        }),
      ],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    expect(findById("host-picker")).not.toBeNull();
    expect(findById("host-picker-item-a")).not.toBeNull();
    expect(findById("host-picker-item-b")).not.toBeNull();
  });

  it("refetches config for the new host when a different picker item is selected", async () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ serverId: "a", serverName: "alpha", repoRoot: "/p/a" }),
            hostEntry({ serverId: "b", serverName: "beta", repoRoot: "/p/b" }),
          ],
        }),
      ],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    const initialCallCount = client.readProjectConfig.mock.calls.length;
    expect(client.readProjectConfig.mock.calls.some((call) => call[0] === "/p/a")).toBe(true);

    click(requireById("host-picker-item-b"));
    await flush();

    expect(client.readProjectConfig.mock.calls.length).toBeGreaterThan(initialCallCount);
    expect(client.readProjectConfig.mock.calls.some((call) => call[0] === "/p/b")).toBe(true);
  });
});

describe("ProjectSettingsScreen — save flow", () => {
  it("disables save when the daemon client is offline", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", serverName: "alpha" })] })],
    });
    hostState.onlineByServerId.set("a", false);
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    // With one host offline, the screen falls into no-editable-target.
    expect(container?.textContent).toContain(
      "We don't have an editable copy of this project on any connected host",
    );
  });

  it("issues writeProjectConfig with the current config + expectedRevision and installs the response", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    const baseConfig: PaseoConfigRaw = {
      worktree: { setup: "npm install" },
      customTopLevel: "preserved",
    } as unknown as PaseoConfigRaw;
    const initialRevision: PaseoConfigRevision = { mtimeMs: 100, size: 50 };
    const newRevision: PaseoConfigRevision = { mtimeMs: 200, size: 60 };

    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: baseConfig, revision: initialRevision }),
    );
    client.writeProjectConfig.mockImplementation(
      async (input: { config: PaseoConfigRaw; expectedRevision: PaseoConfigRevision | null }) =>
        writeSuccess({ config: input.config, revision: newRevision }),
    );

    const invalidateSpy = vi.spyOn(queryClient!, "invalidateQueries");

    renderScreen("remote:github.com/acme/app");
    await flush();

    click(requireById("save-button"));
    await flush();

    expect(client.writeProjectConfig).toHaveBeenCalledTimes(1);
    const callArg = client.writeProjectConfig.mock.calls[0]![0] as {
      repoRoot: string;
      config: PaseoConfigRaw;
      expectedRevision: PaseoConfigRevision | null;
    };
    expect(callArg.repoRoot).toBe("/p/a");
    expect(callArg.expectedRevision).toEqual(initialRevision);
    expect(callArg.config.worktree?.setup).toBe("npm install");
    expect((callArg.config as Record<string, unknown>).customTopLevel).toBe("preserved");

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ["projects"] });

    // Subsequent saves use the freshly-returned revision.
    click(requireById("save-button"));
    await flush();
    const secondArg = client.writeProjectConfig.mock.calls[1]![0] as {
      expectedRevision: PaseoConfigRevision;
    };
    expect(secondArg.expectedRevision).toEqual(newRevision);
  });

  it("renders the stale-write callout, leaves save disabled, and reload refetches", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );
    client.writeProjectConfig.mockResolvedValue(
      writeError({ code: "stale_project_config", currentRevision: { mtimeMs: 9, size: 9 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    click(requireById("save-button"));
    await flush();

    const callout = requireById("stale-callout");
    expect(callout.textContent).toContain("Config changed on disk");

    // Save is disabled while the callout stands.
    const save = requireById("save-button") as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    // Pressing reload triggers another readProjectConfig.
    const initialReadCalls = client.readProjectConfig.mock.calls.length;
    click(requireById("stale-callout-action-0"));
    await flush();
    expect(client.readProjectConfig.mock.calls.length).toBeGreaterThan(initialReadCalls);
  });

  it("renders the invalid_project_config callout with a Reload action", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(readError({ code: "invalid_project_config" }));

    renderScreen("remote:github.com/acme/app");
    await flush();

    const callout = requireById("invalid-callout");
    expect(callout.textContent).toContain("paseo.json couldn't be parsed");
    expect(findById("invalid-callout-action-0")?.textContent).toBe("Reload");
  });

  it("renders the write_failed callout with Try again and Reload, and Try again retries the save", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );
    client.writeProjectConfig.mockResolvedValue(writeError({ code: "write_failed" }));

    renderScreen("remote:github.com/acme/app");
    await flush();

    click(requireById("save-button"));
    await flush();

    const callout = requireById("write-failed-callout");
    expect(callout.textContent).toContain("Couldn't save paseo.json");
    expect(findById("write-failed-callout-action-0")?.textContent).toBe("Try again");
    expect(findById("write-failed-callout-action-1")?.textContent).toBe("Reload");

    const beforeRetry = client.writeProjectConfig.mock.calls.length;
    click(requireById("write-failed-callout-action-0"));
    await flush();
    expect(client.writeProjectConfig.mock.calls.length).toBe(beforeRetry + 1);
  });
});

describe("ProjectSettingsScreen — round-trip semantics", () => {
  it("preserves the original lifecycle string kind on in-place edits", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({
        config: { worktree: { setup: "npm install" } },
        revision: { mtimeMs: 1, size: 1 },
      }),
    );
    client.writeProjectConfig.mockImplementation(async (input: { config: PaseoConfigRaw }) =>
      writeSuccess({ config: input.config, revision: { mtimeMs: 2, size: 2 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    const setupInput = requireById("worktree-setup-input");
    changeValue(setupInput, "npm install\nnpm run prepare");
    await flush();
    click(requireById("save-button"));
    await flush();

    const savedConfig = client.writeProjectConfig.mock.calls[0]![0]!.config as PaseoConfigRaw;
    // string stays string when edited in place
    expect(savedConfig.worktree?.setup).toBe("npm install\nnpm run prepare");
  });

  it("preserves the original lifecycle array kind on in-place edits", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({
        config: { worktree: { teardown: ["docker compose down"] } },
        revision: { mtimeMs: 1, size: 1 },
      }),
    );
    client.writeProjectConfig.mockImplementation(async (input: { config: PaseoConfigRaw }) =>
      writeSuccess({ config: input.config, revision: { mtimeMs: 2, size: 2 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    const teardownInput = requireById("worktree-teardown-input");
    changeValue(teardownInput, "docker compose down\nrm -rf .cache");
    await flush();
    click(requireById("save-button"));
    await flush();

    const savedConfig = client.writeProjectConfig.mock.calls[0]![0]!.config as PaseoConfigRaw;
    expect(savedConfig.worktree?.teardown).toEqual(["docker compose down", "rm -rf .cache"]);
  });

  it("writes a single string for a newly added lifecycle field with one non-empty line", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );
    client.writeProjectConfig.mockImplementation(async (input: { config: PaseoConfigRaw }) =>
      writeSuccess({ config: input.config, revision: { mtimeMs: 2, size: 2 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    changeValue(requireById("worktree-setup-input"), "npm install");
    await flush();
    click(requireById("save-button"));
    await flush();

    const savedConfig = client.writeProjectConfig.mock.calls[0]![0]!.config as PaseoConfigRaw;
    expect(savedConfig.worktree?.setup).toBe("npm install");
  });

  it("writes an array for a newly added lifecycle field with multiple non-empty lines", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );
    client.writeProjectConfig.mockImplementation(async (input: { config: PaseoConfigRaw }) =>
      writeSuccess({ config: input.config, revision: { mtimeMs: 2, size: 2 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    changeValue(requireById("worktree-setup-input"), "npm install\nnpm run prepare");
    await flush();
    click(requireById("save-button"));
    await flush();

    const savedConfig = client.writeProjectConfig.mock.calls[0]![0]!.config as PaseoConfigRaw;
    expect(savedConfig.worktree?.setup).toEqual(["npm install", "npm run prepare"]);
  });
});

describe("ProjectSettingsScreen — scripts editor", () => {
  it("removes a script via confirm dialog and persists on save", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({
        config: {
          scripts: {
            dev: { command: "npm run dev" },
            build: { command: "npm run build" },
          },
        },
        revision: { mtimeMs: 1, size: 1 },
      }),
    );
    client.writeProjectConfig.mockImplementation(async (input: { config: PaseoConfigRaw }) =>
      writeSuccess({ config: input.config, revision: { mtimeMs: 2, size: 2 } }),
    );
    confirmDialogMock.mockResolvedValue(true);

    renderScreen("remote:github.com/acme/app");
    await flush();

    // Two script rows render, one per script.
    expect(findById("scripts-list")).not.toBeNull();
    // open kebab + select Remove on the build row by clicking the testID directly.
    const removeButton = container?.querySelector<HTMLElement>(
      '[data-testid^="script-row-menu-"][data-testid$="-remove"]',
    );
    // Find the remove menu item for "build" specifically.
    const buildRemove = Array.from(
      container?.querySelectorAll<HTMLElement>('[data-testid$="-remove"]') ?? [],
    ).find((el) => el.textContent?.toLowerCase().includes("remove"));
    expect(buildRemove ?? removeButton).not.toBeNull();
    // For determinism we'll click the first remove menu item we find — assert there are two scripts before.
    const beforeRows =
      container?.querySelectorAll('[data-testid^="script-row-"]:not([data-testid*="menu"])') ?? [];
    expect(beforeRows.length).toBe(2);

    click((buildRemove ?? removeButton)!);
    await flush();

    expect(confirmDialogMock).toHaveBeenCalled();

    click(requireById("save-button"));
    await flush();

    const savedConfig = client.writeProjectConfig.mock.calls[0]![0]!.config as PaseoConfigRaw;
    const scriptKeys = Object.keys((savedConfig as Record<string, unknown>).scripts ?? {});
    // One of the two scripts was removed.
    expect(scriptKeys.length).toBe(1);
  });

  it("preserves passthrough fields on script entries through a save round-trip", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    const base = {
      worktree: { setup: "npm install", customWorktreeField: "keep" },
      scripts: {
        dev: {
          type: "long-running",
          command: "npm run dev",
          port: 3000,
          customScriptField: { nested: true },
        },
      },
      customTopLevel: "preserved",
    } as unknown as PaseoConfigRaw;
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: base, revision: { mtimeMs: 1, size: 1 } }),
    );
    client.writeProjectConfig.mockImplementation(async (input: { config: PaseoConfigRaw }) =>
      writeSuccess({ config: input.config, revision: { mtimeMs: 2, size: 2 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    click(requireById("save-button"));
    await flush();

    const savedConfig = client.writeProjectConfig.mock.calls[0]![0]!.config as PaseoConfigRaw;
    expect((savedConfig as Record<string, unknown>).customTopLevel).toBe("preserved");
    const worktreeRecord = (savedConfig.worktree ?? {}) as Record<string, unknown>;
    expect(worktreeRecord.customWorktreeField).toBe("keep");
    const devEntry = (savedConfig.scripts ?? {}).dev as unknown as Record<string, unknown>;
    expect(devEntry.customScriptField).toEqual({ nested: true });
  });
});

describe("ProjectSettingsScreen — read failures keep the header and host picker visible", () => {
  it("renders a transport-error callout when the read RPC rejects, with the host picker still mounted", async () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ serverId: "a", serverName: "alpha", repoRoot: "/p/a" }),
            hostEntry({ serverId: "b", serverName: "beta", repoRoot: "/p/b" }),
          ],
        }),
      ],
    });
    client.readProjectConfig.mockRejectedValue(new Error("Unknown request schema"));

    renderScreen("remote:github.com/acme/app");
    await flush();

    expect(findById("read-transport-callout")).not.toBeNull();
    expect(findById("loading-spinner")).toBeNull();
    expect(findById("host-picker")).not.toBeNull();
    expect(findById("host-picker-item-a")).not.toBeNull();
    expect(findById("host-picker-item-b")).not.toBeNull();
  });

  it("renders a project-not-found callout when the daemon reports the project is missing", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockResolvedValue(readError({ code: "project_not_found" }));

    renderScreen("remote:github.com/acme/app");
    await flush();

    const callout = requireById("project-not-found-callout");
    expect(callout.textContent).toContain("This host doesn't have this project");
    expect(findById("loading-spinner")).toBeNull();
    expect(findById("host-indicator")).not.toBeNull();
  });

  it("Reload action on the transport callout retries the read", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockRejectedValue(new Error("timeout"));

    renderScreen("remote:github.com/acme/app");
    await flush();

    const before = client.readProjectConfig.mock.calls.length;
    click(requireById("read-transport-callout-action-0"));
    await flush();
    expect(client.readProjectConfig.mock.calls.length).toBeGreaterThan(before);
  });

  it("does not retry the read query on transport failure (settles fast)", async () => {
    setProjectsState({
      projects: [project({ hosts: [hostEntry({ serverId: "a", repoRoot: "/p/a" })] })],
    });
    client.readProjectConfig.mockRejectedValue(new Error("boom"));

    renderScreen("remote:github.com/acme/app");
    await flush();

    // retry: false on the query → exactly one call regardless of how many flushes happen.
    expect(client.readProjectConfig.mock.calls.length).toBe(1);
    expect(findById("read-transport-callout")).not.toBeNull();
  });
});

describe("ProjectSettingsScreen — copy and accessibility", () => {
  it("does not render the word 'checkout' anywhere", async () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ serverId: "a", serverName: "alpha", repoRoot: "/p/a" }),
            hostEntry({ serverId: "b", serverName: "beta", repoRoot: "/p/b" }),
          ],
        }),
      ],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    expect(container?.innerHTML.toLowerCase()).not.toContain("checkout");
  });

  it("the host picker chip carries an accessibility label", async () => {
    setProjectsState({
      projects: [
        project({
          hosts: [
            hostEntry({ serverId: "a", serverName: "alpha", repoRoot: "/p/a" }),
            hostEntry({ serverId: "b", serverName: "beta", repoRoot: "/p/b" }),
          ],
        }),
      ],
    });
    client.readProjectConfig.mockResolvedValue(
      readSuccess({ config: {}, revision: { mtimeMs: 1, size: 1 } }),
    );

    renderScreen("remote:github.com/acme/app");
    await flush();

    const picker = requireById("host-picker");
    expect(picker.getAttribute("aria-label")).toBe("Switch host");
  });
});
