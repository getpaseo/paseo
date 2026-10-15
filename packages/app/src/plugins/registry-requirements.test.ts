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

it("runs client plugins even when their declared range excludes this app version", () => {
  const { result, starts } = registry("0.11.1");
  result.installCatalog(
    "host",
    [
      {
        id: "example",
        requirements: { paseo: "^0.8.0" },
        clientBundle,
      },
    ],
    { client, audio },
  );
  expect(starts()).toBe(1);
  expect(result.getSnapshot().map(({ id }) => id)).toEqual(["example"]);
  expect(result.getEvaluationError("host", "example")).toBeUndefined();
});

it("loads catalogs without requirements from any daemon version", () => {
  const { result, starts } = registry("0.11.1");
  result.installCatalog("host", [{ id: "example", clientBundle }], { client, audio });
  expect(starts()).toBe(1);
  expect(result.getSnapshot().map(({ id }) => id)).toEqual(["example"]);
});

it("surfaces malformed requirements and real client evaluation errors", () => {
  const { result } = registry("0.11.1");
  result.installCatalog(
    "host",
    [{ id: "bad-requirement", requirements: { paseo: "latest" }, clientBundle }],
    { client, audio },
  );
  expect(result.getEvaluationError("host", "bad-requirement")).toContain(
    "Invalid requirements.paseo",
  );
  result.installCatalog("host", [{ id: "broken", clientBundle: "throw new Error('boom')" }], {
    client,
    audio,
  });
  expect(result.getEvaluationError("host", "broken")).toContain("boom");
});

it("re-evaluates requirement-only edits without rejecting version differences", () => {
  const { result, starts, cleanups } = registry("0.11.1");
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
  expect(starts()).toBe(2);
  expect(result.getSnapshot().map(({ id }) => id)).toEqual(["example"]);
  expect(result.getEvaluationError("host", "example")).toBeUndefined();
});
