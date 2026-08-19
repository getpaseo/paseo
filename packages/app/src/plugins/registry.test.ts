import { afterEach, describe, expect, it } from "vitest";
import { pluginRegistry } from "./registry";

function bundle(marker: string): string {
  return `(function() {
    const module = { exports: {} };
    module.exports.default = function(plugin) {
      function Surface() { return ${JSON.stringify(marker)}; }
      plugin.addSurface("main", Surface);
      plugin.addSidebarItem({ id: "main", title: "Example", icon: "Blocks", surface: "main" });
      plugin.addWorkspacePanel({ id: "review", title: "Review", icon: "Blocks", context: "workspace", Component: Surface });
      plugin.addCommandCenterItem({ id: "open-review", title: "Open review", icon: "Blocks", context: "workspace", onSelect() {} });
      return function() { globalThis.__pluginCleanups = (globalThis.__pluginCleanups || 0) + 1; };
    };
    return module.exports;
  })`;
}

afterEach(() => {
  pluginRegistry.removeHost("host-a");
  pluginRegistry.removeHost("host-b");
  Reflect.deleteProperty(globalThis, "__pluginCleanups");
});

describe("PluginRegistry", () => {
  it("preserves a plugin query cache when the same bundle reconnects", () => {
    const clientBundle = bundle("one");
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle }]);
    const first = pluginRegistry.getSnapshot()[0];
    first?.queryClient.setQueryData(["counter"], 3);

    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle }]);

    const second = pluginRegistry.getSnapshot()[0];
    expect(second).toBe(first);
    expect(second?.queryClient).toBe(first?.queryClient);
    expect(second?.queryClient.getQueryData(["counter"])).toBe(3);
  });

  it("replaces the query cache when the plugin bundle changes", () => {
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle: bundle("one") }]);
    const first = pluginRegistry.getSnapshot()[0];
    first?.queryClient.setQueryData(["counter"], 3);

    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle: bundle("two") }]);

    const second = pluginRegistry.getSnapshot()[0];
    expect(second?.queryClient).not.toBe(first?.queryClient);
    expect(second?.queryClient.getQueryData(["counter"])).toBeUndefined();
    expect(first?.queryClient.getQueryData(["counter"])).toBeUndefined();
    expect(Reflect.get(globalThis, "__pluginCleanups")).toBe(1);
  });

  it("isolates query caches between hosts", () => {
    const clientBundle = bundle("same");
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle }]);
    pluginRegistry.installCatalog("host-b", [{ id: "example", clientBundle }]);
    const [hostA, hostB] = pluginRegistry.getSnapshot();
    hostA?.queryClient.setQueryData(["counter"], 3);

    expect(hostB?.queryClient.getQueryData(["counter"])).toBeUndefined();
  });

  it("cleans up the old installation before evaluating its replacement", () => {
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle: bundle("one") }]);
    const replacement = `(function() { return { default: function(plugin) {
      globalThis.__cleanupSeenByReplacement = globalThis.__pluginCleanups || 0;
      plugin.addSurface("main", function() { return null; });
      return function() {};
    } }; })`;

    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle: replacement }]);

    expect(Reflect.get(globalThis, "__cleanupSeenByReplacement")).toBe(1);
    Reflect.deleteProperty(globalThis, "__cleanupSeenByReplacement");
  });

  it("replaces an unchanged bundle when explicit reload names the plugin", () => {
    const clientBundle = bundle("same");
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle }]);
    const first = pluginRegistry.getSnapshot()[0];
    first?.queryClient.setQueryData(["attachment-search"], "cached");

    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle }], {
      replacePluginId: "example",
    });

    const second = pluginRegistry.getSnapshot()[0];
    expect(second).not.toBe(first);
    expect(second?.workspacePanels.map((panel) => panel.id)).toEqual(["review"]);
    expect(second?.commandCenterItems.map((item) => item.id)).toEqual(["open-review"]);
    expect(first?.queryClient.getQueryData(["attachment-search"])).toBeUndefined();
    expect(Reflect.get(globalThis, "__pluginCleanups")).toBe(1);
  });

  it.each(["disable", "remove"])("cleans a catalog entry exactly once on %s", () => {
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle: bundle("one") }]);

    pluginRegistry.installCatalog("host-a", []);
    pluginRegistry.installCatalog("host-a", []);

    expect(Reflect.get(globalThis, "__pluginCleanups")).toBe(1);
    expect(pluginRegistry.getSnapshot()).toEqual([]);
  });

  it("cancels an in-flight attachment query during teardown", async () => {
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle: bundle("one") }]);
    const plugin = pluginRegistry.getSnapshot()[0];
    if (!plugin) throw new Error("Expected installed plugin");
    let observeAbort: () => void = () => undefined;
    const aborted = new Promise<void>((resolve) => {
      observeAbort = resolve;
    });
    void plugin.queryClient
      .fetchQuery({
        queryKey: ["plugin-attachment-search", "example"],
        queryFn: ({ signal }) =>
          new Promise<never>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              observeAbort();
              reject(new Error("aborted"));
            });
          }),
      })
      .catch(() => undefined);

    pluginRegistry.installCatalog("host-a", []);

    await aborted;
    expect(plugin.queryClient.getQueryCache().getAll()).toEqual([]);
  });

  it("continues host teardown when cleanup throws", () => {
    const throwing = `(function() { return { default: function(plugin) {
      plugin.addSurface("main", function() { return null; });
      return function() { throw new Error("cleanup exploded"); };
    } }; })`;
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle: throwing }]);
    pluginRegistry.getSnapshot()[0]?.queryClient.setQueryData(["counter"], 3);

    expect(() => pluginRegistry.removeHost("host-a")).not.toThrow();
    expect(pluginRegistry.getSnapshot()).toEqual([]);
  });
});
