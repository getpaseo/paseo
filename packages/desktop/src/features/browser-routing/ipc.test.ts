import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createDesktopSettingsStore } from "../../settings/desktop-settings.js";
import { createBrowserRoutingCommandHandlers } from "./ipc.js";
import { BrowserRoutingManager, browserRoutingPartitionForServer } from "./manager.js";

const TRUSTED_SENDER = 1;
const OTHER_TRUSTED_SENDER = 2;
const GUEST_SENDER = 42;

const directories = new Set<string>();
const managers = new Set<BrowserRoutingManager>();

afterEach(async () => {
  for (const manager of managers) await manager.shutdown();
  managers.clear();
  await Promise.all(
    [...directories].map((directory) => rm(directory, { recursive: true, force: true })),
  );
  directories.clear();
});

async function createHandlers() {
  const userDataPath = await mkdtemp(path.join(os.tmpdir(), "paseo-browser-routing-ipc-"));
  directories.add(userDataPath);
  const events: Array<{ senderId: number; event: string; payload: unknown }> = [];
  const manager = new BrowserRoutingManager({
    settings: createDesktopSettingsStore({ userDataPath }),
    sessions: {
      fromPartition: () => ({
        setProxy: async () => {},
        clearStorageData: async () => {},
        clearCache: async () => {},
        clearAuthCache: async () => {},
      }),
    },
    warmUp: async () => {},
    emit: (senderId, event, payload) => {
      events.push({ senderId, event, payload });
      return true;
    },
    broadcast: () => {},
  });
  managers.add(manager);
  const handlers = createBrowserRoutingCommandHandlers({
    manager,
    isTrustedRenderer: (senderId) =>
      senderId === TRUSTED_SENDER || senderId === OTHER_TRUSTED_SENDER,
  });
  const invoke = (command: string, args: Record<string, unknown>, senderId = TRUSTED_SENDER) =>
    Promise.resolve(handlers[command](args, { senderId }));
  return { invoke, events, manager };
}

const LIMITS = {
  initialWindowBytes: 262144,
  maxDataBytes: 65536,
  maxStreams: 64,
  connectTimeoutMs: 10000,
};

