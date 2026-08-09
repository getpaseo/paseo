import { afterEach, describe, expect, it } from "vitest";
import { pluginRegistry } from "./registry";

function bundle(marker: string): string {
  return `(function() {
    const module = { exports: {} };
    module.exports.default = function(plugin) {
      function Surface() { return ${JSON.stringify(marker)}; }
      plugin.addSurface("main", Surface);
      plugin.addSidebarItem({ id: "main", title: "Example", icon: "Blocks", surface: "main" });
    };
    return module.exports;
  })`;
}

afterEach(() => {
  pluginRegistry.removeHost("host-a");
  pluginRegistry.removeHost("host-b");
});

describe("PluginRegistry", () => {
  it("preserves a plugin query cache when the same bundle reconnects", () => {
    const clientBundle = bundle("one");
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle }]);
    const first = pluginRegistry.getSnapshot()[0];
    first?.queryClient.setQueryData(["counter"], 3);

    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle }]);

    const second = pluginRegistry.getSnapshot()[0];
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
  });

  it("isolates query caches between hosts", () => {
    const clientBundle = bundle("same");
    pluginRegistry.installCatalog("host-a", [{ id: "example", clientBundle }]);
    pluginRegistry.installCatalog("host-b", [{ id: "example", clientBundle }]);
    const [hostA, hostB] = pluginRegistry.getSnapshot();
    hostA?.queryClient.setQueryData(["counter"], 3);

    expect(hostB?.queryClient.getQueryData(["counter"])).toBeUndefined();
  });
});
