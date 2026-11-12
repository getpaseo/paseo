import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract, PluginSubscriptionContract, PluginWireInput } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { UsageSourceRegistration } from "./usage.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";

export interface PluginHandlerContext {
  paseo: PaseoApi;
}

/** What a subscription handler receives beside its input. */
export interface PluginSubscriptionContext<Event = unknown> extends PluginHandlerContext {
  /**
   * Sends one event to this subscriber. A `Uint8Array` event travels as a binary frame; any other
   * event is JSON and must not contain a `Uint8Array`. Resolves once the event left the plugin
   * process. Events pushed after `signal` aborts are dropped.
   */
  push(event: Event): Promise<void>;
  /** Aborts when the subscriber releases, disconnects, or the plugin stops. */
  signal: AbortSignal;
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
    };

export interface PluginSettings<Schema extends ZodType> {
  read(): Promise<PluginSettingsState<Schema>>;
  subscribe(listener: (state: PluginSettingsState<Schema>) => void | Promise<void>): PluginCleanup;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  registerSettings<Schema extends ZodType>(
    definition: import("../settings.js").SettingsDefinition<Schema>,
  ): PluginSettings<Schema>;
  /**
   * Serves a subscription. The handler starts the work and returns; the subscription stays open
   * until `signal` aborts. A handler that throws refuses the subscription. When it returns a
   * promise, settling the promise closes the subscription, with the rejection as its error.
   */
  handle<InputSchema extends ZodType, EventSchema extends ZodType>(
    contract: PluginSubscriptionContract<InputSchema, EventSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginSubscriptionContext<PluginWireInput<ZodInput<EventSchema>>>,
    ) => void | Promise<void>,
  ): void;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => PluginWireInput<ZodInput<OutputSchema>> | Promise<PluginWireInput<ZodInput<OutputSchema>>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
  registerUsageSource(source: UsageSourceRegistration): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