describe("browser routing IPC", () => {
  test("refuses every command from a renderer that is not an app window", async () => {
    const { invoke } = await createHandlers();
    for (const command of [
      "browser_routing_get_state",
      "browser_routing_set_enabled",
      "browser_routing_resolve_partition",
      "network_tunnel_provider_register",
      "network_tunnel_provider_unregister",
      "network_tunnel_stream_connected",
      "network_tunnel_stream_data",
      "network_tunnel_stream_credit",
      "network_tunnel_stream_close",
    ]) {
      expect(await invoke(command, { serverId: "server-a", enabled: true }, GUEST_SENDER)).toEqual({
        ok: false,
        error: { code: "not_owner", message: expect.any(String) },
      });
    }
  });

  test("rejects malformed payloads without touching state", async () => {
    const { invoke, manager } = await createHandlers();

    expect(
      await invoke("browser_routing_set_enabled", { serverId: "", enabled: true }),
    ).toMatchObject({
      ok: false,
      error: { code: "invalid_payload" },
    });
    expect(
      await invoke("network_tunnel_provider_register", {
        serverId: "server-a",
        ...LIMITS,
        maxStreams: 0,
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(
      await invoke("network_tunnel_stream_data", {
        serverId: "server-a",
        providerId: "p",
        streamId: "s",
        data: "not-bytes",
      }),
    ).toMatchObject({ ok: false, error: { code: "invalid_payload" } });
    expect(await manager.isEnabled("server-a")).toBe(false);
  });

  test("drives routing state and partition resolution for the trusted window", async () => {
    const { invoke } = await createHandlers();

    expect(await invoke("browser_routing_get_state", { serverId: "server-a" })).toEqual({
      ok: true,
      enabled: false,
    });
    expect(
      await invoke("browser_routing_set_enabled", { serverId: "server-a", enabled: true }),
    ).toEqual({
      ok: true,
    });
    expect(await invoke("browser_routing_get_state", { serverId: "server-a" })).toEqual({
      ok: true,
      enabled: true,
    });
    expect(await invoke("browser_routing_resolve_partition", { serverId: "server-a" })).toEqual({
      ok: true,
      partition: browserRoutingPartitionForServer("server-a"),
    });
    expect(await invoke("browser_routing_resolve_partition", { serverId: "server-b" })).toEqual({
      ok: false,
      error: { code: "routing_disabled", message: expect.any(String) },
    });
  });

  test("hands an enabled host to the other trusted renderer when its provider exits", async () => {
    const { invoke, events, manager } = await createHandlers();
    await invoke("browser_routing_set_enabled", { serverId: "server-a", enabled: true });
    expect(
      await invoke("network_tunnel_provider_register", {
        serverId: "server-a",
        subscriptionId: "sub-1",
        ...LIMITS,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await invoke(
        "network_tunnel_provider_register",
        { serverId: "server-a", subscriptionId: "sub-2", ...LIMITS },
        OTHER_TRUSTED_SENDER,
      ),
    ).toMatchObject({ ok: false, error: { code: "provider_exists" } });
    await invoke("browser_routing_get_state", { serverId: "server-a" }, GUEST_SENDER);
    events.length = 0;

    manager.handleRendererGone(TRUSTED_SENDER);

    expect(events).toEqual([
      {
        senderId: OTHER_TRUSTED_SENDER,
        event: "browser_routing_changed",
        payload: { serverId: "server-a", enabled: true },
      },
    ]);
  });

  test("does not announce handoff for a disabled host or a renderer without its provider", async () => {
    const first = await createHandlers();
    await first.invoke("browser_routing_get_state", { serverId: "server-a" }, OTHER_TRUSTED_SENDER);
    await first.invoke("network_tunnel_provider_register", {
      serverId: "server-a",
      subscriptionId: "sub-1",
      ...LIMITS,
    });
    first.events.length = 0;

    first.manager.handleRendererGone(TRUSTED_SENDER);

    expect(first.events).toEqual([]);

    const second = await createHandlers();
    await second.invoke("browser_routing_set_enabled", { serverId: "server-a", enabled: true });
    await second.invoke(
      "browser_routing_get_state",
      { serverId: "server-a" },
      OTHER_TRUSTED_SENDER,
    );
    await second.invoke("network_tunnel_provider_register", {
      serverId: "server-a",
      subscriptionId: "sub-1",
      ...LIMITS,
    });
    second.events.length = 0;

    second.manager.handleRendererGone(OTHER_TRUSTED_SENDER);

    expect(second.events).toEqual([]);
    expect(second.manager.bridge.hasProvider("server-a")).toBe(true);
  });

  test("runs a provider lifecycle through the contract commands and events", async () => {
    const { invoke, events, manager } = await createHandlers();
    await invoke("browser_routing_set_enabled", { serverId: "server-a", enabled: true });

    const registered = (await invoke("network_tunnel_provider_register", {
      serverId: "server-a",
      subscriptionId: "sub-1",
      ...LIMITS,
    })) as { ok: true; providerId: string };
    expect(registered.ok).toBe(true);
    expect(
      await invoke("network_tunnel_provider_register", {
        serverId: "server-a",
        subscriptionId: "sub-2",
        ...LIMITS,
      }),
    ).toMatchObject({ ok: false, error: { code: "provider_exists" } });

    const received: Uint8Array[] = [];
    const handle = manager.bridge.openStreamFor(
      "server-a",
      { host: "intranet.invalid", port: 80 },
      {
        onConnected: () => {},
        onData: (data, consumed) => {
          received.push(data);
          consumed();
        },
        onClose: () => {},
      },
    )!;
    const open = events.find((event) => event.event === "network_tunnel_stream_open")!;
    const { streamId } = open.payload as { streamId: string };
    expect(open.payload).toEqual({
      serverId: "server-a",
      providerId: registered.providerId,
      streamId,
      host: "intranet.invalid",
      port: 80,
    });

    const ref = { serverId: "server-a", providerId: registered.providerId, streamId };
    expect(await invoke("network_tunnel_stream_connected", ref)).toEqual({ ok: true });
    expect(
      await invoke("network_tunnel_stream_data", { ...ref, data: new Uint8Array([1, 2, 3]) }),
    ).toEqual({ ok: true });
    expect(received.map((chunk) => Array.from(chunk))).toEqual([[1, 2, 3]]);
    await new Promise((resolve) => setImmediate(resolve));
    expect(events.at(-1)).toEqual({
      senderId: TRUSTED_SENDER,
      event: "network_tunnel_stream_credit",
      payload: { ...ref, credit: 3 },
    });

    handle.write(new Uint8Array([9, 9]), () => {});
    expect(events.at(-1)).toMatchObject({
      event: "network_tunnel_stream_data",
      payload: { ...ref, data: new Uint8Array([9, 9]) },
    });
    expect(await invoke("network_tunnel_stream_credit", { ...ref, credit: 2 })).toEqual({
      ok: true,
    });
    expect(await invoke("network_tunnel_stream_close", { ...ref, reason: 0 })).toEqual({
      ok: true,
    });
    expect(await invoke("network_tunnel_stream_close", { ...ref, reason: 0 })).toMatchObject({
      ok: false,
      error: { code: "unknown_stream" },
    });

    expect(
      await invoke("network_tunnel_provider_unregister", {
        serverId: "server-a",
        providerId: "stale",
      }),
    ).toMatchObject({ ok: false, error: { code: "not_owner" } });
    expect(
      await invoke("network_tunnel_provider_unregister", {
        serverId: "server-a",
        providerId: registered.providerId,
      }),
    ).toEqual({ ok: true });
    expect(manager.bridge.hasProvider("server-a")).toBe(false);
  });
});
