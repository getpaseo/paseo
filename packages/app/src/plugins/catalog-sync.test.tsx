/**
 * @vitest-environment jsdom
 */
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { act, render } from "@testing-library/react";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { InstalledPlugin } from "./types";
import { PluginCatalogSync } from "./catalog-sync";
import { pluginRegistry } from "./registry";
import { readPluginTimelinePaint, resetPluginTimelinePaintState } from "./timeline-paint";

vi.mock("./registry", () => ({
  pluginRegistry: {
    removeHost: vi.fn(),
    installCatalog: vi.fn(() => false),
    getSnapshot: vi.fn(() => []),
  },
}));

vi.mock("./settings/use-settings", () => ({
  pluginSettingsKey: (id: string) => ["plugin-settings", id],
}));

const registry = pluginRegistry as unknown as {
  removeHost: ReturnType<typeof vi.fn>;
  installCatalog: ReturnType<typeof vi.fn>;
  getSnapshot: ReturnType<typeof vi.fn>;
};

const storage = vi.hoisted(() => ({ raw: null as string | null }));
const host = vi.hoisted(() => ({
  connected: true,
  plugins: true as boolean | null,
  audio: { play: async () => 0 },
}));

vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async () => storage.raw),
    setItem: vi.fn(async (_key: string, value: string) => {
      storage.raw = value;
    }),
    removeItem: vi.fn(async () => {
      storage.raw = null;
    }),
  },
}));

vi.mock("@/contexts/voice-context", () => ({
  useVoiceAudioEngineOptional: () => host.audio,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => host.connected,
}));

vi.mock("@/stores/session-store", () => ({
  useSessionStore: (
    selector: (state: {
      sessions: Record<string, { serverInfo: { features?: { plugins?: boolean } } | null }>;
    }) => unknown,
  ) =>
    selector({
      sessions: {
        host: {
          serverInfo: host.plugins === null ? null : { features: { plugins: host.plugins } },
        },
      },
    }),
}));

function daemonClient(): DaemonClient & {
  getPluginCatalog: ReturnType<typeof vi.fn>;
  emitSnapshot: () => void;
} {
  let snapshot = () => {};
  const client = {
    getPluginCatalog: vi.fn(async () => []),
    observeEvents: vi.fn(() => ({
      subscribe: (observer: { snapshot?: () => void }) => {
        snapshot = observer.snapshot ?? (() => {});
      },
      release: vi.fn(async () => undefined),
    })),
    emitSnapshot: () => snapshot(),
  };
  return client as unknown as DaemonClient & {
    getPluginCatalog: ReturnType<typeof vi.fn>;
    emitSnapshot: () => void;
  };
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  resetPluginTimelinePaintState();
  storage.raw = null;
  host.connected = true;
  host.plugins = true;
  registry.removeHost.mockClear();
  registry.installCatalog.mockClear();
  registry.getSnapshot.mockReset();
  registry.getSnapshot.mockReturnValue([]);
});

it("requests the catalog without waiting for the event subscription snapshot", async () => {
  const client = daemonClient();
  render(<PluginCatalogSync serverId="host" client={client} />);
  await flush();

  expect(client.getPluginCatalog).toHaveBeenCalledTimes(1);
  client.emitSnapshot();
  await flush();
  expect(client.getPluginCatalog).toHaveBeenCalledTimes(2);
});

it("keeps installed plugins when the connection drops or the client is missing", async () => {
  const client = daemonClient();
  const view = render(<PluginCatalogSync serverId="host" client={client} />);
  await flush();
  registry.removeHost.mockClear();

  host.connected = false;
  view.rerender(<PluginCatalogSync serverId="host" client={client} />);
  await flush();
  expect(registry.removeHost).not.toHaveBeenCalled();

  view.rerender(<PluginCatalogSync serverId="host" client={null} />);
  await flush();
  expect(registry.removeHost).not.toHaveBeenCalled();
});

it("evaluates again when the client object is replaced", async () => {
  const first = daemonClient();
  const second = daemonClient();
  const view = render(<PluginCatalogSync serverId="host" client={first} />);
  await flush();
  registry.removeHost.mockClear();

  view.rerender(<PluginCatalogSync serverId="host" client={second} />);
  await flush();

  expect(registry.removeHost).toHaveBeenCalledWith("host");
  expect(second.getPluginCatalog).toHaveBeenCalledTimes(1);
});

it("remembers a timeline plugin and holds source rows until that catalog is installed", async () => {
  const client = daemonClient();
  registry.getSnapshot.mockReturnValue([
    {
      serverId: "host",
      timelineTransformers: [{ id: "assistant" }],
    } as InstalledPlugin,
  ]);

  expect(readPluginTimelinePaint("host", true)).toBe("wait");
  render(<PluginCatalogSync serverId="host" client={client} />);
  await flush();

  expect(storage.raw).toBe(JSON.stringify({ host: true }));
  expect(readPluginTimelinePaint("host", true)).toBe("paint");
});

it("drops plugins when the daemon does not support them", async () => {
  host.plugins = false;
  render(<PluginCatalogSync serverId="host" client={daemonClient()} />);
  await flush();

  expect(registry.removeHost).toHaveBeenCalledWith("host");
  expect(readPluginTimelinePaint("host", false)).toBe("paint");
  expect(storage.raw).toBe(JSON.stringify({ host: false }));
});
