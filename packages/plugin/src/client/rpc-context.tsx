import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import type { ZodType, input as ZodInput, output as ZodOutput } from "zod";
import { callPluginRpc, type PluginRpcContract } from "../rpc.js";

export interface PluginRpcContextValue {
  invoke(method: string, input: unknown): Promise<unknown>;
}

const PluginRpcContext = createContext<PluginRpcContextValue | null>(null);

export function usePluginRpcContextValue(): PluginRpcContextValue | null {
  return useContext(PluginRpcContext);
}

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

export function useRpc<InputSchema extends ZodType, OutputSchema extends ZodType>(
  contract: PluginRpcContract<InputSchema, OutputSchema>,
): (input: ZodInput<InputSchema>) => Promise<ZodOutput<OutputSchema>> {
  const context = usePluginRpcContextValue();
  if (!context) throw new Error("useRpc must run inside a contributed plugin surface");

  return useCallback(
    (input: ZodInput<InputSchema>) => callPluginRpc(contract, context.invoke, input),
    [context, contract],
  );
}
