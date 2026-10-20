import { describe, expect, test } from "vitest";
import type { Config } from "@opencode-ai/sdk/v2/client";
import type { ConfigEntry, PluginInfo } from "@opencode/client";
import { applyV2MiniMaxCatalog } from "./v2/minimax-catalog.js";
import type { AgentModelDefinition, ProviderSnapshotEntry } from "../../agent-sdk-types.js";
import { filterPickerAgentModels } from "../../agent-sdk-types.js";
import { validateAgentConfigurationAgainstProvider } from "../../agent-configuration-validator.js";
import { applyOpenCodeMiniMaxCatalog } from "./minimax-catalog.js";

function model(providerId: string, modelId: string): AgentModelDefinition {
  return {
    provider: "opencode",
    id: `${providerId}/${modelId}`,
    label: modelId,
    metadata: {
      providerId,
      modelId,
      providerSource: "api",
      limit: { context: 123456, output: 6543 },
      cost: { input: 7, output: 9 },
    },
  };
}

const routes = [
  ["minimax", "MiniMax-M2.7", "MiniMax-M3", "MiniMax-M3.1-Flash"],
  ["minimax-cn", "MiniMax-M2.7", "MiniMax-M3", "MiniMax-M3.1-Flash"],
  ["opencode", "minimax-m2.5-free", "minimax-m3", "minimax-m3.1-flash-free"],
  ["openrouter", "minimax/minimax-m2.7", "minimax/minimax-m3", "minimax/minimax-m3.1-flash:free"],
];

describe("OpenCode v2 MiniMax provenance", () => {
  const owned = "file:///paseo/runtime/opencode/paseo-v2-exact";
  const isOwned = (specifier: string) => specifier === owned;
  const models = [model("minimax", "MiniMax-M2.7"), model("minimax", "MiniMax-M3.1-Flash")];

  test.each<ConfigEntry[]>([
    [{ type: "document", info: { providers: { minimax: {} } } }],
    [
      {
        type: "document",
        info: {
          providers: {
            minimax: {
              settings: { baseURL: "https://api.minimax.io/anthropic" },
              models: { "MiniMax-M2.7": { modelID: "MiniMax-M2.7" } },
            },
          },
        },
      },
    ],
    [{ type: "document", info: { plugins: ["custom-plugin"] } }],
    [{ type: "document", info: { plugins: [{ package: `${owned}-custom` }] } }],
  ])("preserves native configured overrides", (...config) => {
    expect(
      filterPickerAgentModels(applyV2MiniMaxCatalog(models, config, [], isOwned)),
    ).toHaveLength(2);
  });

  test.each<PluginInfo["source"]>([
    { type: "local", path: "/custom/paseo-v2-exact" },
    { type: "package", target: "paseo" },
    { type: "sdk" },
  ])("does not trust a plugin by its name or ID: %j", (source) => {
    const plugins: PluginInfo[] = [
      { id: "paseo", source, features: {}, state: { status: "active" } },
    ];
    expect(applyV2MiniMaxCatalog(models, [], plugins, isOwned)).toBe(models);
  });

  test("exempts only the owned local bridge alongside native built-ins", () => {
    const plugins: PluginInfo[] = [
      { id: "native", source: { type: "builtin" }, features: {}, state: { status: "active" } },
      {
        id: "paseo",
        source: { type: "local", path: owned },
        features: {},
        state: { status: "active" },
      },
    ];
    const config: ConfigEntry[] = [
      { type: "directory", path: "/workspace/.opencode" },
      { type: "document", info: { plugins: [{ package: owned }] } },
    ];
    expect(
      filterPickerAgentModels(applyV2MiniMaxCatalog(models, config, plugins, isOwned)).map(
        (entry) => entry.id,
      ),
    ).toEqual(["minimax/MiniMax-M3.1-Flash"]);
  });
});

describe("OpenCode MiniMax catalog visibility", () => {
  test.each(routes)(
    "keeps %s Flash first and M3 while preserving legacy requests",
    (provider, legacy, m3, flash) => {
      const models = [model(provider, legacy), model(provider, m3), model(provider, flash)];
      const catalog = applyOpenCodeMiniMaxCatalog(models, {});
      expect(filterPickerAgentModels(catalog).map((entry) => entry.id)).toEqual([
        `${provider}/${flash}`,
        `${provider}/${m3}`,
      ]);
      const snapshot: ProviderSnapshotEntry = {
        provider: "opencode",
        status: "ready",
        enabled: true,
        models: catalog,
      };
      expect(
        validateAgentConfigurationAgainstProvider({
          input: { provider: "opencode", model: `${provider}/${legacy}` },
          provider: snapshot,
        }),
      ).toEqual([]);
      expect(catalog.find((entry) => entry.id === `${provider}/${m3}`)?.metadata).toMatchObject(
        models[1]!.metadata!,
      );
      expect(models[0]).not.toHaveProperty("isVisibleInPicker");
    },
  );

  test.each<Config>([
    { provider: { minimax: { models: { "MiniMax-M2.7": {} } } } },
    { provider: { minimax: { options: { baseURL: "https://api.minimax.io/anthropic" } } } },
    { plugin: ["file:///workspace/.opencode/plugins/custom-model.ts"] },
  ])("preserves native overrides including same-ID/same-endpoint and plugin hooks", (config) => {
    const models = [model("minimax", "MiniMax-M2.7")];
    expect(filterPickerAgentModels(applyOpenCodeMiniMaxCatalog(models, config))).toHaveLength(1);
  });

  test("Paseo's exact owned tool bridge does not prevent catalog filtering", () => {
    const ownPlugin = "file:///paseo/plugins/paseo-bridge.mjs";
    const models = [model("minimax", "MiniMax-M2.7"), model("minimax", "MiniMax-M3.1-Flash")];
    const catalog = applyOpenCodeMiniMaxCatalog(
      models,
      { plugin: [ownPlugin] },
      (specifier) => specifier === ownPlugin,
    );
    expect(filterPickerAgentModels(catalog).map((entry) => entry.id)).toEqual([
      "minimax/MiniMax-M3.1-Flash",
    ]);
    const custom = applyOpenCodeMiniMaxCatalog(
      models,
      { plugin: [ownPlugin, "file:///custom/paseo-bridge.mjs"] },
      (specifier) => specifier === ownPlugin,
    );
    expect(custom).toBe(models);
  });

  test("preserves unknown provenance, non-text IDs and unrelated providers", () => {
    const models = [
      model("minimax", "speech-2.8-hd"),
      model("custom", "MiniMax-M2.7"),
      model("openai", "gpt-5"),
    ];
    expect(applyOpenCodeMiniMaxCatalog(models, {})).toEqual(models);
    const legacy = [model("minimax", "MiniMax-M2.7")];
    expect(applyOpenCodeMiniMaxCatalog(legacy, undefined)).toBe(legacy);
  });

  test("does not re-enable disabled models through explicit validation or picker visibility", () => {
    const disabled = { ...model("minimax", "MiniMax-M3.1-Flash"), isSelectable: false };
    const catalog = applyOpenCodeMiniMaxCatalog([disabled], {});
    expect(filterPickerAgentModels(catalog)).toEqual([]);
    expect(
      validateAgentConfigurationAgainstProvider({
        input: { provider: "opencode", model: disabled.id },
        provider: { provider: "opencode", enabled: true, status: "ready", models: catalog },
      }),
    ).toHaveLength(1);
  });
});
