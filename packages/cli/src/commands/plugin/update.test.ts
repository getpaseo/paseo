import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { describe, expect, it } from "vitest";
import { render } from "../../output/index.js";
import { type PluginUpdateDependencies, runPluginUpdateCommandWithDependencies } from "./index.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };
const updateResult = [
  {
    id: "git-plugin",
    previousCommit: "1557a34c91e2abcdef",
    currentCommit: "92d85c3a4410fedcba",
    commits: 1,
    updated: true,
  },
];

function createDependencies(calls: Array<[string | undefined, string | undefined]>) {
  const client = {
    updatePluginSources: async (pluginId?: string, ref?: string) => {
      calls.push([pluginId, ref]);
      return updateResult;
    },
  } as unknown as DaemonClient;
  return {
    withPluginSourceClient: async (_target, run) => run(client),
    withPluginSourceRefClient: async (_target, run) => run(client),
  } satisfies PluginUpdateDependencies;
}

describe("plugin update command", () => {
  it("updates one Git plugin to an explicit ref with human and JSON output", async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    const result = await runPluginUpdateCommandWithDependencies({
      pluginId: "git-plugin",
      options: { daemonTarget, ref: "92d85c3a4410fedcba" },
      dependencies: createDependencies(calls),
    });

    expect(calls).toEqual([["git-plugin", "92d85c3a4410fedcba"]]);
    expect(render(result, { noColor: true })).toContain("92d85c3a4410");
    expect(JSON.parse(render(result, { format: "json" }))).toEqual(updateResult);
  });

  it("preserves the existing update request when --ref is omitted", async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    await runPluginUpdateCommandWithDependencies({
      pluginId: "git-plugin",
      options: { daemonTarget },
      dependencies: createDependencies(calls),
    });

    expect(calls).toEqual([["git-plugin", undefined]]);
  });

  it("requires one plugin ID for an explicit ref before connecting", async () => {
    const calls: Array<[string | undefined, string | undefined]> = [];
    await expect(
      runPluginUpdateCommandWithDependencies({
        pluginId: undefined,
        options: { daemonTarget, all: true, ref: "main" },
        dependencies: createDependencies(calls),
      }),
    ).rejects.toThrow("--ref requires one plugin ID and cannot be used with --all");
    expect(calls).toEqual([]);
  });
});
