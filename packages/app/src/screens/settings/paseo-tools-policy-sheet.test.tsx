/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MutableDaemonConfig } from "@getpaseo/protocol/messages";

const { patchConfigMock } = vi.hoisted(() => ({
  patchConfigMock: vi.fn(async () => makeConfig()),
}));

vi.mock("@getpaseo/protocol/paseo-tool-manifest", () => ({
  PASEO_TOOL_MANIFEST: [
    {
      id: "create_workspace",
      label: "Create workspace",
      description: "Create a workspace.",
      group: "Workspaces",
    },
    {
      id: "list_agents",
      label: "List agents",
      description: "List agents.",
      group: "Agents",
    },
    {
      id: "browser_snapshot",
      label: "Snapshot browser page",
      description: "Read a browser page.",
      group: "Browser",
      browser: true,
    },
  ],
}));

vi.mock("react-native", () => ({
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("span", { "data-testid": testID }, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? (factory as (theme: Record<string, unknown>) => unknown)({
            spacing: { 1: 4, 2: 8, 4: 16, 6: 24 },
            fontSize: { xs: 11, sm: 13, base: 15 },
            fontWeight: { normal: "400", medium: "500" },
            borderRadius: { lg: 8 },
            borderWidth: { 1: 1 },
            colors: {
              surface1: "#111",
              foreground: "#fff",
              foregroundMuted: "#aaa",
              border: "#555",
            },
          })
        : factory,
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      (
        ({
          "settings.providers.tools.title": "Configure {{name}} tools",
          "settings.providers.tools.searchPlaceholder": "Search tools",
          "settings.providers.tools.master.title": "Enable Paseo tools",
          "settings.providers.tools.master.hint": "Allow this provider to use Paseo tools",
          "settings.providers.tools.master.accessibilityLabel": "Enable Paseo tools for {{name}}",
          "settings.providers.tools.enableAll": "Enable all",
          "settings.providers.tools.disableAll": "Disable all",
          "settings.providers.tools.globalOverride.title": "Paseo tools are disabled",
          "settings.providers.tools.globalOverride.description": "Global override",
          "settings.providers.tools.browserUnavailable.title": "Browser tools are unavailable",
          "settings.providers.tools.browserUnavailable.description": "Browser tools are off",
          "settings.providers.tools.toolAccessibilityLabel": "{{name}} Paseo tool",
          "settings.providers.tools.noSearchMatches": "No tools match your search",
          "settings.providers.tools.updateErrorTitle": "Unable to update Paseo tool settings",
          "workspace.terminal.hostDisconnected": "Host disconnected",
        })[key] ?? key
      ).replaceAll("{{name}}", values?.name ?? ""),
  }),
}));

vi.mock("@/components/adaptive-modal-sheet", () => ({
  AdaptiveModalSheet: ({
    header,
    children,
    testID,
  }: {
    header: { search?: { onChange: (value: string) => void; testID?: string } };
    children?: React.ReactNode;
    testID?: string;
  }) =>
    React.createElement(
      "div",
      { "data-testid": testID },
      header.search
        ? React.createElement("input", {
            "data-testid": header.search.testID,
            onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
              header.search?.onChange(event.target.value),
          })
        : null,
      children,
    ),
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({
    title,
    description,
    testID,
  }: {
    title?: string;
    description?: string;
    testID?: string;
  }) =>
    React.createElement("div", { "data-testid": testID }, `${title ?? ""} ${description ?? ""}`),
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    onPress,
    disabled,
    testID,
  }: {
    children?: React.ReactNode;
    onPress?: () => void;
    disabled?: boolean;
    testID?: string;
  }) =>
    React.createElement(
      "button",
      { type: "button", disabled, "data-testid": testID, onClick: onPress },
      children,
    ),
}));

vi.mock("@/components/ui/switch", () => ({
  Switch: ({
    value,
    onValueChange,
    disabled,
    testID,
    accessibilityLabel,
  }: {
    value: boolean;
    onValueChange?: (value: boolean) => void;
    disabled?: boolean;
    testID?: string;
    accessibilityLabel?: string;
  }) =>
    React.createElement("button", {
      type: "button",
      role: "switch",
      disabled,
      "aria-checked": value ? "true" : "false",
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      onClick: () => onValueChange?.(!value),
    }),
}));

