import { describe, expect, it } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginHosts, type PluginHostsSource } from "./index";
import { resolveDesktopDaemonServerId } from "@/desktop/daemon/desktop-daemon";

function registry() {
  const hosts = [
    {
      serverId: "a",
      label: "Alpha",
      password: "secret",
      appearance: { color: "none" as const, badgeDisplay: null },
      connections: [
        { id: "one", type: "directTcp" as const, endpoint: "localhost:6767", useTls: false },
        { id: "two", type: "directSocket" as const, path: "/tmp/test" },
      ],
      lifecycle: {},
      preferredConnectionId: null,
      createdAt: "today",
      updatedAt: "today",
    },
    {
      serverId: "b",
      label: "Beta",
      password: "secret",
      appearance: { color: "none" as const, badgeDisplay: null },
      connections: [],
      lifecycle: {},
      preferredConnectionId: null,
      createdAt: "today",
      updatedAt: "today",
    },
  ];
  const snapshots = new Map<
    string,
    { connectionStatus: "online" | "offline" | "connecting"; client: DaemonClient | null }
  >();
  const listeners = new Set<() => void>();
  const source: PluginHostsSource = {
    addHost: async () => ({ status: "cancelled" }),
    getHosts: () => hosts,
    getSnapshot: (id) => {
      const value = snapshots.get(id);
      return value
        ? { ...value, activeConnectionId: null, lastError: null, lastOnlineAt: null }
        : null;
    },
    renameHost: async (id, label) => {
      hosts.find((candidate) => candidate.serverId === id)!.label = label;
    },
    setHostColor: async () => {},
    setHostBadgeDisplay: async () => {},
    removeHost: async (id) => {
      const index = hosts.findIndex((host) => host.serverId === id);
      if (index >= 0) hosts.splice(index, 1);
      for (const l of listeners) l();
    },
    removeConnection: async (id, connectionId) => {
      const host = hosts.find((candidate) => candidate.serverId === id)!;
      host.connections = host.connections.filter((c) => c.id !== connectionId);
      if (!host.connections.length) await source.removeHost(id);
      else for (const l of listeners) l();
    },
    subscribeAll(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    subscribeHostList(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const lifetime = new AbortController();
  const runtime = createPluginHosts(source, lifetime.signal, {
    openSettings() {},
    isManagedLocalHost: async () => false,
  });
  return {
    hosts,
    snapshots,
    listeners,
    lifetime,
    runtime,
    source,
    publish() {
      for (const listener of listeners) listener();
    },
  };
}
function ignoreUpdate() {}

function connection(id: string) {
  return new DaemonClient({ url: `ws://${id}`, clientId: "test", reconnect: { enabled: false } });
}

describe("plugin host access", () => {
  it("publishes credential-free configured hosts and only changes snapshots when summaries change", () => {
    const h = registry();
    expect(h.runtime.getSnapshot()).toMatchObject([
      { serverId: "a", label: "Alpha", status: "offline" },
      { serverId: "b", label: "Beta", status: "offline" },
    ]);
    const before = h.runtime.getSnapshot();
    h.publish();
    expect(h.runtime.getSnapshot()).toBe(before);
    let updates = 0;
    h.runtime.subscribe(() => updates++);
    h.snapshots.set("b", { connectionStatus: "connecting", client: null });
    h.publish();
    expect(updates).toBe(1);
    expect(h.runtime.getSnapshot()[1].status).toBe("connecting");
    h.hosts[1].label = "Renamed";
    h.publish();
    expect(h.runtime.getSnapshot()[1].label).toBe("Renamed");
    h.lifetime.abort();
    expect(h.listeners.size).toBe(0);
  });

  it("keeps handles stable, protects credentials, and stops observations on unload", async () => {
    const h = registry();
    const seen: unknown[] = [];
    const stop = h.runtime.observeHosts((hosts) => seen.push(hosts));
    const first = h.runtime.getSnapshot()[0];
    function walk(value: unknown): void {
      if (typeof value === "string") expect(value).not.toContain("secret");
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        expect(key.toLowerCase()).not.toBe("password");
        walk(child);
      }
    }
    walk(h.runtime.getSnapshot());
    h.hosts[0].label = "New name";
    h.publish();
    expect(h.runtime.getSnapshot()[0]).toBe(first);
    expect(first.label).toBe("New name");
    expect(seen).toHaveLength(2);
    h.lifetime.abort();
    h.publish();
    expect(seen).toHaveLength(2);
    await expect(first.remove()).rejects.toThrow("Plugin has stopped");
    stop();
  });

  it("redacts saved passwords from mutation errors", async () => {
    const h = registry();
    h.source.renameHost = async () => {
      throw new Error("Failed for secret");
    };
    await expect(h.runtime.getSnapshot()[0].update({ label: "New" })).rejects.not.toThrow("secret");
    h.lifetime.abort();
  });

  it("isolates a throwing observer from other observers and registry mutations", async () => {
    const h = registry();
    let calls = 0;
    h.runtime.observeHosts(() => {
      if (calls++ > 0) throw new Error("plugin listener failed");
    });
    let delivered = 0;
    h.runtime.observeHosts(() => {
      delivered++;
    });
    await expect(h.runtime.getSnapshot()[0].removeConnection("one")).resolves.toBeUndefined();
    expect(delivered).toBe(2);
    expect(h.runtime.getSnapshot()[0].connections).toHaveLength(1);
    h.lifetime.abort();
  });

  it("refuses to remove the last connection of the desktop daemon", async () => {
    const h = registry();
    const lifetime = new AbortController();
    const runtime = createPluginHosts(h.source, lifetime.signal, {
      openSettings() {},
      isManagedLocalHost: async (id) => id === "a",
    });
    const host = runtime.getSnapshot()[0];
    await host.removeConnection("one");
    await expect(host.removeConnection("two")).rejects.toThrow("desktop daemon");
    expect(host.connections).toHaveLength(1);
    lifetime.abort();
    h.lifetime.abort();
  });

  it("returns the projected handle after adding a host", async () => {
    const h = registry();
    h.source.addHost = async () => ({ status: "saved", serverId: "a" });
    const result = await h.runtime.addHost({ connection: "tcp://example:6767?password=secret" });
    expect(result.status).toBe("saved");
    if (result.status !== "saved") throw new Error("expected saved host");
    expect(result.host).toBe(h.runtime.getSnapshot()[0]);
    expect(JSON.stringify(result)).not.toContain("secret");
    h.lifetime.abort();
    await expect(h.runtime.addHost({ connection: "example:6767" })).rejects.toThrow(
      "Plugin has stopped",
    );
  });

  it("passes cancellation and authentication results without exposing credentials", async () => {
    const h = registry();
    for (const result of [
      { status: "cancelled" as const },
      { status: "password_required" as const, reason: "incorrect_password" as const },
    ]) {
      h.source.addHost = async () => result;
      const returned = await h.runtime.addHost({
        connection: "tcp://example:6767?password=secret",
      });
      expect(returned).toEqual(result);
      for (const [key, value] of Object.entries(returned)) {
        expect(key).not.toBe("password");
        expect(value).not.toBe("secret");
      }
    }
    h.lifetime.abort();
  });

  it("redacts encoded saved passwords in mutation errors", async () => {
    const h = registry();
    h.hosts[0].password = "two words";
    h.source.renameHost = async () => {
      throw new Error("failed for two%20words");
    };
    await expect(h.runtime.getSnapshot()[0].update({ label: "New" })).rejects.not.toThrow(
      "two%20words",
    );
    h.lifetime.abort();
  });

  it("never exposes supplied passwords in add errors", async () => {
    const h = registry();
    h.source.addHost = async () => {
      throw new Error("secret was rejected");
    };
    await expect(
      h.runtime.addHost({ connection: "tcp://example:6767?password=secret" }),
    ).rejects.not.toThrow("secret");
    h.lifetime.abort();
  });

  it("removes a connection and then the last host connection", async () => {
    const h = registry();
    const host = h.runtime.getSnapshot()[0];
    await host.removeConnection("one");
    expect(host.connections.map((item) => item.id)).toEqual(["two"]);
    await host.removeConnection("two");
    expect(h.runtime.getSnapshot().map((entry) => entry.serverId)).toEqual(["b"]);
    h.lifetime.abort();
  });

  it("rejects removal of the managed desktop daemon", async () => {
    const h = registry();
    const lifetime = new AbortController();
    const runtime = createPluginHosts(h.source, lifetime.signal, {
      openSettings() {},
      isManagedLocalHost: async (id) => id === "a",
    });
    await expect(runtime.getSnapshot()[0].remove()).rejects.toThrow("desktop daemon");
    expect(runtime.getSnapshot()).toHaveLength(2);
    lifetime.abort();
    h.lifetime.abort();
  });

  it("protects the desktop host after its daemon has stopped", async () => {
    const h = registry();
    const lifetime = new AbortController();
    const runtime = createPluginHosts(h.source, lifetime.signal, {
      openSettings() {},
      isManagedLocalHost: async (id) =>
        id ===
        (await resolveDesktopDaemonServerId({
          getStatus: async () => {
            throw new Error("daemon stopped");
          },
          getSavedId: async () => "a",
        })),
    });
    await expect(runtime.getSnapshot()[0].remove()).rejects.toThrow("desktop daemon");
    expect(runtime.getSnapshot()).toHaveLength(2);
    lifetime.abort();
    h.lifetime.abort();
  });

  it("rejects unknown and disconnected targets without falling through to another host", () => {
    const h = registry();
    h.snapshots.set("a", { connectionStatus: "online", client: connection("a") });
    expect(() => h.runtime.getPaseoClient("missing")).toThrow("Unknown Paseo host: missing");
    expect(() => h.runtime.getPaseoClient("b")).toThrow("Paseo host is disconnected: b");
    h.lifetime.abort();
  });

  it("isolates installation lifetimes and releases APIs when a connection is replaced", async () => {
    const h = registry();
    const client = connection("b");
    h.snapshots.set("b", { connectionStatus: "online", client });
    h.publish();
    const otherLifetime = new AbortController();
    const other = createPluginHosts(h.source, otherLifetime.signal, {
      openSettings() {},
      isManagedLocalHost: async () => false,
    });
    const api = h.runtime.getPaseoClient("b");
    expect(api).toBe(h.runtime.getPaseoClient("b"));
    expect(api).not.toBe(other.getPaseoClient("b"));
    expect(api).not.toHaveProperty("connect");
    expect(api).not.toHaveProperty("close");
    api.agents.subscribe(ignoreUpdate);
    h.snapshots.set("b", { connectionStatus: "offline", client });
    h.publish();
    expect(() => h.runtime.getPaseoClient("b")).toThrow("disconnected");
    expect(() => api.config.get()).toThrow("Paseo host is disconnected: b");
    h.snapshots.set("b", { connectionStatus: "online", client });
    h.publish();
    expect(h.runtime.getPaseoClient("b")).toBe(api);
    h.snapshots.set("b", { connectionStatus: "online", client: connection("new-b") });
    h.publish();
    expect(() => api.agents.subscribe(ignoreUpdate)).toThrow("disposed");
    expect(() => api.config.get()).toThrow("Paseo client is released: b");
    expect(h.runtime.getPaseoClient("b")).not.toBe(api);
    h.lifetime.abort();
    expect(() => h.runtime.getPaseoClient("b")).toThrow("Plugin has stopped");
    expect(() => other.getPaseoClient("b").agents.subscribe(ignoreUpdate)).not.toThrow();
    otherLifetime.abort();
  });
});

it("reacquires a fresh API after explicit disposal without affecting a later borrower", async () => {
  const h = registry();
  h.snapshots.set("b", { connectionStatus: "online", client: connection("b") });
  const first = h.runtime.getPaseoClient("b");
  await first.dispose();
  const second = h.runtime.getPaseoClient("b");
  expect(second).not.toBe(first);
  expect(() => second.agents.subscribe(ignoreUpdate)).not.toThrow();
  expect(() => first.config.get()).toThrow("Paseo client is released: b");
  await first.dispose();
  expect(h.runtime.getPaseoClient("b")).toBe(second);
  h.lifetime.abort();
  expect(() => second.agents.subscribe(ignoreUpdate)).toThrow("disposed");
});
