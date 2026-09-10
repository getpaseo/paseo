import { afterEach, expect, it } from "vitest";
import { createPaseoApi } from "@getpaseo/client";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginRegistry } from "./registry";

const client = new DaemonClient({ url: "ws://unused.test", clientId: "plugin-requirements-test" });
const registries: PluginRegistry[] = [];
function registry(version: string) {
  let starts = 0;
  let cleanups = 0;
  const result = new PluginRegistry({
    version,
    createRuntime() {
      starts++;
      return {
        paseo: createPaseoApi(client),
        rpc: async () => {
          throw new Error("No RPC in this plugin");
        },
        openSettings() {
          cleanups++;
        },
        openSurface() {},
        openPanel() {},
        addComposerPill: () => ({ update() {}, remove() {} }),
        addHeaderButton: () => ({ update() {}, remove() {} }),
      };
    },
  });
  registries.push(result);
  return { result, starts: () => starts, cleanups: () => cleanups };
}
const clientBundle =
  '(function() { return { default: function(client) { return () => client.openSettings("cleanup"); } }; })';
afterEach(() => {
  for (const value of registries.splice(0)) value.removeHost("host");
});

it("checks the app version before creating a runtime or evaluating plugin code", () => {
  const { result, starts } = registry("0.8.0");
  result.installCatalog(
    "host",
    [
      {
        id: "example",
        requirements: { paseo: ">=0.9.0" },
        clientBundle: "throw new Error('executed')",
      },
    ],
    { client },
  );
  expect(starts()).toBe(0);
  expect(result.getSnapshot()).toEqual([]);
  expect(result.getEvaluationError("host", "example")).toBe(
    'Plugin "example" requires Paseo >=0.9.0. Your app is 0.8.0. Use a compatible plugin version or update the app.',
  );
});

it("rejects catalogs without requirements from pre-0.8 daemons", () => {
  const { result, starts } = registry("0.8.0");
  result.installCatalog("host", [{ id: "example", clientBundle }], { client });
  expect(starts()).toBe(0);
  expect(result.getEvaluationError("host", "example")).toContain(
    "https://paseo.sh/docs/plugins/v0.8/migration",
  );
});

it("unloads on a requirement-only edit and recovers after correction", () => {
  const { result, starts, cleanups } = registry("0.8.0");
  const install = (paseo: string) =>
    result.installCatalog("host", [{ id: "example", clientBundle, requirements: { paseo } }], {
      client,
    });
  install("^0.8.0");
  expect(result.getSnapshot().map(({ id }) => id)).toEqual(["example"]);
  install("^0.8.0");
  expect(starts()).toBe(1);
  install(">=0.9.0");
  expect(cleanups()).toBe(1);
  expect(starts()).toBe(1);
  expect(result.getSnapshot()).toEqual([]);
  expect(result.getEvaluationError("host", "example")).toContain("requires Paseo >=0.9.0");
  install(">=0.8.0");
  expect(starts()).toBe(2);
  expect(result.getSnapshot().map(({ id }) => id)).toEqual(["example"]);
  expect(result.getEvaluationError("host", "example")).toBeUndefined();
});
