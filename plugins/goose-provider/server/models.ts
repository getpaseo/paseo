import type { AcpRequest, AcpTransformer } from "@getpaseo/plugin/server/acp";
import { z } from "zod";

const inventorySchema = z.object({
  entries: z.array(
    z.object({
      providerId: z.string(),
      providerName: z.string(),
      configured: z.boolean(),
      models: z.array(z.object({ id: z.string(), name: z.string() })),
    }),
  ),
});
const configValueSchema = z.object({ value: z.string().min(1) });

async function configuredProviders(request: AcpRequest) {
  // COMPAT(gooseProvider): added in v0.17.0, remove after 2027-05-20 once supported goose versions have this RPC.
  const response = await request("_goose/unstable/providers/list", { providerIds: [] }).catch(
    () => null,
  );
  const inventory = inventorySchema.safeParse(response);
  return inventory.success ? inventory.data.entries.filter((entry) => entry.configured) : [];
}

async function readDefault(request: AcpRequest, key: "GOOSE_PROVIDER" | "GOOSE_MODEL") {
  const response = await request("_goose/unstable/config/read", { key }).catch(() => null);
  const parsed = configValueSchema.safeParse(response);
  return parsed.success ? parsed.data.value : undefined;
}

export const gooseModels = {
  async discover(catalog, { request }) {
    const providers = await configuredProviders(request);
    if (providers.length === 0) return catalog;

    const models = providers.flatMap((provider) =>
      provider.models.map((model) => ({
        id: `${provider.providerId}/${model.id}`,
        label: model.name,
        description: provider.providerName,
      })),
    );
    if (models.length === 0) return catalog;

    const [providerId, modelId] = await Promise.all([
      readDefault(request, "GOOSE_PROVIDER"),
      readDefault(request, "GOOSE_MODEL"),
    ]);
    return {
      ...catalog,
      models,
      defaultModel: providerId && modelId ? `${providerId}/${modelId}` : undefined,
    };
  },

  async configure(change, { config, request }) {
    if (change.target !== "model" || !change.value) return "pass";
    const separator = change.value.indexOf("/");
    if (separator <= 0) return "pass";

    const providerId = change.value.slice(0, separator);
    const providers = await configuredProviders(request);
    if (!providers.some((provider) => provider.providerId === providerId)) return "pass";

    await config.set("provider", providerId);
    await config.set("model", change.value.slice(separator + 1));
    return "handled";
  },

  config(state) {
    const provider = state.settings?.find((setting) => setting.id === "provider");
    if (provider?.type !== "select" || !provider.value || provider.value === "goose") {
      return state;
    }
    const namespace = (modelId: string) => `${provider.value}/${modelId}`;
    return {
      ...state,
      model: state.model === undefined ? undefined : namespace(state.model),
      models: state.models.map((model) => ({ ...model, id: namespace(model.id) })),
    };
  },
} satisfies AcpTransformer;
