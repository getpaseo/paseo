import { describe, expect, it } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginHosts, type PluginHostsSource } from "./index";

function registry(options?: { selfServerId?: string }) {
  const hosts = [
    { serverId: "a", label: "Alpha", password: "secret" },
    { serverId: "b", label: "Beta", password: "secret" },
  ];
  const snapshots = new Map<string, NonNullable<ReturnType<PluginHostsSource["getSnapshot"]>>>();
  const listeners = new Set<() => void>();
  const upserts: Parameters<PluginHostsSource["probeAndUpsertRemoteSshConnection"]>[0][] = [];
  const removals: string[] = [];
  const source: PluginHostsSource = {
    getHosts: () => hosts,
    getSnapshot: (id) => snapshots.get(id) ?? null,
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
    async probeAndUpsertRemoteSshConnection(input) {
      upserts.push(input);
      const serverId = `new-${upserts.length}`;
      hosts.push({ serverId, label: input.label ?? `${serverId}.local`, password: "" });
      return { serverId };
    },
    async removeHost(serverId) {
      removals.push(serverId);
      const index = hosts.findIndex((host) => host.serverId === serverId);
      if (index !== -1) hosts.splice(index, 1);
    },
  };
  const lifetime = new AbortController();
  const runtime = createPluginHosts(source, lifetime.signal, options);
  return {
    hosts,
    snapshots,
    listeners,
    lifetime,
    runtime,
    source,
    upserts,
    removals,
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
    expect(h.runtime.getSnapshot()).toEqual([
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
    const other = createPluginHosts(h.source, otherLifetime.signal);
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

describe("plugin host registration", () => {
  it("registers a Remote SSH host from its URI and returns the saved summary", async () => {
    const h = registry();
    let updates = 0;
    h.runtime.subscribe(() => updates++);
    const summary = await h.runtime.addRemoteSshHost({
      target: "ssh://root@vm-1.example:2222?daemonPort=7000",
      label: "VM 1",
    });
    expect(h.upserts).toEqual([
      { host: "root@vm-1.example", sshPort: 2222, daemonPort: 7000, label: "VM 1" },
    ]);
    expect(summary).toEqual({ serverId: "new-1", label: "VM 1", status: "offline" });
    expect(h.runtime.getSnapshot()).toContainEqual(summary);
    expect(updates).toBe(1);
    await h.runtime.addRemoteSshHost({ target: "ssh://vm-2", password: "daemon-secret" });
    expect(h.upserts[1]).toEqual({ host: "vm-2", daemonPort: 6767, password: "daemon-secret" });
    expect(h.runtime.getSnapshot().map((host) => host.serverId)).toEqual([
      "a",
      "b",
      "new-1",
      "new-2",
    ]);
    await expect(h.runtime.addRemoteSshHost({ target: "vm-3.example" })).rejects.toThrow(
      "Invalid SSH host URI",
    );
    expect(h.upserts).toHaveLength(2);
    h.lifetime.abort();
  });

  it("removes configured hosts but never an unknown host or the installation's own host", async () => {
    const h = registry({ selfServerId: "a" });
    await expect(h.runtime.removeHost("a")).rejects.toThrow("Plugin cannot remove its own host: a");
    await expect(h.runtime.removeHost("missing")).rejects.toThrow("Unknown Paseo host: missing");
    expect(h.removals).toEqual([]);
    await h.runtime.removeHost("b");
    expect(h.removals).toEqual(["b"]);
    h.publish();
    expect(h.runtime.getSnapshot().map((host) => host.serverId)).toEqual(["a"]);
    h.lifetime.abort();
  });

  it("returns a host that was saved even if the plugin stopped while it connected", async () => {
    const h = registry();
    let finishProbe: (value: { serverId: string }) => void = () => {};
    h.source.probeAndUpsertRemoteSshConnection = (input) =>
      new Promise((resolve) => {
        h.upserts.push(input);
        finishProbe = (value) => {
          h.hosts.push({ serverId: value.serverId, label: "Late", password: "" });
          resolve(value);
        };
      });
    const pending = h.runtime.addRemoteSshHost({ target: "ssh://late-vm" });
    await Promise.resolve();
    h.lifetime.abort();
    finishProbe({ serverId: "late" });
    await expect(pending).resolves.toEqual({ serverId: "late", label: "Late", status: "offline" });
  });

  it("rejects host changes after the plugin stops", async () => {
    const h = registry();
    h.lifetime.abort();
    await expect(h.runtime.addRemoteSshHost({ target: "ssh://vm" })).rejects.toThrow(
      "Plugin has stopped",
    );
    await expect(h.runtime.removeHost("b")).rejects.toThrow("Plugin has stopped");
    expect(h.upserts).toEqual([]);
    expect(h.removals).toEqual([]);
  });
});
