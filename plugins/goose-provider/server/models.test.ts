import type { AcpConfigureContext, AcpRequest } from "@getpaseo/plugin/server/acp";
import type { ProviderCatalog, ProviderConfigState } from "@getpaseo/plugin/server/provider";
import { describe, expect, it } from "vitest";
import { gooseModels } from "./models.js";

const routerModel = "anthropic/claude-sonnet-4.5";
const baseCatalog: ProviderCatalog = {
  models: [{ id: routerModel, label: "Sonnet" }],
  modes: [],
  defaultModel: routerModel,
};

const configuredProviders: AcpRequest = async (method, params) => {
  if (method === "_goose/unstable/providers/list") {
    expect(params).toEqual({ providerIds: [] });
    return {
      entries: [
        {
          providerId: "openrouter",
          providerName: "OpenRouter",
          configured: true,
          models: [{ id: routerModel, name: "Sonnet" }],
        },
        {
          providerId: "openai",
          providerName: "OpenAI",
          configured: true,
          models: [{ id: "gpt-4o", name: "GPT-4o" }],
        },
        {
          providerId: "anthropic",
          providerName: "Anthropic",
          configured: false,
          models: [{ id: "sonnet", name: "Sonnet" }],
        },
      ],
    };
  }
  expect(method).toBe("_goose/unstable/config/read");
  if (params && typeof params === "object" && "key" in params) {
    if (params.key === "GOOSE_PROVIDER") return { value: "openrouter" };
    if (params.key === "GOOSE_MODEL") return { value: routerModel };
  }
  throw new Error("Unexpected config key");
};

function configContext(request = configuredProviders) {
  const writes: Array<[string, unknown]> = [];
  const context: AcpConfigureContext = {
    sessionId: "goose-session",
    request,
    config: {
      async read() {
        return {};
      },
      async set(id, value) {
        writes.push([id, value]);
      },
    },
    catalog: () => baseCatalog,
    apply: async () => {},
  };
  return { context, writes };
}

describe("goose model transformer", () => {
  it("lists configured providers and keeps slash-delimited model IDs intact", async () => {
    const { context } = configContext();
    expect(await gooseModels.discover(baseCatalog, context)).toEqual({
      ...baseCatalog,
      models: [
        { id: `openrouter/${routerModel}`, label: "Sonnet", description: "OpenRouter" },
        { id: "openai/gpt-4o", label: "GPT-4o", description: "OpenAI" },
      ],
      defaultModel: `openrouter/${routerModel}`,
    });
  });

  it("keeps the base catalog when the RPC is unavailable", async () => {
    const { context } = configContext(async () => {
      throw new Error("Method not found");
    });
    expect(await gooseModels.discover(baseCatalog, context)).toBe(baseCatalog);
  });

  it("keeps the base catalog when no providers are configured", async () => {
    const { context } = configContext(async () => ({ entries: [] }));
    expect(await gooseModels.discover(baseCatalog, context)).toBe(baseCatalog);
  });

  it("sets the provider before the model and preserves slashes in the model", async () => {
    const { context, writes } = configContext();
    const result = await gooseModels.configure(
      { target: "model", value: `openrouter/${routerModel}` },
      context,
    );
    expect(result).toBe("handled");
    expect(writes).toEqual([
      ["provider", "openrouter"],
      ["model", routerModel],
    ]);
  });

  it.each(["gpt-4o", routerModel])("passes the legacy model %s through", async (value) => {
    const { context, writes } = configContext();
    expect(await gooseModels.configure({ target: "model", value }, context)).toBe("pass");
    expect(writes).toEqual([]);
  });

  function snapshotFor(provider: string): ProviderConfigState {
    return {
      model: routerModel,
      models: baseCatalog.models,
      modes: [],
      thinkingOptions: [],
      settings: [
        { type: "select", id: "provider", label: "Provider", value: provider, options: [] },
      ],
    };
  }

  it("namespaces models in a snapshot for an explicit provider", () => {
    const snapshot = snapshotFor("openrouter");
    expect(gooseModels.config(snapshot)).toEqual({
      ...snapshot,
      model: `openrouter/${routerModel}`,
      models: [{ id: `openrouter/${routerModel}`, label: "Sonnet" }],
    });
  });

  it("keeps the snapshot unchanged while goose Default is selected", () => {
    const snapshot = snapshotFor("goose");
    expect(gooseModels.config(snapshot)).toBe(snapshot);
  });
});
