import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type {
  DeepReadonly,
  PluginSettingsDecision,
  PluginSettingsErrorCode,
  SettingsDefinition,
} from "../settings.js";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";
import type { PluginForgeServerProviderContribution } from "../forge.js";

export interface PluginHandlerContext {
  paseo: PaseoApi;
}

export type PluginSettingsState<Schema extends ZodType> =
  | {
      status: "ready";
      revision: string;
      values: ZodOutput<Schema>;
    }
  | {
      status: "invalid";
      revision: string;
      error: string;
      /** Why the document is unusable; set by hosts that also provide `update()`. */
      code?: PluginSettingsErrorCode;
    };

export type PluginSettingsUpdateResult<Schema extends ZodType, Result> =
  | {
      status: "saved" | "unchanged";
      revision: string;
      values: ZodOutput<Schema>;
      result: Result;
    }
  | {
      status: "invalid";
      revision: string;
      error: string;
      code: PluginSettingsErrorCode;
    };

export interface PluginSettings<Schema extends ZodType> {
  read(): Promise<PluginSettingsState<Schema>>;
  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>): PluginCleanup;
  /**
   * Runs one read-modify-write serialized with every other access to this document, including
   * client saves. The mutator receives frozen current values and must decide synchronously;
   * a commit validates against the schema and notifies subscribers and clients like a save.
   */
  update<Result>(
    mutate: (
      current: DeepReadonly<ZodOutput<Schema>>,
    ) => PluginSettingsDecision<ZodInput<Schema>, Result>,
  ): Promise<PluginSettingsUpdateResult<Schema, Result>>;
}

/**
 * Values that stay on the daemon host. Use this for API tokens and anything
 * else a connected client must never receive: settings documents are served
 * over an ordinary RPC, so a token placed there reaches every connected app.
 * Expose a write-only plugin RPC on top when the user needs a UI.
 */
export interface PluginSecretStore {
  get(key: string): Promise<string | null>;
  has(key: string): Promise<boolean>;
  /** Key names only; values are only available through `get`. */
  keys(): Promise<string[]>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  readonly paseo: PaseoApi;
  readonly secrets: PluginSecretStore;
  registerSettings<Schema extends ZodType>(
    definition: SettingsDefinition<Schema>,
  ): PluginSettings<Schema>;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
  addForgeServerProvider(contribution: PluginForgeServerProviderContribution): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
