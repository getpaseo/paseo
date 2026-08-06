/**
 * @vitest-environment jsdom
 *
 * SPIKE REGRESSION TEST: the New Workspace screen renders the shared
 * terminal/browser panels before a workspace exists (workspaceId === "").
 * The terminal panel must fall back to the pane context's cwdOverride so it
 * shows a real terminal instead of the "Workspace directory not found."
 * placeholder; the browser panel must tolerate a null cwd.
 */
import { reactGlobalInstalled } from "../../../test-stubs/react-global";
void reactGlobalInstalled;
import { i18n as testI18n } from "@/i18n/i18next";
import React from "react";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import {
  buildWorkspacePaneContentModel,
  WorkspacePaneContent,
} from "@/screens/workspace/workspace-pane-content";
import type { WorkspaceTabDescriptor } from "@/screens/workspace/workspace-tabs-types";

void testI18n;

const {
  mockTheme,
  terminalPaneProps,
  browserPaneProps,
}: {
  mockTheme: Record<string, unknown>;
  terminalPaneProps: Array<{ cwd: string; terminalId: string; serverId: string }>;
  browserPaneProps: Array<{ cwd: string | null; browserId: string; serverId: string }>;
} = vi.hoisted(() => {
  const themeData = {
    spacing: { 1: 4, 2: 8, 3: 12 },
    borderWidth: { 1: 1 },
    borderRadius: { sm: 4, md: 6 },
    fontSize: { sm: 13 },
    fontWeight: { normal: "400" },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      surface2: "#222",
      surface3: "#333",
      border: "#444",
    },
  };
  return {
    mockTheme: themeData,
    terminalPaneProps: [],
    browserPaneProps: [],
  };
});

vi.mock("@/panels/register-panels", () => ({
  ensurePanelsRegistered: vi.fn(),
}));

vi.mock("@/panels/panel-registry", async () => {
  const terminalModule =
    await vi.importActual<typeof import("@/panels/terminal-panel")>("@/panels/terminal-panel");
  const browserModule =
    await vi.importActual<typeof import("@/desktop/browser/panel")>("@/desktop/browser/panel");
  return {
    getPanelRegistration: (kind: string) => {
      if (kind === "terminal") {
        return terminalModule.terminalPanelRegistration;
      }
      if (kind === "browser") {
        return browserModule.browserPanelRegistration;
      }
      throw new Error(`panel-render-spike: unexpected kind ${kind}`);
    },
  };
});

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(mockTheme) : factory),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({
      uniProps,
      ...rest
    }: {
      uniProps?: (theme: unknown) => Record<string, unknown>;
    } & Record<string, unknown>) => {
      const themed = uniProps ? uniProps(mockTheme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { "data-icon": name, "data-size": props.size });
  return {
    Globe: createIcon("globe"),
    Terminal: createIcon("terminal"),
  };
});

vi.mock("@/components/terminal-pane", () => ({
  TerminalPane: (props: { serverId: string; cwd: string; terminalId: string }) => {
    terminalPaneProps.push({
      serverId: props.serverId,
      cwd: props.cwd,
      terminalId: props.terminalId,
    });
    return <div data-testid="terminal-pane" />;
  },
}));

vi.mock("@/desktop/browser/pane", () => ({
  BrowserPane: (props: { serverId: string; cwd: string | null; browserId: string }) => {
    browserPaneProps.push({
      serverId: props.serverId,
      cwd: props.cwd,
      browserId: props.browserId,
    });
    return <div data-testid="browser-pane" />;
  },
}));

vi.mock("@/stores/session-store-hooks", () => ({
  useWorkspaceDirectory: () => null,
  useWorkspaceFields: () => null,
}));

vi.mock("@/stores/panel-store", () => ({
  usePanelStore: (selector: (state: { openFileExplorerForCheckout: unknown }) => unknown) =>
    selector({ openFileExplorerForCheckout: vi.fn() }),
}));

vi.mock("@/data/query-client", () => ({
  queryClient: {},
}));

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return actual;
});

function terminalTab(terminalId = "t1"): WorkspaceTabDescriptor {
  return {
    key: `terminal_${terminalId}`,
    tabId: `terminal_${terminalId}`,
    kind: "terminal",
    target: { kind: "terminal", terminalId },
  };
}

function browserTab(browserId = "b1"): WorkspaceTabDescriptor {
  return {
    key: `browser_${browserId}`,
    tabId: `browser_${browserId}`,
    kind: "browser",
    target: { kind: "browser", browserId },
  };
}

function buildModel(input: { tab: WorkspaceTabDescriptor; cwdOverride?: string }) {
  return buildWorkspacePaneContentModel({
    tab: input.tab,
    normalizedServerId: "test-server",
    normalizedWorkspaceId: "",
    cwdOverride: input.cwdOverride,
    onOpenTab: vi.fn(),
    onCloseCurrentTab: vi.fn(),
    onRetargetCurrentTab: vi.fn(),
    onOpenWorkspaceFile: vi.fn(),
    onOpenImportSheet: vi.fn(),
  });
}

describe("panel render spike: empty workspaceId", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  afterEach(() => {
    if (root) {
      act(() => {
        root?.unmount();
      });
    }
    root = null;
    container?.remove();
    container = null;
    terminalPaneProps.length = 0;
    browserPaneProps.length = 0;
  });

  function mount(content: ReturnType<typeof buildModel>): HTMLElement {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root?.render(<WorkspacePaneContent content={content} isWorkspaceFocused isPaneFocused />);
    });
    return container;
  }

  it("terminal panel without cwdOverride renders the missing-directory placeholder (no throw)", () => {
    const content = buildModel({ tab: terminalTab() });
    const rendered = mount(content);
    expect(rendered.textContent).toContain("Workspace directory not found.");
    expect(terminalPaneProps).toHaveLength(0);
  });

  it("terminal panel with cwdOverride renders the terminal pane with the override cwd", () => {
    const content = buildModel({ tab: terminalTab("t2"), cwdOverride: "/tmp/project" });
    const rendered = mount(content);
    expect(rendered.querySelector('[data-testid="terminal-pane"]')).not.toBeNull();
    expect(terminalPaneProps).toEqual([
      { serverId: "test-server", cwd: "/tmp/project", terminalId: "t2" },
    ]);
  });

  it("browser panel with empty workspaceId renders the browser pane with a null cwd (no throw)", () => {
    const content = buildModel({ tab: browserTab() });
    const rendered = mount(content);
    expect(rendered.querySelector('[data-testid="browser-pane"]')).not.toBeNull();
    expect(browserPaneProps).toEqual([{ serverId: "test-server", cwd: null, browserId: "b1" }]);
  });
});
