/**
 * @vitest-environment jsdom
 */
import { i18n as testI18n } from "@/i18n/i18next";
import React, { type ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PluginListItem } from "@getpaseo/protocol/messages";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostPluginsPage } from "./plugins-page";

void testI18n;

const runtime = vi.hoisted(() => ({
  connected: true,
  supported: true,
  client: null as DaemonClient | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeClient: () => runtime.client,
  useHostRuntimeIsConnected: () => runtime.connected,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => runtime.supported,
}));

vi.mock("react-native-reanimated", () => ({
  default: { View: "div" },
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
});
