import { createPluginHosts } from "./hosts";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import type { PaseoApi } from "@getpaseo/client";
import { expect, test } from "vitest";
import { PluginRegistry } from "./registry";

/** A host client that records open event observations by their first event name. */
function observingClient() {
  const open = new Set<string>();
  const client = {
    observeEvents(events: string[]) {
      const [name] = events;
      open.add(name);
      return {
        ready: Promise.resolve({ subscriptionId: name }),
        subscribe: () => () => undefined,
        release: async () => {
          open.delete(name);
        },
      };
    },
    invokePluginRpc: async () => null,
  } as unknown as DaemonClient;
  return { client, open };
}

function registry() {
  const setupClients = new Map<string, PaseoApi>();
  const plugins = new PluginRegistry({
    version: "0.8.0",
    createRuntime: (installation) => {
      setupClients.set(installation.id, installation.paseo);
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
        rpc: async () => {
          throw new Error("Unexpected plugin RPC");
        },
        openScreen: () => {},
        openSurface: () => {},
        openSettings: () => {},
        openPanel: () => {},
        addComposerPill: () => ({ update() {}, remove() {} }),
        addHeaderButton: () => ({ update() {}, remove() {} }),
      };
    },
  });
  return { ...observingClient(), plugins, setupClients };
}

/** A plugin whose setup opens an observation named after it and never releases it. */
function catalog(id: string, body = "return function() {};") {
  return {
    id,
    requirements: { paseo: ">=0.8.0" },
    clientBundle: `(function() { return { default: function(plugin) { plugin.paseo.observeEvents(["${id}"]); ${body} } }; })`,
  };
}

test("setup and every surface share the installation's one Paseo client", () => {
  const h = registry();
  h.plugins.installCatalog("host", [catalog("deploys")], { client: h.client });

  const [installation] = h.plugins.getSnapshot();
  expect(h.setupClients.get("deploys")).toBe(installation.paseo);
  expect(h.open).toEqual(new Set(["deploys"]));
});

test("teardown ends every subscription the plugin still holds", async () => {
  const h = registry();
  h.plugins.installCatalog("host", [catalog("disabled"), catalog("kept")], { client: h.client });
  expect(h.open).toEqual(new Set(["disabled", "kept"]));

  // Disabling one plugin removes it from the catalog.
  h.plugins.installCatalog("host", [catalog("kept")], { client: h.client });
  await expect.poll(() => [...h.open]).toEqual(["kept"]);

  h.plugins.removeHost("host");
  await expect.poll(() => h.open.size).toBe(0);
});

test("reloading a plugin ends the old installation's subscriptions", async () => {
  const h = registry();
  h.plugins.installCatalog("host", [catalog("reloaded")], { client: h.client });
  const [first] = h.plugins.getSnapshot();

  h.plugins.installCatalog("host", [catalog("reloaded")], {
    client: h.client,
    replacePluginId: "reloaded",
  });

  const [second] = h.plugins.getSnapshot();
  expect(second).not.toBe(first);
  expect(second.paseo).not.toBe(first.paseo);
  await expect(first.paseo.dispose()).resolves.toBeUndefined();
  expect(() => first.paseo.observeEvents(["project.update"])).toThrow("Paseo API is disposed");
  expect(h.open).toEqual(new Set(["reloaded"]));
});

test("failed plugin initialization ends the subscriptions it opened", async () => {
  const h = registry();
  h.plugins.installCatalog("host", [catalog("failed", 'throw new Error("setup failed");')], {
    client: h.client,
  });
  await expect.poll(() => h.open.size).toBe(0);
  expect(h.plugins.getSnapshot()).toEqual([]);
});

test("unloading ends the subscriptions even when plugin cleanup throws, preserving another plugin", async () => {
  const h = registry();
  const failing = catalog("failing", 'return function() { throw new Error("cleanup failed"); };');
  const surviving = catalog("surviving", "return function() {};");
  h.plugins.installCatalog("host", [failing, surviving], { client: h.client });
  h.plugins.installCatalog("host", [surviving], { client: h.client });
  await expect.poll(() => [...h.open]).toEqual(["surviving"]);
  expect(h.plugins.getSnapshot().map((plugin) => plugin.id)).toEqual(["surviving"]);
  h.plugins.removeHost("host");
  await expect.poll(() => h.open.size).toBe(0);
});

test("an invalid async client entry is disposed and its rejected continuation is observed", async () => {
  const h = registry();
  h.plugins.installCatalog(
    "host",
    [catalog("async-entry", 'return Promise.reject(new Error("asynchronous setup failed"));')],
    { client: h.client },
  );
  await expect.poll(() => h.open.size).toBe(0);
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(h.plugins.getSnapshot()).toEqual([]);
});
