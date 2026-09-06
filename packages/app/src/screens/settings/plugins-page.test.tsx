/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginListItem, PluginLogEntry } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPluginsPage } from "./plugins-page";

void testI18n;

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  logsSupported: true,
  client: null as DaemonClient | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: (_serverId: string, feature: string) =>
    feature === "pluginLogs" ? runtime.logsSupported : runtime.supported,
}));

vi.mock("@/components/adaptive-modal-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const actual = await vi.importActual<typeof import("@/components/adaptive-modal-sheet")>(
    "@/components/adaptive-modal-sheet",
  );
  return {
    ...actual,
    AdaptiveModalSheet: ({
      header,
      children,
      onClose,
    }: {
      header: { title: string; actions?: React.ReactNode };
      children: React.ReactNode;
      onClose(): void;
    }) =>
      ReactModule.createElement(
        "div",
        { role: "dialog" },
        ReactModule.createElement("h2", null, header.title),
        header.actions,
        ReactModule.createElement("button", { type: "button", onClick: onClose }, "Close"),
        children,
      ),
  };
});

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
  Keyframe: class {
    duration() {
      return this;
    }
  },
  Easing: { ease: "ease", inOut: (value: unknown) => value },
  interpolateColor: (value: number, _input: number[], output: string[]) =>
    value >= 1 ? output[1] : output[0],
  useAnimatedStyle: (factory: () => unknown) => factory(),
  useDerivedValue: (factory: () => unknown) => ({ value: factory() }),
  withTiming: (value: unknown) => value,
}));

vi.mock("@gorhom/bottom-sheet", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  const { ScrollView, TextInput } =
    await vi.importActual<typeof import("react-native")>("react-native");
  return {
    BottomSheetBackdrop: () => null,
    BottomSheetModal: ReactModule.forwardRef(() => null),
    BottomSheetScrollView: ScrollView,
    BottomSheetTextInput: TextInput,
    useBottomSheetInternal: () => null,
  };
});

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

function never<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

function plugin(enabled = true): PluginListItem {
  return {
    id: "example",
    path: "/plugins/example",
    enabled,
    status: enabled ? "running" : "disabled",
  };
}

function createClient() {
  return {
    on: vi.fn(() => () => undefined),
    getDaemonConfig: vi.fn(async () => ({ config: { pluginsEnabled: true } })),
    patchDaemonConfig: vi.fn(async () => ({ config: { pluginsEnabled: true } })),
    listPlugins: vi.fn(async (): Promise<PluginListItem[]> => []),
    inspectDirectoryPlugin: vi.fn(async () => ({ id: "example" })),
    installDirectoryPlugin: vi.fn(async () => plugin()),
    reloadPlugin: vi.fn(async () => plugin()),
    enablePlugin: vi.fn(async () => plugin()),
    disablePlugin: vi.fn(async () => plugin(false)),
    removePlugin: vi.fn(async () => undefined),
    getPluginLogs: vi.fn(async (): Promise<PluginLogEntry[]> => []),
  };
}

type PluginClient = ReturnType<typeof createClient>;

function renderPage(client: PluginClient | null): void {
  runtime.client = client as unknown as DaemonClient | null;
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const element: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <HostPluginsPage serverId="host-a" />
    </QueryClientProvider>
  );
  render(element);
}

describe("HostPluginsPage", () => {
  beforeEach(() => {
    vi.stubGlobal("React", React);
    runtime.connected = true;
    runtime.supported = true;
    runtime.logsSupported = true;
    runtime.client = null;
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders the offline state", () => {
    runtime.connected = false;
    renderPage(null);

    expect(screen.getByRole("alert").textContent).toContain("Plugin host is offline");
  });

  it("renders a catalog error and retries through the real query", async () => {
    const client = createClient();
    client.listPlugins.mockRejectedValueOnce(new Error("catalog exploded"));
    renderPage(client);

    expect(await screen.findByText("Unable to load plugins")).toBeDefined();
    expect(screen.getByText("catalog exploded")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(client.listPlugins).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No plugins configured")).toBeDefined();
  });

  it.each([
    ["reloadPlugin", "Reload", "Reloading…", true],
    ["disablePlugin", "Disable", "Disabling…", true],
    ["enablePlugin", "Enable", "Enabling…", false],
    ["removePlugin", "Remove", "Removing…", true],
  ] as const)("renders %s pending on its plugin row", async (method, trigger, pending, enabled) => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin(enabled)]);
    client[method].mockImplementation(() => never<never>());
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: trigger }));

    const pendingControl = await screen.findByRole("button", { name: pending });
    expect(pendingControl.getAttribute("aria-disabled")).toBe("true");
    expect(client[method]).toHaveBeenCalledTimes(1);
  });

  it("renders install pending through the real form and mutation", async () => {
    const client = createClient();
    client.installDirectoryPlugin.mockImplementation(() => never<never>());
    renderPage(client);

    fireEvent.change(screen.getByLabelText("Plugin directory"), {
      target: { value: "/plugins/example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Install directory" }));

    const pendingControl = await screen.findByRole("button", { name: "Installing…" });
    expect(pendingControl.getAttribute("aria-disabled")).toBe("true");
    expect(client.installDirectoryPlugin).toHaveBeenCalledWith("/plugins/example", undefined);
  });

  it("hides the logs action when the host does not advertise support", async () => {
    runtime.logsSupported = false;
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    renderPage(client);

    await screen.findByText("example");
    expect(screen.queryByRole("button", { name: "Logs" })).toBeNull();
  });

  it("opens readable stdout and stderr logs and refreshes them", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    client.getPluginLogs.mockResolvedValue([
      {
        sequence: 1,
        timestamp: "2026-08-16T12:00:00.000Z",
        stream: "stdout",
        message: "ready",
      },
      {
        sequence: 2,
        timestamp: "2026-08-16T12:00:01.000Z",
        stream: "stderr",
        message: "warning",
      },
    ]);
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.getByText("Logs: example")).toBeDefined();
    expect(await screen.findByText("ready")).toBeDefined();
    expect(screen.getByText("warning")).toBeDefined();
    expect(screen.getByText(/stdout/)).toBeDefined();
    expect(screen.getByText(/stderr/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(client.getPluginLogs).toHaveBeenCalledTimes(2));
  });

  it("shows empty and recoverable error states for plugin logs", async () => {
    const client = createClient();
    client.listPlugins.mockResolvedValue([plugin()]);
    client.getPluginLogs.mockRejectedValueOnce(new Error("logs exploded"));
    renderPage(client);

    fireEvent.click(await screen.findByRole("button", { name: "Logs" }));
    expect(await screen.findByText("Unable to load plugin logs")).toBeDefined();
    expect(screen.getByText("logs exploded")).toBeDefined();

    fireEvent.click(screen.getAllByRole("button", { name: "Refresh" }).at(-1)!);
    await waitFor(() => expect(client.getPluginLogs).toHaveBeenCalledTimes(2));
    expect(await screen.findByText("No plugin output yet")).toBeDefined();
  });
});
