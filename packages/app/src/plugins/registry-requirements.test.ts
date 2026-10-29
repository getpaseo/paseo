import { createPluginHosts } from "./hosts";
import { afterEach, expect, it } from "vitest";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { PluginRegistry } from "./registry";

const audio = { play: async () => 0 };

const client = new DaemonClient({ url: "ws://unused.test", clientId: "plugin-requirements-test" });
const registries: PluginRegistry[] = [];
function registry(version: string) {
  let starts = 0;
  let cleanups = 0;
  const result = new PluginRegistry({
    localeSource: { getLocale: () => "en", subscribe: () => () => {} },
    version,
    createRuntime(installation) {
      starts++;
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
          throw new Error("No RPC in this plugin");
        },
        openSettings() {
          cleanups++;
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
    { client, audio },
  );
  expect(starts()).toBe(0);
  expect(result.getSnapshot()).toEqual([]);
  expect(result.getEvaluationError("host", "example")).toBe(
    'Plugin "example" requires Paseo >=0.9.0. Your app is 0.8.0. Use a compatible plugin version or update the app.',
  );
});

it("rejects catalogs without requirements from pre-0.8 daemons", () => {
  const { result, starts } = registry("0.8.0");
  result.installCatalog("host", [{ id: "example", clientBundle }], { client, audio });
  expect(starts()).toBe(0);
  expect(result.getEvaluationError("host", "example")).toContain(
    "https://paseo.sh/docs/plugins/migration",
  );
});

it("unloads on a requirement-only edit and recovers after correction", () => {
  const { result, starts, cleanups } = registry("0.8.0");
  const install = (paseo: string) =>
    result.installCatalog("host", [{ id: "example", clientBundle, requirements: { paseo } }], {
      client,
      audio,
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

it("rejects the unreleased translation API on 0.12.0 before evaluating its imports", () => {
  const { result, starts } = registry("0.12.0");
  result.installCatalog(
    "host",
    [
      {
        id: "translated",
        requirements: { paseo: ">=0.12.1" },
        clientBundle: `(function(require) { require("@getpaseo/plugin/client").defineTranslations({ resources: { en: { title: "Notes" } } }); throw new Error("unsupported API evaluated"); })`,
      },
    ],
    { client, audio },
  );
  expect(starts()).toBe(0);
  expect(result.getSnapshot()).toEqual([]);
  expect(result.getEvaluationError("host", "translated")).toBe(
    'Plugin "translated" requires Paseo >=0.12.1. Your app is 0.12.0. Use a compatible plugin version or update the app.',
  );
});

it("skips file-panel bundles on older apps and installs them on the required app", () => {
  const entry = {
    id: "files",
    requirements: { paseo: ">=0.13.0" },
    clientBundle: `(function() { return { default(client) {
      client.addFilePanel({ id: "pdf", title: "PDF", icon: "FileText",
        files: { extensions: ["pdf"] }, document: "bytes", Component() { return null; } });
      return () => {};
    } }; })`,
  };
  const old = registry("0.12.0");
  old.result.installCatalog("host", [entry], { client, audio });
  expect(old.starts()).toBe(0);
  expect(old.result.getSnapshot()).toEqual([]);
  const current = registry("0.13.0");
  current.result.installCatalog("host", [entry], { client, audio });
  expect(current.starts()).toBe(1);
  expect(current.result.getSnapshot()[0]?.filePanels.map((panel) => panel.id)).toEqual(["pdf"]);
});