import { PaseoToolsPolicySheet } from "./paseo-tools-policy-sheet";

function makeConfig(overrides: Partial<MutableDaemonConfig> = {}): MutableDaemonConfig {
  return {
    relay: { enabled: false },
    mcp: { injectIntoAgents: true },
    browserTools: { enabled: false },
    providers: {},
    metadataGeneration: { providers: [] },
    autoArchiveAfterMerge: false,
    enableTerminalAgentHooks: false,
    appendSystemPrompt: "",
    ...overrides,
  };
}

describe("PaseoToolsPolicySheet", () => {
  let root: Root | null = null;
  let container: HTMLElement | null = null;

  beforeEach(() => {
    vi.stubGlobal("React", React);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    patchConfigMock.mockReset();
    patchConfigMock.mockResolvedValue(makeConfig());
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    container?.remove();
    container = null;
    vi.unstubAllGlobals();
  });

  function render(config = makeConfig()): void {
    act(() => {
      root?.render(
        <PaseoToolsPolicySheet
          providerId="claude"
          providerLabel="Claude"
          config={config}
          visible
          onClose={vi.fn()}
          onDismiss={vi.fn()}
          patchConfig={patchConfigMock}
        />,
      );
    });
  }

  it("defaults missing policy to enabled and writes a sparse disabledTools patch", async () => {
    render();

    expect(
      container
        ?.querySelector('[data-testid="paseo-tools-master-switch"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");

    await act(async () => {
      container
        ?.querySelector<HTMLElement>('[data-testid="paseo-tool-create_workspace-switch"]')
        ?.click();
    });

    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: { claude: { paseoTools: { disabledTools: ["create_workspace"] } } },
    });
  });

  it("preserves disabled browser choices while browser tools are unavailable", async () => {
    render(
      makeConfig({
        providers: { claude: { paseoTools: { disabledTools: ["browser_snapshot"] } } },
      }),
    );

    const browserTool = container?.querySelector<HTMLButtonElement>(
      '[data-testid="paseo-tool-browser_snapshot-switch"]',
    );
    expect(browserTool?.disabled).toBe(true);
    expect(
      container?.querySelector('[data-testid="paseo-tools-browser-unavailable"]'),
    ).not.toBeNull();

    await act(async () => {
      container?.querySelector<HTMLElement>('[data-testid="paseo-tools-disable-all"]')?.click();
    });

    expect(patchConfigMock).toHaveBeenCalledWith({
      providers: {
        claude: {
          paseoTools: { disabledTools: ["browser_snapshot", "create_workspace", "list_agents"] },
        },
      },
    });
  });

  it("filters the grouped list from the sheet search", () => {
    render();

    const search = container?.querySelector<HTMLInputElement>(
      '[data-testid="paseo-tools-policy-search"]',
    );
    expect(search).not.toBeNull();

    act(() => {
      if (!search) return;
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
      setValue?.call(search, "browser");
      search.dispatchEvent(new window.Event("input", { bubbles: true }));
    });

    expect(container?.querySelector('[data-testid="paseo-tools-group-Browser"]')).not.toBeNull();
    expect(container?.querySelector('[data-testid="paseo-tools-group-Workspaces"]')).toBeNull();
  });

  it("shows saved choices but disables policy controls under the global kill switch", () => {
    render(
      makeConfig({
        mcp: { injectIntoAgents: false },
        providers: { claude: { paseoTools: { enabled: false, disabledTools: ["list_agents"] } } },
      }),
    );

    expect(container?.querySelector('[data-testid="paseo-tools-global-override"]')).not.toBeNull();
    expect(
      container?.querySelector<HTMLButtonElement>('[data-testid="paseo-tools-master-switch"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container?.querySelector<HTMLButtonElement>('[data-testid="paseo-tool-list_agents-switch"]')
        ?.disabled,
    ).toBe(true);
    expect(
      container
        ?.querySelector('[data-testid="paseo-tool-list_agents-switch"]')
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });
});
