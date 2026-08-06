/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { act } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import {
  NewWorkspaceTabsRow,
  type NewWorkspaceTabsRowPanel,
} from "@/screens/new-workspace/new-workspace-tabs-row";

void testI18n;

const {
  mockTheme,
}: {
  mockTheme: {
    spacing: Record<number, number>;
    borderWidth: Record<number, number>;
    borderRadius: Record<string, number>;
    fontSize: Record<string, number>;
    fontWeight: Record<string, string>;
    colors: Record<string, unknown>;
  };
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
      accent: "#0a84ff",
    },
  };
  return { mockTheme: themeData };
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

vi.mock("@/constants/layout", () => ({
  WORKSPACE_SECONDARY_HEADER_HEIGHT: 36,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    disabled,
    onSelect,
    testID,
  }: {
    children: React.ReactNode;
    disabled?: boolean;
    onSelect?: () => void;
    testID?: string;
  }) => (
    <button type="button" data-testid={testID} disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  DropdownMenuTrigger: ({
    children,
    testID,
  }: {
    children:
      | React.ReactNode
      | ((state: { hovered: boolean; pressed: boolean; open: boolean }) => React.ReactNode);
    testID?: string;
  }) => (
    <button type="button" data-testid={testID}>
      {typeof children === "function"
        ? children({ hovered: false, pressed: false, open: true })
        : children}
    </button>
  ),
  useDropdownMenuClose: () => () => {},
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children as ReactElement,
  TooltipTrigger: ({
    children,
    testID,
    onPress,
  }: {
    children: React.ReactNode;
    testID?: string;
    onPress?: () => void;
  }) => (
    <span data-testid={testID} onClick={onPress}>
      {children}
    </span>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("lucide-react-native", () => {
  const createIcon = (name: string) => (props: Record<string, unknown>) =>
    React.createElement("span", { "data-icon": name, "data-size": props.size });
  return {
    ChevronDown: createIcon("chevron-down"),
    Globe: createIcon("globe"),
    Plus: createIcon("plus"),
    SquarePen: createIcon("square-pen"),
    SquareTerminal: createIcon("square-terminal"),
    X: createIcon("x"),
  };
});

vi.mock("react-native", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("react-native");
  return actual;
});

function panel(
  input: Partial<NewWorkspaceTabsRowPanel> & Pick<NewWorkspaceTabsRowPanel, "panelId">,
): NewWorkspaceTabsRowPanel {
  return {
    kind: "terminal",
    ...input,
  };
}

interface RenderTabsRowOptions {
  panels?: NewWorkspaceTabsRowPanel[];
  activePanelId?: string | null;
  terminalDisabled?: boolean;
  showCreateBrowser?: boolean;
  onCreateAgentTab?: () => void;
  onCreateTerminal?: () => void;
  onCreateBrowser?: () => void;
  onActivatePanel?: (panelId: string) => void;
  onClosePanel?: (panelId: string) => void;
  onCloseComposer?: () => void;
}

function renderTabsRow(options: RenderTabsRowOptions = {}): {
  container: HTMLElement;
  unmount: () => void;
} {
  const {
    panels = [],
    activePanelId = null,
    terminalDisabled = false,
    showCreateBrowser = false,
    onCreateAgentTab = vi.fn(),
    onCreateTerminal = vi.fn(),
    onCreateBrowser = vi.fn(),
    onActivatePanel = vi.fn(),
    onClosePanel = vi.fn(),
    onCloseComposer,
  } = options;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root: Root = createRoot(container);

  function element(): ReactElement {
    return (
      <NewWorkspaceTabsRow
        panels={panels}
        activePanelId={activePanelId}
        onCreateAgentTab={onCreateAgentTab}
        onCreateTerminal={onCreateTerminal}
        onCreateBrowser={onCreateBrowser}
        onActivatePanel={onActivatePanel}
        onClosePanel={onClosePanel}
        onCloseComposer={onCloseComposer}
        terminalDisabled={terminalDisabled}
        showCreateBrowser={showCreateBrowser}
      />
    );
  }

  act(() => {
    root.render(element());
  });

  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

describe("NewWorkspaceTabsRow", () => {
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
  });

  it("renders the composer tab active when no panel is active", () => {
    const rendered = renderTabsRow();
    const composerTab = rendered.container.querySelector(
      '[data-testid="new-workspace-composer-tab"]',
    );
    expect(composerTab).not.toBeNull();
    rendered.unmount();
  });

  it("renders the menu trigger with New Agent and New Terminal items", () => {
    const rendered = renderTabsRow();
    expect(
      rendered.container.querySelector('[data-testid="new-workspace-new-tab-menu-trigger"]'),
    ).not.toBeNull();
    expect(
      rendered.container.querySelector('[data-testid="new-workspace-new-tab-menu-agent"]'),
    ).not.toBeNull();
    expect(
      rendered.container.querySelector('[data-testid="new-workspace-new-tab-menu-terminal"]'),
    ).not.toBeNull();
    rendered.unmount();
  });

  it("does not render the New Browser item when showCreateBrowser is false", () => {
    const rendered = renderTabsRow({ showCreateBrowser: false });
    expect(
      rendered.container.querySelector('[data-testid="new-workspace-new-tab-menu-browser"]'),
    ).toBeNull();
    rendered.unmount();
  });

  it("renders the New Browser item when showCreateBrowser is true", () => {
    const rendered = renderTabsRow({ showCreateBrowser: true });
    expect(
      rendered.container.querySelector('[data-testid="new-workspace-new-tab-menu-browser"]'),
    ).not.toBeNull();
    rendered.unmount();
  });

  it("disables the New Terminal item when terminalDisabled is true", () => {
    const rendered = renderTabsRow({ terminalDisabled: true });
    const terminalItem = rendered.container.querySelector(
      '[data-testid="new-workspace-new-tab-menu-terminal"]',
    ) as HTMLButtonElement | null;
    expect(terminalItem?.disabled).toBe(true);
    rendered.unmount();
  });

  it("invokes onCreateTerminal when the New Terminal item is selected", () => {
    const onCreateTerminal = vi.fn();
    const rendered = renderTabsRow({ onCreateTerminal });
    const terminalItem = rendered.container.querySelector(
      '[data-testid="new-workspace-new-tab-menu-terminal"]',
    ) as HTMLButtonElement | null;
    act(() => {
      terminalItem?.click();
    });
    expect(onCreateTerminal).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  it("invokes onCreateAgentTab when the composer tab is pressed", () => {
    const onCreateAgentTab = vi.fn();
    const rendered = renderTabsRow({ onCreateAgentTab });
    const composerTab = rendered.container.querySelector(
      '[data-testid="new-workspace-composer-tab"]',
    ) as HTMLButtonElement | null;
    act(() => {
      composerTab?.click();
    });
    expect(onCreateAgentTab).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  it("invokes onCreateAgentTab when the add tab button is pressed", () => {
    const onCreateAgentTab = vi.fn();
    const rendered = renderTabsRow({ onCreateAgentTab });
    const addButton = rendered.container.querySelector(
      '[data-testid="new-workspace-add-tab-button"]',
    ) as HTMLButtonElement | null;
    act(() => {
      addButton?.click();
    });
    expect(onCreateAgentTab).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  it("invokes onCloseComposer when the composer close button is pressed", () => {
    const onCloseComposer = vi.fn();
    const rendered = renderTabsRow({ onCloseComposer });
    const closeButton = rendered.container.querySelector(
      '[data-testid="new-workspace-composer-close"]',
    ) as HTMLButtonElement | null;
    expect(closeButton).not.toBeNull();
    act(() => {
      closeButton?.click();
    });
    expect(onCloseComposer).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  it("does not render a composer close button when onCloseComposer is omitted", () => {
    const rendered = renderTabsRow({
      onCloseComposer: undefined,
    });
    expect(
      rendered.container.querySelector('[data-testid="new-workspace-composer-close"]'),
    ).toBeNull();
    rendered.unmount();
  });

  it("renders one chip per panel with a kind label", () => {
    const rendered = renderTabsRow({
      panels: [panel({ panelId: "t1" }), panel({ panelId: "b1", kind: "browser" })],
    });
    expect(
      rendered.container.querySelector('[data-testid="new-workspace-panel-tab-t1"]'),
    ).not.toBeNull();
    expect(
      rendered.container.querySelector('[data-testid="new-workspace-panel-tab-b1"]'),
    ).not.toBeNull();
    rendered.unmount();
  });

  it("invokes onActivatePanel when a panel chip is pressed", () => {
    const onActivatePanel = vi.fn();
    const rendered = renderTabsRow({
      panels: [panel({ panelId: "t1" })],
      activePanelId: null,
      onActivatePanel,
    });
    const panelTab = rendered.container.querySelector(
      '[data-testid="new-workspace-panel-tab-t1"]',
    ) as HTMLButtonElement | null;
    act(() => {
      panelTab?.click();
    });
    expect(onActivatePanel).toHaveBeenCalledWith("t1");
    rendered.unmount();
  });

  it("invokes onClosePanel when the panel close button is pressed", () => {
    const onClosePanel = vi.fn();
    const rendered = renderTabsRow({
      panels: [panel({ panelId: "t1" })],
      onClosePanel,
    });
    const closeButton = rendered.container.querySelector(
      '[data-testid="new-workspace-panel-close-t1"]',
    ) as HTMLButtonElement | null;
    act(() => {
      closeButton?.click();
    });
    expect(onClosePanel).toHaveBeenCalledWith("t1");
    rendered.unmount();
  });

  it("suffixes labels with an ordinal when more than one of the same kind is open", () => {
    const rendered = renderTabsRow({
      panels: [panel({ panelId: "t1" }), panel({ panelId: "t2" })],
    });
    const chipOne = rendered.container.querySelector('[data-testid="new-workspace-panel-tab-t1"]');
    const chipTwo = rendered.container.querySelector('[data-testid="new-workspace-panel-tab-t2"]');
    expect(chipOne?.textContent).toContain("Terminal");
    expect(chipTwo?.textContent).toContain("Terminal 2");
    rendered.unmount();
  });
});
