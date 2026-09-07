import { describe, expect, it, vi } from "vitest";
import {
  executePluginClientSlashCommand,
  flattenPluginSlashCommandGroups,
  mergeSlashCommands,
  normalizePluginSlashCommandProviderCommands,
  resolvePluginClientSlashCommand,
} from "./model";

describe("plugin client slash commands", () => {
  it("preserves plugin order when static and dynamic commands collide", () => {
    const pluginCommands = flattenPluginSlashCommandGroups({
      groups: [
        {
          staticCommands: [{ name: "alpha-static", pluginId: "alpha" }],
          providerIndexes: [0],
        },
        {
          staticCommands: [{ name: "shared", pluginId: "beta" }],
          providerIndexes: [1],
        },
      ],
      providerResults: [
        [{ name: "shared", pluginId: "alpha" }],
        [{ name: "beta-dynamic", pluginId: "beta" }],
      ],
    });

    expect(pluginCommands.map(({ pluginId, name }) => `${pluginId}:${name}`)).toEqual([
      "alpha:alpha-static",
      "alpha:shared",
      "beta:shared",
      "beta:beta-dynamic",
    ]);

    const merged = mergeSlashCommands({
      builtIn: [],
      plugins: pluginCommands,
      provider: [],
      onPluginCollision() {},
    });
    expect(merged.map(({ command }) => `${command.pluginId}:${command.name}`)).toEqual([
      "alpha:alpha-static",
      "alpha:shared",
      "beta:beta-dynamic",
    ]);
  });

  it("uses built-in, plugin, then provider precedence", () => {
    const collision = vi.fn();
    const result = mergeSlashCommands({
      builtIn: [{ name: "clear", aliases: ["new"] }],
      plugins: [
        { name: "clear", pluginId: "review" },
        { name: "new", pluginId: "alias-collision" },
        { name: "review", pluginId: "alpha" },
        { name: "review", pluginId: "beta" },
      ],
      provider: [{ name: "review" }, { name: "usage" }],
      onPluginCollision: collision,
    });

    expect(result.map(({ source, command }) => `${source}:${command.name}`)).toEqual([
      "built-in:clear",
      "plugin:review",
      "provider:usage",
    ]);
    expect(collision).toHaveBeenCalledTimes(3);
  });

  it("passes the trimmed raw remainder as args", () => {
    const command = { name: "review" };
    expect(
      resolvePluginClientSlashCommand({
        text: "  /review   foo bar  ",
        hasAttachments: false,
        commands: [command],
      }),
    ).toEqual({ command, args: "foo bar" });
    expect(
      resolvePluginClientSlashCommand({
        text: "/review foo",
        hasAttachments: true,
        commands: [command],
      }),
    ).toBeNull();
  });

  it("normalizes commands returned by a dynamic provider", () => {
    expect(
      normalizePluginSlashCommandProviderCommands({
        pluginId: "commands",
        providerId: "filesystem",
        commands: [
          { name: " review ", description: " Review changes ", argumentHint: " [scope] " },
        ],
      }),
    ).toEqual([{ name: "review", description: "Review changes", argumentHint: "[scope]" }]);
  });

  it("rejects invalid or duplicate commands returned by a dynamic provider", () => {
    expect(() =>
      normalizePluginSlashCommandProviderCommands({
        pluginId: "commands",
        providerId: "filesystem",
        commands: [{ name: "Review", description: "Review", argumentHint: "" }],
      }),
    ).toThrow("commands/filesystem returned invalid slash command name: Review");

    expect(() =>
      normalizePluginSlashCommandProviderCommands({
        pluginId: "commands",
        providerId: "filesystem",
        commands: [
          { name: "review", description: "Review", argumentHint: "" },
          { name: "review", description: "Again", argumentHint: "" },
        ],
      }),
    ).toThrow("commands/filesystem returned duplicate slash command: review");
  });

  it("runs the client handler and reports failures", async () => {
    const run = vi.fn(async (_args: string) => undefined);
    const onError = vi.fn();
    await executePluginClientSlashCommand({ command: { run }, args: "foo", onError });
    expect(run).toHaveBeenCalledWith("foo");
    expect(onError).not.toHaveBeenCalled();

    const failure = new Error("review failed");
    await executePluginClientSlashCommand({
      command: { run: vi.fn().mockRejectedValue(failure) },
      args: "bar",
      onError,
    });
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("does not make the composer wait for a never-resolving handler", () => {
    const run = vi.fn(() => new Promise<void>(() => undefined));

    expect(
      executePluginClientSlashCommand({ command: { run }, args: "foo", onError: vi.fn() }),
    ).toBeUndefined();
    expect(run).toHaveBeenCalledWith("foo");
  });
});
