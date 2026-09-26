import type {
  PluginForgeSerializedError,
  PluginForgeServerProviderDescriptor,
  PluginForgeServiceMethod,
  PluginPresence,
} from "@getpaseo/plugin/server";
import { PLUGIN_FORGE_SERVICE_METHODS } from "@getpaseo/plugin/server";
import type {
  ProviderConnectRequest,
  ProviderCatalogOptions,
  ProviderEvent,
  ProviderInput,
} from "@getpaseo/plugin/server/provider";
import { ProviderEventSchema, ProviderInputSchema } from "@getpaseo/plugin/server/provider";
import { z } from "zod";
import { ForgeProviderDescriptorSchema } from "./forge-validation.js";

export interface PluginProviderMetadata {
  hasCatalogCacheKey?: boolean;
  id: string;
  label: string;
  description?: string;
  iconPath?: string;
}

export type PluginProcessRequest =
  | {
      type: "initialize";
      pluginId: string;
      bundle: string;
      appVersion: string;
      settingsDirectory?: string;
    }
  | {
      type: "provider.catalog_key";
      requestId: string;
      providerId: string;
      options: ProviderCatalogOptions;
    }
  | { type: "hook"; requestId: string; kind: "event" | "before"; name: string; input: unknown }
  | { type: "hook.cancel"; requestId: string }
  | { type: "invoke"; requestId: string; method: string; input: unknown }
  | {
      type: "provider.connect";
      providerId: string;
      connectionId: string;
      request: ProviderConnectRequest;
    }
  | {
      type: "provider.send";
      connectionId: string;
      acceptanceId: string;
      input: ProviderInput;
    }
  | { type: "provider.close"; connectionId: string }
  | {
      type: "invoke_forge";
      requestId: string;
      providerId: string;
      method: PluginForgeServiceMethod | "probeHost";
      input: unknown;
    }
  | { type: "shutdown" }
  | { type: "presence.result"; requestId: string; presence: PluginPresence }
  | { type: "paseo_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "paseo_close" };

export type PluginProcessMessage =
  | { type: "settings.changed"; settingsId: string }
  | { type: "hooks.changed"; hooks: { events: string[]; before: string[] } }
  | {
      type: "ready";
      methods: string[];
      providers: PluginProviderMetadata[];
      hooks?: { events: string[]; before: string[] };
      forgeProviders: PluginForgeServerProviderDescriptor[];
    }
  | { type: "result"; requestId: string; output: unknown }
  | { type: "error"; requestId: string; error: string }
  | { type: "forge_result"; requestId: string; output: unknown }
  | { type: "forge_error"; requestId: string; error: PluginForgeSerializedError }
  | { type: "fatal"; error: string }
  | {
      type: "provider.connected";
      connectionId: string;
      version: number;
      capabilities: readonly string[];
    }
  | { type: "provider.connect_failed"; connectionId: string; error: string }
  | { type: "provider.accepted"; connectionId: string; acceptanceId: string }
  | {
      type: "provider.rejected";
      connectionId: string;
      acceptanceId: string;
      error: string;
    }
  | { type: "provider.event"; connectionId: string; event: ProviderEvent }
  | { type: "provider.closed"; connectionId: string; error?: string }
  | { type: "presence.request"; requestId: string }
  | { type: "paseo_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "paseo_close" };

const hooksSchema = z.object({ events: z.array(z.string()), before: z.array(z.string()) }).strict();

const providerMetadataSchema = z
  .object({
    id: z.string().min(1),
    label: z.string().min(1),
    description: z.string().optional(),
    iconPath: z.string().optional(),
    hasCatalogCacheKey: z.boolean().optional(),
  })
  .strict();
const providerConnectRequestSchema = z
  .object({
    versions: z.array(z.number().int().positive()),
    capabilities: z.array(z.string()),
  })
  .strict();
const forgeSerializedErrorSchema = z
  .object({
    message: z.string(),
    name: z.string().optional(),
    kind: z.enum(["missing-cli", "auth-failure", "command-error"]).optional(),
    stderr: z.string().optional(),
    args: z.array(z.string()).optional(),
    cwd: z.string().optional(),
    exitCode: z.number().nullable().optional(),
    brand: z.string().optional(),
    binary: z.string().optional(),
  })
  .strict();
const presenceSchema = z
  .object({
    userPresent: z.boolean(),
    clients: z.array(
      z
        .object({
          deviceType: z.enum(["web", "mobile"]),
          appVisible: z.boolean(),
          focusedAgentId: z.string().nullable(),
          lastActivityAt: z.string().nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const frameFields = {
  data: z.union([z.string(), z.instanceof(Uint8Array)]),
  isBinary: z.boolean(),
};

export const PluginProcessRequestSchema: z.ZodType<PluginProcessRequest> = z.discriminatedUnion(
  "type",
  [
    z
      .object({
        type: z.literal("initialize"),
        pluginId: z.string().min(1),
        bundle: z.string(),
        appVersion: z.string(),
        settingsDirectory: z.string().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.catalog_key"),
        requestId: z.string().min(1),
        providerId: z.string().min(1),
        options: z.discriminatedUnion("scope", [
          z.object({ scope: z.literal("global"), force: z.boolean().optional() }).strict(),
          z
            .object({
              scope: z.literal("workspace"),
              cwd: z.string(),
              force: z.boolean().optional(),
            })
            .strict(),
        ]),
      })
      .strict(),
    z
      .object({
        type: z.literal("hook"),
        requestId: z.string(),
        kind: z.enum(["event", "before"]),
        name: z.string(),
        input: z.unknown(),
      })
      .strict(),
    z.object({ type: z.literal("hook.cancel"), requestId: z.string() }).strict(),
    z
      .object({
        type: z.literal("invoke"),
        requestId: z.string().min(1),
        method: z.string().min(1),
        input: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.connect"),
        providerId: z.string().min(1),
        connectionId: z.string().min(1),
        request: providerConnectRequestSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.send"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
        input: ProviderInputSchema,
      })
      .strict(),
    z.object({ type: z.literal("provider.close"), connectionId: z.string().min(1) }).strict(),
    z
      .object({
        type: z.literal("invoke_forge"),
        requestId: z.string().min(1),
        providerId: z.string().min(1),
        method: z.union([z.enum(PLUGIN_FORGE_SERVICE_METHODS), z.literal("probeHost")]),
        input: z.unknown(),
      })
      .strict(),
    z.object({ type: z.literal("shutdown") }).strict(),
    z
      .object({
        type: z.literal("presence.result"),
        requestId: z.string().min(1),
        presence: presenceSchema,
      })
      .strict(),
    z.object({ type: z.literal("paseo_frame"), ...frameFields }).strict(),
    z.object({ type: z.literal("paseo_close") }).strict(),
  ],
);

export const PluginProcessMessageSchema: z.ZodType<PluginProcessMessage> = z.discriminatedUnion(
  "type",
  [
    z.object({ type: z.literal("settings.changed"), settingsId: z.string() }).strict(),
    z.object({ type: z.literal("hooks.changed"), hooks: hooksSchema }).strict(),
    z
      .object({
        type: z.literal("ready"),
        methods: z.array(z.string()),
        providers: z.array(providerMetadataSchema),
        hooks: hooksSchema.optional(),
        forgeProviders: z.array(ForgeProviderDescriptorSchema),
      })
      .strict(),
    z
      .object({ type: z.literal("result"), requestId: z.string().min(1), output: z.unknown() })
      .strict(),
    z
      .object({ type: z.literal("error"), requestId: z.string().min(1), error: z.string() })
      .strict(),
    z
      .object({
        type: z.literal("forge_result"),
        requestId: z.string().min(1),
        output: z.unknown(),
      })
      .strict(),
    z
      .object({
        type: z.literal("forge_error"),
        requestId: z.string().min(1),
        error: forgeSerializedErrorSchema,
      })
      .strict(),
    z.object({ type: z.literal("fatal"), error: z.string() }).strict(),
    z
      .object({
        type: z.literal("provider.connected"),
        connectionId: z.string().min(1),
        version: z.number().int().positive(),
        capabilities: z.array(z.string()),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.connect_failed"),
        connectionId: z.string().min(1),
        error: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.accepted"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.rejected"),
        connectionId: z.string().min(1),
        acceptanceId: z.string().min(1),
        error: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.event"),
        connectionId: z.string().min(1),
        event: ProviderEventSchema,
      })
      .strict(),
    z
      .object({
        type: z.literal("provider.closed"),
        connectionId: z.string().min(1),
        error: z.string().optional(),
      })
      .strict(),
    z.object({ type: z.literal("presence.request"), requestId: z.string().min(1) }).strict(),
    z.object({ type: z.literal("paseo_frame"), ...frameFields }).strict(),
    z.object({ type: z.literal("paseo_close") }).strict(),
  ],
);
