import type { PaseoApi } from "@getpaseo/client";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";
import type { PluginCleanup } from "../contracts.js";
import type { ProviderRegistration } from "./provider.js";
import type { PluginLifecycleRegistration } from "./lifecycle.js";
import type { PluginSubagentEvent } from "./subagents.js";

export interface PluginSubagentReporter {
  report(event: PluginSubagentEvent): Promise<void>;
  close(): Promise<void>;
}

export interface PluginSubagentOpenInput {
  parentAgentId: string;
}

export interface PluginSubagentApi {
  open(input: PluginSubagentOpenInput): Promise<PluginSubagentReporter>;
}

export interface PluginHandlerContext {
  paseo: PaseoApi;
}

export interface PluginServerContext extends PluginLifecycleRegistration {
  subagents: PluginSubagentApi;
  registerSettings<Schema extends ZodType>(
    definition: import("../settings.js").SettingsDefinition<Schema>,
  ): void;
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
      context: PluginHandlerContext,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  registerProvider(provider: ProviderRegistration): void;
}

export type PluginServerContribution = (server: PluginServerContext) => PluginCleanup;
