import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  type ComponentType,
  type ReactNode,
} from "react";
import type { ZodType, output as ZodOutput, input as ZodInput } from "zod";
import type {
  PluginSidebarContribution,
  PluginSurfaceContribution,
  PluginSurfaceProps,
} from "./types";

interface PluginCollector {
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
  addSidebarItem(contribution: PluginSidebarContribution): void;
}

interface PluginRpcContextValue {
  invoke(method: string, input: unknown): Promise<unknown>;
}

export interface PluginRpcContract<
  InputSchema extends ZodType = ZodType,
  OutputSchema extends ZodType = ZodType,
> {
  name: string;
  input: InputSchema;
  output: OutputSchema;
}

export interface PluginContext {
  handle<InputSchema extends ZodType, OutputSchema extends ZodType>(
    contract: PluginRpcContract<InputSchema, OutputSchema>,
    handler: (
      input: ZodOutput<InputSchema>,
    ) => ZodInput<OutputSchema> | Promise<ZodInput<OutputSchema>>,
  ): void;
  addSurface(id: string, Component: ComponentType<PluginSurfaceProps>): void;
  addSidebarItem(contribution: PluginSidebarContribution): void;
}

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

const PluginRpcContext = createContext<PluginRpcContextValue | null>(null);

export function PluginRpcProvider({
  children,
  invoke,
}: {
  children: ReactNode;
  invoke(method: string, input: unknown): Promise<unknown>;
}) {
  const value = useMemo(() => ({ invoke }), [invoke]);
  return <PluginRpcContext.Provider value={value}>{children}</PluginRpcContext.Provider>;
}

export function createPluginContext(collector: PluginCollector) {
  return {
    addSurface(id: string, Component: ComponentType<PluginSurfaceProps>) {
      collector.addSurface(id, Component);
    },
    addSidebarItem(contribution: PluginSidebarContribution) {
      collector.addSidebarItem(contribution);
    },
  };
}

export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
  contract: PluginRpcContract<InputSchema, OutputSchema>,
): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>> {
  const context = useContext(PluginRpcContext);
  if (!context) throw new Error("useRpc must run inside a contributed plugin surface");

  return useCallback(
    (input: ZodInput<InputSchema>) => callPluginRpc(contract, context.invoke, input),
    [context, contract],
  );
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

export interface PluginRegistrationCollector {
  surfaces: PluginSurfaceContribution[];
  sidebarItems: PluginSidebarContribution[];
}
