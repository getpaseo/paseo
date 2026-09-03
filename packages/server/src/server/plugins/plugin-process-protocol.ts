import type {
  PluginForgeSerializedError,
  PluginForgeServerProviderDescriptor,
  PluginForgeServiceMethod,
} from "@getpaseo/plugin/server";

export type PluginProcessRequest =
  | { type: "initialize"; pluginId: string; bundle: string; appVersion: string }
  | { type: "invoke"; requestId: string; method: string; input: unknown }
  | {
      type: "invoke_forge";
      requestId: string;
      providerId: string;
      method: PluginForgeServiceMethod | "probeHost";
      input: unknown;
    }
  | { type: "shutdown" }
  | { type: "paseo_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "paseo_close" };

export type PluginProcessMessage =
  | { type: "ready"; methods: string[]; forgeProviders: PluginForgeServerProviderDescriptor[] }
  | { type: "result"; requestId: string; output: unknown }
  | { type: "error"; requestId: string; error: string }
  | { type: "forge_result"; requestId: string; output: unknown }
  | { type: "forge_error"; requestId: string; error: PluginForgeSerializedError }
  | { type: "fatal"; error: string }
  | { type: "paseo_frame"; data: string | Uint8Array; isBinary: boolean }
  | { type: "paseo_close" };
