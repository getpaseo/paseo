import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentModelDefinition } from "../../agent-sdk-types.js";
import { raceProviderRefreshAbort } from "../../provider-refresh-deadline.js";
import { projectMiniMaxCatalog } from "../opencode/minimax-catalog.js";
import type { PiRuntimeSession } from "./runtime.js";
import type { PiModel } from "./rpc-types.js";

const provenanceSchema = z.object({
  version: z.literal(1),
  customProviders: z.array(z.string()),
  customModels: z.array(z.string()),
});
export type PiCatalogProvenance = z.infer<typeof provenanceSchema>;

// The command is unique to this catalog process. Check that Pi loaded it before
// sending a slash command, so an older runtime cannot send it to a model instead.
export function createPiCatalogBridge() {
  const command = `paseo_catalog_${randomUUID().replaceAll("-", "")}`;
  const marker = `PASEO_CATALOG_${randomUUID()}`;
  const source = `
import { readFile } from "node:fs/promises";
import { join } from "node:path";
export default function paseoCatalog(pi) {
  pi.registerCommand(${JSON.stringify(command)}, {
    description: "Internal Paseo catalog provenance",
    handler: async (_args, ctx) => {
      let result = null;
      try {
        const registry = ctx.modelRegistry;
        if (typeof registry?.getRegisteredProviderIds !== "function" ||
            typeof registry?.getAll !== "function" ||
            typeof registry?.getError !== "function" || registry.getError()) {
          throw new Error("Unsupported catalog provenance");
        }
        let sdk;
        try { sdk = await import("@earendil-works/pi-coding-agent"); }
        catch { sdk = await import("@mariozechner/pi-coding-agent"); }
        if (typeof sdk.getAgentDir !== "function") throw new Error("Unknown config path");
        let config = {};
        try { config = JSON.parse((await readFile(join(sdk.getAgentDir(), "models.json"), "utf8")).replace(/^\\uFEFF/, "")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!config || typeof config !== "object" || Array.isArray(config) ||
            (config.providers !== undefined && (!config.providers || typeof config.providers !== "object" || Array.isArray(config.providers)))) {
          throw new Error("Unknown config shape");
        }
        result = {
          version: 1,
          customProviders: [...new Set([...registry.getRegisteredProviderIds(), ...Object.keys(config.providers ?? {})])],
          customModels: registry.getAll().filter(model => model.api === "pi-virtual")
            .map(model => model.provider + "/" + model.id),
        };
      } catch { /* Missing capabilities/config must preserve the native catalog. */ }
      ctx.ui.notify(${JSON.stringify(marker)} + " " + JSON.stringify(result), "info");
    },
  });
}
`;
  return { command, marker, source };
}

export async function readPiCatalogProvenance(
  session: PiRuntimeSession,
  bridge: ReturnType<typeof createPiCatalogBridge>,
  signal?: AbortSignal,
  timeoutMs = 5_000,
): Promise<PiCatalogProvenance | undefined> {
  const commands = await raceProviderRefreshAbort(signal, session.getCommands());
  if (!commands.some((entry) => entry.name === bridge.command && entry.source === "extension")) {
    return undefined;
  }
  let unsubscribe = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  const response = new Promise<PiCatalogProvenance | undefined>((resolve) => {
    unsubscribe = session.onEvent((event) => {
      if (
        event.type !== "extension_ui_request" ||
        event.method !== "notify" ||
        typeof event.message !== "string" ||
        !event.message.startsWith(`${bridge.marker} `)
      )
        return;
      let provenance: PiCatalogProvenance | undefined;
      try {
        const parsed = provenanceSchema.safeParse(
          JSON.parse(event.message.slice(bridge.marker.length + 1)),
        );
        provenance = parsed.success ? parsed.data : undefined;
      } catch {
        /* Invalid responses preserve the catalog. */
      }
      resolve(provenance);
    });
  });
  try {
    // This is a native extension command, not an inference prompt. Its response
    // and RPC acknowledgement must both complete before trusting the provenance.
    const result = await raceProviderRefreshAbort(
      signal,
      Promise.race([
        Promise.all([response, session.prompt(`/${bridge.command}`)]).then(([value]) => value),
        new Promise<undefined>((resolve) => {
          timer = setTimeout(() => resolve(undefined), timeoutMs);
        }),
      ]),
    );
    return result;
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

export function applyPiMiniMaxCatalog(
  models: AgentModelDefinition[],
  provenance: PiCatalogProvenance | undefined,
  nativeModels: PiModel[],
): AgentModelDefinition[] {
  if (!provenance) return models;
  const customProviders = new Set(provenance.customProviders);
  const customModels = new Set(provenance.customModels);
  const native = new Map(nativeModels.map((model) => [`${model.provider}/${model.id}`, model]));
  const candidates = models.map((model) => {
    const entry = native.get(model.id);
    // Restrict the projection to known text ID shapes. Media/virtual models and
    // unknown capabilities keep their native semantics and metadata.
    if (
      !entry ||
      !/^(?:minimax\/)?minimax-m\d+(?:\.\d+)?(?:-(?:flash|free|highspeed|lightning|preview))*(?::free)?$/i.test(
        entry.id,
      ) ||
      entry.api === "pi-virtual" ||
      (entry.input && !entry.input.includes("text"))
    )
      return model;
    return { ...model, metadata: { ...model.metadata, providerId: entry.provider } };
  });
  return projectMiniMaxCatalog(candidates, (model, providerId) =>
    customProviders.has(providerId) || customModels.has(model.id) ? "custom" : "builtin",
  );
}
