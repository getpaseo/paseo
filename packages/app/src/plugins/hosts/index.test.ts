import { describe, expect, it } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { createPluginHosts, type PluginHostsSource } from "./index";

function registry() {
  const hosts = [
    { serverId: "a", label: "Alpha", password: "secret" },
    { serverId: "b", label: "Beta", password: "secret" },
  ];
  const snapshots = new Map<string, NonNullable<ReturnType<PluginHostsSource["getSnapshot"]>>>();
  const listeners = new Set<() => void>();
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
  };
  const lifetime = new AbortController();
  const runtime = createPluginHosts(source, lifetime.signal);
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
