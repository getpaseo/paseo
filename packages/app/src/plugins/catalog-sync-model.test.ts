import appPackage from "../../package.json";
import { afterEach, expect, it } from "vitest";
import { QueryObserver } from "@tanstack/react-query";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { SessionOutboundMessage } from "@getpaseo/protocol/messages";
import { settingsRpc } from "@getpaseo/plugin";
import { syncPluginCatalog } from "./catalog-sync-model";
import { createPluginHosts } from "./hosts";
import { PluginRegistry } from "./registry";
import { pluginSettingsKey } from "./settings/query";
import type { InstalledPlugin } from "./types";

const audio = { play: async () => 0 };
const rpc = settingsRpc("preferences");
type Catalog = Awaited<ReturnType<DaemonClient["getPluginCatalog"]>>;
type Observation = ReturnType<DaemonClient["observeEvents"]>;
type Observer = Parameters<Observation["subscribe"]>[0];

class SettingsStore {
  private revision = 1;
  private values = { label: "original" };
  reads = 0;

  read() {
    this.reads++;
    return { status: "ready", revision: String(this.revision), values: this.values } as const;
  }

  write(input: unknown) {
    const write = rpc.write.input.parse(input);
    if (write.revision !== String(this.revision)) {
      return { status: "conflict", error: "Settings changed" } as const;
    }
    const values = write.values;
    if (typeof values !== "object" || values === null || !("label" in values)) {
      throw new Error("Expected settings values");
    }
    if (typeof values.label !== "string") throw new Error("Expected label");
    this.values = { label: values.label };
    this.revision++;
    return { status: "saved", revision: String(this.revision), values: this.values } as const;
  }
}

/** In-memory daemon port; it delivers owned snapshots and stops updates on release. */
class CatalogClient extends DaemonClient {
  catalog = catalog("one");
  fetches = 0;
  releases = 0;
  events: Parameters<DaemonClient["observeEvents"]>[0] = [];
  private readonly observers = new Set<Observer>();

  constructor(readonly settings = new SettingsStore()) {
    super({ url: "ws://unused.test", clientId: "catalog-sync-test" });
  }

  override async getPluginCatalog(): Promise<Catalog> {
    this.fetches++;
    return this.catalog;
  }

  override observeEvents(events: Parameters<DaemonClient["observeEvents"]>[0]): Observation {
    this.events = events;
    const snapshot = { requestId: "events", subscriptionId: "catalog" };
    const subscribers = new Set<Observer>();
    return {
      subscriptionId: snapshot.subscriptionId,
      ready: Promise.resolve(snapshot),
      subscribe: (observer) => {
        subscribers.add(observer);
        this.observers.add(observer);
        observer.snapshot(snapshot);
        return () => {
          subscribers.delete(observer);
          this.observers.delete(observer);
        };
      },
      release: async () => {
        this.releases++;
        for (const observer of subscribers) this.observers.delete(observer);
        subscribers.clear();
      },
    };
  }

  override async invokePluginRpc(_pluginId: string, method: string, input: unknown) {
    if (method === rpc.read.name) return this.settings.read();
    if (method === rpc.write.name) return this.settings.write(input);
    throw new Error(`Unexpected RPC: ${method}`);
  }

  update(message: SessionOutboundMessage) {
    for (const observer of this.observers) observer.update(message);
  }

  snapshot() {
    for (const observer of this.observers) {
      observer.snapshot({ requestId: "reconnect", subscriptionId: "catalog" });
    }
  }
}

