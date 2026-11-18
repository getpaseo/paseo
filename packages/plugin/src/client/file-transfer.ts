import { usePluginRpcContextValue } from "./rpc-context.js";
import type { ZodType, output as ZodOutput } from "zod";
import type { PluginRpcContract } from "../rpc.js";

export const PLUGIN_FILE_MAX_BYTES = 1024 * 1024;
export const PLUGIN_FILE_HEADER_MAX_BYTES = 4096;

declare const pickedFileBrand: unique symbol;

/** Metadata for a file chosen through Paseo. Only the originating installation can send it. */
export type PluginPickedFile = Readonly<{
  name: string;
  size: number;
  [pickedFileBrand]: true;
}>;

export interface PluginFileTransfer {
  pick(): Promise<PluginPickedFile | null>;
  send<Input extends ZodType<Uint8Array>, Output extends ZodType>(
    file: PluginPickedFile,
    rpc: PluginRpcContract<Input, Output>,
    header?: Uint8Array,
  ): Promise<ZodOutput<Output>>;
}

/** Returns null on clients that lack the file transfer capability. */
export function usePluginFileTransfer(): PluginFileTransfer | null {
  return usePluginRpcContextValue()?.fileTransfer ?? null;
}
