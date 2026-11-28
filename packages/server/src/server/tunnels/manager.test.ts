import { describe, expect, it } from "vitest";
import type { TunnelEvent, TunnelProviderStatus, TunnelTarget } from "@getpaseo/plugin/server";
import { TunnelError, TunnelManager, type TunnelManagerEvent } from "./manager.js";

function createFakeProvider(options: {
  id: string;
  pluginId: string;
  label?: string;
  status?: () => Promise<TunnelProviderStatus>;
  onOpen?: (
    exposureId: string,
    target: TunnelTarget,
    callbacks: {
      onEvent(event: TunnelEvent): void;
      onClosed(error?: string): void;
    },
  ) => { close(): Promise<void> };
}) {
  const closedExposures: string[] = [];
  const provider = {
    id: options.id,
    pluginId: options.pluginId,
    label: options.label ?? options.id,
    status: options.status ?? (async () => ({ status: "available" as const, detail: "ready" })),
    open(
      exposureId: string,
      target: TunnelTarget,
      callbacks: {
        onEvent(event: TunnelEvent): void;
        onClosed(error?: string): void;
      },
    ) {
      if (options.onOpen) return options.onOpen(exposureId, target, callbacks);
      queueMicrotask(() => {
        callbacks.onEvent({ type: "connecting" });
        callbacks.onEvent({
          type: "ready",
          url: `https://${target.slug ?? exposureId}.example.test`,
          stability: "ephemeral",
        });
      });
      return {
        async close() {
          closedExposures.push(exposureId);
          callbacks.onEvent({ type: "closed", reason: "requested" });
          callbacks.onClosed();
        },
      };
    },
  };
  return { provider, closedExposures };
}

describe("TunnelManager", () => {
  it("lists providers with probed availability and isolates per-provider status failures", async () => {
    const manager = new TunnelManager();
    manager.registerProvider(
      createFakeProvider({
        id: "alpha",
        pluginId: "plugin-a",
        label: "Alpha",
        status: async () => ({ status: "available", detail: "v1.2.3" }),
      }).provider,
    );
    manager.registerProvider(
      createFakeProvider({
        id: "beta",
        pluginId: "plugin-b",
        label: "Beta",
        status: async () => {
          throw new Error("CLI probe crashed");
        },
      }).provider,
    );

    const providers = await manager.listProviders();
    expect(providers).toEqual([
      {
        id: "alpha",
        pluginId: "plugin-a",
        label: "Alpha",
        availability: { status: "available", detail: "v1.2.3" },
      },
      {
        id: "beta",
        pluginId: "plugin-b",
        label: "Beta",
        availability: { status: "unavailable", reason: "CLI probe crashed" },
      },
    ]);
  });

  it("tracks lifecycle transitions from connecting to ready to closed and removes closed exposures", async () => {
    const manager = new TunnelManager();
    const { provider, closedExposures } = createFakeProvider({
      id: "demo",
      pluginId: "demo-plugin",
    });
    manager.registerProvider(provider);

    const events: TunnelManagerEvent[] = [];
    const unsubscribe = manager.subscribe((event) => events.push(event));

    const exposure = await manager.expose({
      id: "exp-1",
      providerId: "demo",
      host: "127.0.0.1",
      port: 4321,
      label: "External MCP",
      slug: "mcp",
    });

    expect(exposure.state).toBe("ready");
    expect(exposure.url).toBe("https://mcp.example.test");
    expect(exposure.stability).toBe("ephemeral");
    expect(manager.listExposures()).toHaveLength(1);

    await expect(manager.close("exp-1")).resolves.toBe(true);
    await expect(manager.close("exp-1")).resolves.toBe(false);
    expect(closedExposures).toEqual(["exp-1"]);
    expect(manager.listExposures()).toEqual([]);

    const states = events
      .filter((event) => event.type === "exposure.changed")
      .map((event) => event.exposure.state);
    expect(states).toEqual(["connecting", "ready", "closed"]);
    unsubscribe();
  });

  it("tears down active exposures when the owning plugin is unregistered or on closeAll", async () => {
    const manager = new TunnelManager();
    const first = createFakeProvider({ id: "p1", pluginId: "plugin-1" });
    const second = createFakeProvider({ id: "p2", pluginId: "plugin-2" });
    manager.registerProvider(first.provider);
    manager.registerProvider(second.provider);

    await manager.expose({ id: "e1", providerId: "p1", host: "127.0.0.1", port: 3001 });
    await manager.expose({ id: "e2", providerId: "p2", host: "127.0.0.1", port: 3002 });

    await manager.unregisterPlugin("plugin-1");
    expect(first.closedExposures).toEqual(["e1"]);
    expect(manager.listExposures().map((entry) => entry.id)).toEqual(["e2"]);

    await manager.closeAll();
    expect(second.closedExposures).toEqual(["e2"]);
    expect(manager.listExposures()).toEqual([]);
  });

  it("rejects expose when provider fails before ready and leaves no leaked exposure", async () => {
    const manager = new TunnelManager();
    manager.registerProvider(
      createFakeProvider({
        id: "failing",
        pluginId: "failing-plugin",
        onOpen(_exposureId, _target, callbacks) {
          queueMicrotask(() => {
            callbacks.onClosed("All 3 Funnel ports are in use");
          });
          return { close: async () => undefined };
        },
      }).provider,
    );

    await expect(
      manager.expose({ providerId: "failing", host: "127.0.0.1", port: 8080 }),
    ).rejects.toMatchObject({
      code: "open_failed",
      message: "All 3 Funnel ports are in use",
    });
    expect(manager.listExposures()).toEqual([]);
  });

  it("rejects duplicate provider IDs and invalid targets", async () => {
    const manager = new TunnelManager();
    manager.registerProvider(createFakeProvider({ id: "dup", pluginId: "p1" }).provider);
    expect(() =>
      manager.registerProvider(createFakeProvider({ id: "dup", pluginId: "p2" }).provider),
    ).toThrow(TunnelError);

    await expect(
      manager.expose({ providerId: "missing", host: "127.0.0.1", port: 8080 }),
    ).rejects.toMatchObject({ code: "provider_not_found" });

    await expect(
      manager.expose({ providerId: "dup", host: "127.0.0.1", port: 0 }),
    ).rejects.toMatchObject({ code: "invalid_target" });

    for (const badHost of [
      "",
      "   ",
      "127.0.0.1:8080",
      "localhost:3000",
      "http://127.0.0.1",
      "127.0.0.1/path",
      "127.0.0.1?q=1",
      "127.0.0.1#frag",
      "user@127.0.0.1",
      "local host",
      "[::1]:8080",
      "[not-an-ip]",
    ]) {
      await expect(
        manager.expose({ providerId: "dup", host: badHost, port: 8080 }),
      ).rejects.toMatchObject({ code: "invalid_target" });
    }

    const ipv6 = await manager.expose({ id: "exp-v6", providerId: "dup", host: "::1", port: 8080 });
    expect(ipv6.target.host).toBe("::1");
    await manager.close("exp-v6");
  });
});