function catalog(marker: string): Catalog {
  return [
    {
      id: "reports",
      requirements: { paseo: `>=${appPackage.version}` },
      clientBundle: `(function() { return { default: function(plugin) {
      plugin.addTimelineTransformer({
        id: "report", query: { itemType: "tool_call" },
        transform() { return ${JSON.stringify(marker)} ? { items: [] } : undefined; }
      });
      return function() { plugin.openSettings("cleanup"); };
    } }; })`,
    },
  ];
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function harness() {
  let evaluations = 0;
  let disposals = 0;
  const registry = new PluginRegistry({
    localeSource: { getLocale: () => "en", subscribe: () => () => {} },
    version: appPackage.version,
    createRuntime(installation) {
      evaluations++;
      return {
        hosts: createPluginHosts(
          {
            getHosts: () => [],
            getSnapshot: () => null,
            subscribeAll: () => () => {},
            subscribeHostList: () => () => {},
          },
          installation.lifetime.signal,
        ),
        paseo: installation.paseo,
        i18n: installation.i18n,
        rpc: async () => {
          throw new Error("Unexpected runtime RPC");
        },
        openSettings: () => {
          disposals++;
        },
        openScreen() {},
        openSurface() {},
        async playAudio() {},
        openPanel() {},
        addComposerPill: () => ({ update() {}, remove() {} }),
        addHeaderButton: () => ({ update() {}, remove() {} }),
      };
    },
  });
  const client = new CatalogClient();
  cleanups.push(() => {
    registry.removeHost("host");
    registry.removeHost("other");
  });
  function sync(options: Partial<Parameters<typeof syncPluginCatalog>[0]> = {}) {
    const stop = syncPluginCatalog({
      serverId: "host",
      client,
      audio,
      connected: true,
      supported: true,
      registry,
      ...options,
    });
    cleanups.push(stop);
    return stop;
  }
  function installed(serverId = "host") {
    const plugin = registry.getSnapshot().find((entry) => entry.serverId === serverId);
    if (!plugin) throw new Error(`Missing installation: ${serverId}`);
    return plugin;
  }
  return {
    registry,
    client,
    sync,
    installed,
    evaluations: () => evaluations,
    disposals: () => disposals,
  };
}

async function connected() {
  const h = harness();
  const stop = h.sync();
  await expect.poll(() => h.registry.getSnapshot().length).toBe(1);
  return { ...h, stop };
}

function settingsQuery(plugin: InstalledPlugin) {
  return {
    queryKey: pluginSettingsKey("preferences"),
    queryFn: async () => rpc.read.output.parse(await plugin.invoke(rpc.read.name, {})),
    // The replica policy used by useSettings deliberately disables automatic refetches.
    gcTime: Infinity,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: false,
  } as const;
}

it("retains installations and timeline transforms while disconnected", async () => {
  const h = await connected();
  const plugin = h.installed();
  const snapshot = h.registry.getSnapshot();
  const transformers = plugin.timelineTransformers;
  h.stop();
  h.sync({ connected: false });
  h.client.update({
    type: "status",
    payload: { status: "plugin_catalog_changed", pluginId: "reports" },
  });
  expect(h.registry.getSnapshot()).toBe(snapshot);
  expect(h.installed().timelineTransformers).toBe(transformers);
  expect(plugin.lifetime.signal.aborted).toBe(false);
  expect(h.disposals()).toBe(0);
  expect(h.client.fetches).toBe(1);
  expect(h.client.events).toEqual([
    "status.plugin_catalog_changed",
    "status.plugin_settings_changed",
  ]);
});

it.each(["mounted", "unmounted"])(
  "refreshes %s settings and revisions after another client saves offline",
  async (surface) => {
    const h = await connected();
    const plugin = h.installed();
    const snapshot = h.registry.getSnapshot();
    const options = settingsQuery(plugin);
    const original = await plugin.queryClient.fetchQuery(options);
    const observer = new QueryObserver(plugin.queryClient, options);
    const unsubscribe = observer.subscribe(() => {});
    cleanups.push(unsubscribe);
    if (surface === "unmounted") unsubscribe();
    plugin.queryClient.setQueryData(["attachment-search"], "retained");
    const otherClient = new CatalogClient();
    h.registry.installCatalog("other", otherClient.catalog, { client: otherClient, audio });
    const otherPlugin = h.installed("other");
    await otherPlugin.queryClient.fetchQuery(settingsQuery(otherPlugin));
    // Another host publishes new presentation snapshots without replacing the owning lifetime.
    const beforeReconnect = h.registry.getSnapshot();
    const retainedInstallation = h.installed();

    h.stop();
    h.sync({ connected: false });
    const clientB = new CatalogClient(h.client.settings);
    expect(
      await clientB.invokePluginRpc("reports", rpc.write.name, {
        revision: original.revision,
        values: { label: "client B" },
      }),
    ).toEqual({ status: "saved", revision: "2", values: { label: "client B" } });
    expect(plugin.queryClient.getQueryData(options.queryKey)).toEqual(original);
    h.sync();

    await expect
      .poll(() => plugin.queryClient.getQueryData(options.queryKey))
      .toEqual({
        status: "ready",
        revision: "2",
        values: { label: "client B" },
      });
    const refreshed = await plugin.queryClient.fetchQuery(options);
    expect(
      await plugin.invoke(rpc.write.name, {
        revision: refreshed.revision,
        values: { label: "client A" },
      }),
    ).toEqual({ status: "saved", revision: "3", values: { label: "client A" } });
    expect(h.registry.getSnapshot()).toBe(beforeReconnect);
    expect(h.installed()).toBe(retainedInstallation);
    expect(h.installed().lifetime).toBe(plugin.lifetime);
    expect(h.installed().queryClient).toBe(plugin.queryClient);
    expect(h.installed().timelineTransformers).toBe(snapshot[0].timelineTransformers);
    expect(plugin.queryClient.getQueryData(["attachment-search"])).toBe("retained");
    expect(otherClient.settings.reads).toBe(1);
    expect(otherPlugin.queryClient.getQueryState(options.queryKey)?.isInvalidated).toBe(false);
    expect(otherPlugin.queryClient.getQueryData(options.queryKey)).toEqual(original);
    expect(h.evaluations()).toBe(2);
    expect(h.disposals()).toBe(0);
  },
);

it("replaces changed bundles on reconnect and disposes the old installation", async () => {
  const h = await connected();
  const plugin = h.installed();
  plugin.queryClient.setQueryData(["attachment-search"], "old");
  h.stop();
  h.client.catalog = catalog("two");
  h.sync();
  await expect.poll(() => h.installed() === plugin).toBe(false);
  expect(plugin.lifetime.signal.aborted).toBe(true);
  expect(plugin.queryClient.getQueryCache().getAll()).toEqual([]);
  expect(h.installed().timelineTransformers.map((entry) => entry.id)).toEqual(["report"]);
  expect(h.evaluations()).toBe(2);
  expect(h.disposals()).toBe(1);
});

it("replaces an explicitly reloaded bundle even when its source is unchanged", async () => {
  const h = await connected();
  const plugin = h.installed();
  h.client.update({
    type: "status",
    payload: { status: "plugin_catalog_changed", pluginId: "reports" },
  });
  await expect.poll(() => h.installed() === plugin).toBe(false);
  expect(h.disposals()).toBe(1);
  expect(h.evaluations()).toBe(2);
});

it.each(["unsupported", "no audio"])("disposes plugins when %s", async (reason) => {
  const h = await connected();
  const plugin = h.installed();
  h.stop();
  h.sync({ supported: reason !== "unsupported", audio: reason === "no audio" ? null : audio });
  expect(h.registry.getSnapshot()).toEqual([]);
  expect(plugin.lifetime.signal.aborted).toBe(true);
  expect(h.disposals()).toBe(1);
});

it("refreshes settings on a replayed subscription snapshot without reinstalling", async () => {
  const h = await connected();
  const plugin = h.installed();
  const options = settingsQuery(plugin);
  await plugin.queryClient.fetchQuery(options);
  h.client.settings.write({ revision: "1", values: { label: "replayed" } });
  h.client.snapshot();
  await expect
    .poll(() => plugin.queryClient.getQueryData(options.queryKey))
    .toEqual({
      status: "ready",
      revision: "2",
      values: { label: "replayed" },
    });
  expect(h.installed()).toBe(plugin);
  expect(h.evaluations()).toBe(1);
});

it("invalidates only the named settings on its host for a live notification", async () => {
  const h = await connected();
  const plugin = h.installed();
  const options = settingsQuery(plugin);
  await plugin.queryClient.fetchQuery(options);
  const observer = new QueryObserver(plugin.queryClient, options);
  cleanups.push(observer.subscribe(() => {}));
  plugin.queryClient.setQueryData(pluginSettingsKey("other-settings"), "unchanged");
  const other = new CatalogClient();
  h.registry.installCatalog("other", other.catalog, { client: other, audio });
  await h.installed("other").queryClient.fetchQuery(settingsQuery(h.installed("other")));

  const beforeNotification = h.registry.getSnapshot();
  const retainedInstallation = h.installed();
  h.client.settings.write({ revision: "1", values: { label: "live" } });
  h.client.update({
    type: "status",
    payload: {
      status: "plugin_settings_changed",
      pluginId: "reports",
      settingsId: "preferences",
    },
  });

  await expect
    .poll(() => plugin.queryClient.getQueryData(options.queryKey))
    .toEqual({
      status: "ready",
      revision: "2",
      values: { label: "live" },
    });
  expect(plugin.queryClient.getQueryState(pluginSettingsKey("other-settings"))?.isInvalidated).toBe(
    false,
  );
  expect(other.settings.reads).toBe(1);
  expect(h.registry.getSnapshot()).toBe(beforeNotification);
  expect(h.installed()).toBe(retainedInstallation);
  expect(h.installed().lifetime).toBe(plugin.lifetime);
  expect(h.installed().queryClient).toBe(plugin.queryClient);
  expect(h.evaluations()).toBe(2);
  expect(h.client.fetches).toBe(1);
});

it("ignores an in-flight catalog snapshot after disconnect", async () => {
  const h = await connected();
  const plugin = h.installed();
  await plugin.queryClient.fetchQuery(settingsQuery(plugin));
  const snapshot = h.registry.getSnapshot();
  h.stop();
  let resolveCatalog: (value: Catalog) => void = () => {};
  const pending = new Promise<Catalog>((resolve) => {
    resolveCatalog = resolve;
  });
  let fetching: () => void = () => {};
  const started = new Promise<void>((resolve) => {
    fetching = resolve;
  });
  class PendingClient extends CatalogClient {
    override getPluginCatalog() {
      fetching();
      return pending;
    }
  }
  const stop = h.sync({ client: new PendingClient(h.client.settings) });
  await started;
  stop();
  resolveCatalog(catalog("late"));
  await pending;
  // Drain the catalog continuation through a subsequently queued task.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(h.registry.getSnapshot()).toBe(snapshot);
  expect(h.client.settings.reads).toBe(1);
  expect(h.evaluations()).toBe(1);
});
