import type { ProviderCatalog, ProviderLaunch } from "@getpaseo/plugin/server/provider";
import type { z } from "zod";
import { createHash } from "node:crypto";
import { MspConnection } from "./connection.js";
import { catalogSchema, effortSchema } from "./wire.js";

export const modes = [
  { id: "onRequest", label: "Default", icon: "ShieldCheck", colorTier: "safe" },
  { id: "promptUnmatched", label: "Ask", icon: "ShieldAlert", colorTier: "moderate" },
  { id: "denyUnmatched", label: "Strict", icon: "ShieldCheck", colorTier: "safe" },
  {
    id: "allowAll",
    label: "Full access",
    icon: "ShieldOff",
    colorTier: "dangerous",
    isUnattended: true,
  },
];
export const efforts = effortSchema.options.filter((effort) => effort !== "none");

export function launchKey(launch: ProviderLaunch): string {
  // Hash values so credential-dependent cache identity never exposes credentials.
  const routingKeys = Object.keys(launch.env)
    .filter((key) => /^(META_|MUSE_|XDG_|HOME$|PATH$|HTTP_PROXY$|HTTPS_PROXY$|NO_PROXY$)/.test(key))
    .sort();
  const environment = routingKeys.map((key) => [key, launch.env[key]]);
  return createHash("sha256")
    .update(JSON.stringify([launch.command, launch.args, environment]))
    .digest("hex");
}

export class Catalog {
  private readonly cache = new Map<string, { expires: number; catalog: ProviderCatalog }>();
  private readonly hosts = new Set<MspConnection>();
  private closed = false;
  async read(launch: ProviderLaunch): Promise<ProviderCatalog> {
    if (this.closed) throw new Error("Muse catalogue is closed");
    const key = launchKey(launch);
    const cached = this.cache.get(key);
    if (cached && cached.expires > Date.now()) return cached.catalog;
    const host = new MspConnection({ launch, timeoutMs: 5000 });
    this.hosts.add(host);
    try {
      await host.initialize();
      const response = await host.request("model/list", {}, catalogSchema);
      const catalog = presentCatalog(response);
      if (!this.closed) {
        if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { expires: Date.now() + 60000, catalog });
      }
      return catalog;
    } finally {
      await host.close();
      this.hosts.delete(host);
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.cache.clear();
    await Promise.all([...this.hosts].map((host) => host.close()));
  }
}

export function presentCatalog(response: z.infer<typeof catalogSchema>): ProviderCatalog {
  const models = response.models.map((model) => {
    const supported = model.variants.length > 0 ? model.variants : efforts;
    return {
      id: model.modelId,
      label: model.displayLabel,
      isDefault: model.isDefault,
      contextWindowMaxTokens: model.contextLimit ?? undefined,
      thinkingOptions: supported.map((id) => ({
        id,
        label: id,
        isDefault: id === model.defaultReasoningEffort,
      })),
      defaultThinkingOptionId: model.defaultReasoningEffort ?? undefined,
      metadata: { providerId: model.providerId },
    };
  });
  const defaultModel = models.find((model) => model.isDefault);
  return {
    models,
    modes,
    defaultMode: "onRequest",
    defaultModel: defaultModel?.id,
  };
}
