/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { act, fireEvent } from "@testing-library/react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  WorkspaceHeaderMenuDesktop,
  type WorkspaceHeaderWorkspaceActions,
} from "@/screens/workspace/workspace-header-menu";

void testI18n;

const { mockTheme } = vi.hoisted(() => ({
  mockTheme: {
    colors: { foregroundMuted: "#aaa", palette: { red: { 500: "#f00" } } },
    borderRadius: { full: 999 },
  },
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => () => <span data-icon={name} />;
  return {
    Copy: icon("copy"),
    Ellipsis: icon("ellipsis"),
    Globe: icon("globe"),
    Import: icon("import"),
    Pin: icon("pin"),
    PinOff: icon("pin-off"),
    Settings: icon("settings"),
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (theme: unknown) => unknown)(mockTheme) : factory,
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: { uniProps?: (theme: unknown) => Record<string, unknown> } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(mockTheme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("@/components/ui/icon-button-chrome", () => ({
  extraMutedIconColorMapping: () => ({}),
  iconButtonChromeGlyphSize: () => 16,
  iconButtonChromeStyle: () => ({}),
  useIconButtonChromeStyle: () => ({}),
}));

vi.mock("@/components/terminal-profile-icon", () => ({ TerminalProfileIcon: () => null }));
vi.mock("@/hooks/use-daemon-config", () => ({ useDaemonConfig: () => ({ config: null }) }));
vi.mock("@/screens/workspace/scripts", () => ({
  useWorkspaceScriptsMenuPages: () => ({ pages: [], trigger: null, needsAttention: false }),
}));
vi.mock("@/plugins", () => ({ usePluginWorkspaceMenu: () => ({ pages: [], rows: [] }) }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <button type="button" data-testid={testID}>
      {children}
    </button>
  ),
  DropdownMenuContent: ({ children, testID }: { children: React.ReactNode; testID?: string }) => (
    <div data-testid={testID}>{children}</div>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <div role="separator" />,
  DropdownMenuItem: ({
    children,
    leading,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    leading?: React.ReactNode;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} onClick={onSelect}>
      {leading}
      <span data-label>{children}</span>
    </button>
  ),
}));

function baseActions(
  overrides: Partial<WorkspaceHeaderWorkspaceActions> = {},
): WorkspaceHeaderWorkspaceActions {
  return {
    currentBranchName: null,
    showWorkspaceSetup: false,
    importAgentDisabled: false,
    copyPathDisabled: false,
    isPinned: false,
    onOpenImportSheet: vi.fn(),
    onCopyWorkspacePath: vi.fn(),
    onCopyBranchName: vi.fn(),
    onOpenSetupTab: vi.fn(),
    ...overrides,
  };
}

function renderMenu(actions: WorkspaceHeaderWorkspaceActions): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<WorkspaceHeaderMenuDesktop {...actions} />);
  });
  return () => {
    act(() => {
      root.unmount();
    });
    container.remove();
  };
}

function pinItem(): HTMLElement | null {
  return document.querySelector('[data-testid="workspace-header-pin"]');
}

describe("WorkspaceHeaderMenuDesktop pin item", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    document.body.innerHTML = "";
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
    vi.unstubAllGlobals();
  });

  it("offers Pin workspace for an unpinned workspace and toggles on select", () => {
    const onTogglePin = vi.fn();
    unmount = renderMenu(baseActions({ isPinned: false, onTogglePin }));

    const item = pinItem();
    expect(item?.querySelector("[data-label]")?.textContent).toBe("Pin workspace");
    expect(item?.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("pin");

    fireEvent.click(item as HTMLElement);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("offers Unpin workspace for a pinned workspace", () => {
    const onTogglePin = vi.fn();
    unmount = renderMenu(baseActions({ isPinned: true, onTogglePin }));

    const item = pinItem();
    expect(item?.querySelector("[data-label]")?.textContent).toBe("Unpin workspace");
    expect(item?.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("pin-off");

    fireEvent.click(item as HTMLElement);
    expect(onTogglePin).toHaveBeenCalledTimes(1);
  });

  it("hides the item when the host cannot pin", () => {
    unmount = renderMenu(baseActions({ onTogglePin: undefined }));

    expect(pinItem()).toBeNull();
    expect(document.querySelector('[data-testid="workspace-header-copy-path"]')).not.toBeNull();
  });
});
