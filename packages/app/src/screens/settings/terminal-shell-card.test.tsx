/**
 * @vitest-environment jsdom
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
const { theme, state, patchConfigMock, listTerminalShellsMock } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16 },
    fontSize: { xs: 11, sm: 13, base: 15 },
    fontWeight: { normal: "400" },
    borderRadius: { lg: 8 },
    colors: { surface1: "#111", foreground: "#fff", foregroundMuted: "#aaa", border: "#555" },
  },
  state: {
    config: { terminalShell: "default", customTerminalShellPath: "" } as Record<string, unknown>,
    supportsTerminalShell: true,
  },
  patchConfigMock: vi.fn(async () => undefined),
  listTerminalShellsMock: vi.fn(async () => ({
    requestId: "r",
    shells: ["default", "pwsh", "nu", "custom"],
    error: null,
  })),
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  View: ({ children, testID }: { children?: React.ReactNode; testID?: string }) =>
    React.createElement("div", { "data-testid": testID }, children),
  Text: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("span", null, children),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function" ? (factory as (t: typeof theme) => unknown)(theme) : factory,
  },
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    selected,
  }: {
    children?: React.ReactNode;
    onSelect?: () => void;
    selected?: boolean;
  }) =>
    React.createElement(
      "div",
      { role: "menuitem", "aria-selected": selected ? "true" : "false", onClick: onSelect },
      children,
    ),
}));

vi.mock("@/components/ui/dropdown-trigger", () => ({
  DropdownTrigger: ({
    children,
    accessibilityLabel,
  }: {
    children?: React.ReactNode;
    accessibilityLabel?: string;
  }) => React.createElement("div", { "aria-label": accessibilityLabel }, children),
}));

// Stands in for the project's styled control. The card must render a real
// editable field for the path; the original bug was that there was none to type in.
vi.mock("@/components/ui/form-field", () => ({
  FormTextInput: ({
    initialValue,
    onChangeText,
    onBlur,
    accessibilityLabel,
    testID,
  }: {
    initialValue?: string;
    onChangeText?: (next: string) => void;
    onBlur?: () => void;
    accessibilityLabel?: string;
    testID?: string;
  }) =>
    React.createElement("input", {
      defaultValue: initialValue,
      "aria-label": accessibilityLabel,
      "data-testid": testID,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChangeText?.(event.target.value),
      onBlur: () => onBlur?.(),
    }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: state.config, isLoading: false, patchConfig: patchConfigMock }),
}));

// The client identity must be stable: the card's shell-listing effect depends on
// it, so a fresh object per render would re-fire the effect forever.
const stubClient = { listTerminalShells: listTerminalShellsMock };
vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => true,
  useHostRuntimeClient: () => stubClient,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (selector: (s: unknown) => unknown) =>
    selector({
      sessions: {
        "server-1": {
          serverInfo: { features: { terminalShell: state.supportsTerminalShell } },
        },
      },
    }),
}));

vi.mock("@/styles/settings", () => ({
  settingsStyles: { card: {}, row: {}, rowBorder: {}, rowContent: {}, rowTitle: {}, rowHint: {} },
}));

import { TerminalShellCard } from "./terminal-shell-card";

let container: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  state.config = { terminalShell: "default", customTerminalShellPath: "" };
  state.supportsTerminalShell = true;
  patchConfigMock.mockClear();
  listTerminalShellsMock.mockClear();
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  container.remove();
});

async function render() {
  root = createRoot(container);
  await act(async () => {
    root?.render(<TerminalShellCard serverId="server-1" />);
  });
}

function customPathInput(): HTMLInputElement | null {
  return container.querySelector<HTMLInputElement>(
    '[data-testid="host-page-terminal-shell-custom-path-input"]',
  );
}

// COMPAT(terminalShell): an older host cannot honor the setting, so it is hidden
// rather than shown and silently ignored.
it("hides the card when the host does not support a configured shell", async () => {
  state.supportsTerminalShell = false;
  await render();

  expect(container.querySelector('[data-testid="host-page-terminal-shell-card"]')).toBeNull();
});

it("offers the shells the host reports", async () => {
  await render();

  const labels = Array.from(container.querySelectorAll('[role="menuitem"]')).map(
    (node) => node.textContent,
  );
  expect(labels).toEqual([
    "Default (system shell)",
    "PowerShell 7 (pwsh)",
    "Nushell (nu)",
    "Custom executable path",
  ]);
});

it("patches the host config when a shell is picked", async () => {
  await render();

  const nu = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
    (node) => node.textContent === "Nushell (nu)",
  );
  await act(async () => {
    nu?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

  expect(patchConfigMock).toHaveBeenCalledWith({ terminalShell: "nu" });
});

// The reported bug: selecting custom left nothing to type the path into.
it("shows a path field only once custom is selected", async () => {
  await render();
  expect(customPathInput()).toBeNull();

  state.config = { terminalShell: "custom", customTerminalShellPath: "" };
  await render();

  expect(customPathInput()).not.toBeNull();
});

it("saves the typed custom path on blur", async () => {
  state.config = { terminalShell: "custom", customTerminalShellPath: "" };
  await render();

  const input = customPathInput();
  expect(input).not.toBeNull();
  // React tracks the input's value node and skips onChange when the value is
  // assigned directly, so go through the native setter.
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setValue?.call(input, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // React maps onBlur onto focusout, not blur.
  await act(async () => {
    input!.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });

  expect(patchConfigMock).toHaveBeenCalledWith({
    customTerminalShellPath: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  });
});
