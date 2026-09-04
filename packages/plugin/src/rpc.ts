import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";

export interface PluginRpcContract<
  InputSchema extends ZodType = ZodType,
  OutputSchema extends ZodType = ZodType,
> {
  name: string;
  input: InputSchema;
  output: OutputSchema;
}

export type RpcInput<Contract extends PluginRpcContract> = ZodOutput<Contract["input"]>;
export type RpcOutput<Contract extends PluginRpcContract> = ZodInput<Contract["output"]>;

interface RpcDefinition<InputSchema extends ZodType, OutputSchema extends ZodType> {
  name: string;
  input: InputSchema;
  output: OutputSchema;
}

const RPC_NAME = /^[a-z][a-z0-9._-]*$/;

export function defineRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
  definition: RpcDefinition<InputSchema, OutputSchema>,
): PluginRpcContract<InputSchema, OutputSchema> {
  const name = definition.name.trim();
  if (!RPC_NAME.test(name)) throw new Error(`Invalid plugin RPC method: ${definition.name}`);
  return { ...definition, name };
}

export async function callPluginRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
  contract: PluginRpcContract<InputSchema, OutputSchema>,
  invoke: (method: string, input: unknown) => Promise<unknown>,
  input: ZodInput<InputSchema>,
): Promise<ZodOutput<OutputSchema>> {
  const parsedInput = await contract.input.parseAsync(input);
  const output = await invoke(contract.name, parsedInput);
  return contract.output.parseAsync(output);
}
