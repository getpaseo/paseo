import { useCallback, type ReactNode } from "react";
import { PluginClientStateProvider, usePluginClientStateSource } from "./client-state.js";
import { PaseoApiProvider, usePaseoContextValue } from "./paseo-context.js";
import { PluginRpcProvider, usePluginRpcContextValue } from "./rpc-context.js";

export type PluginRuntimeContextBridge = (children: ReactNode) => ReactNode;

/** Rebuilds plugin runtime contexts inside React Native portal hosts. */
export function usePluginRuntimeContextBridge(): PluginRuntimeContextBridge {
  const paseo = usePaseoContextValue();
  const rpc = usePluginRpcContextValue();
  const state = usePluginClientStateSource();

  if (!paseo || !rpc) {
    throw new Error("Plugin UI must run inside a contributed plugin surface");
  }

  return useCallback(
    (children: ReactNode) => {
      const content = state ? (
        <PluginClientStateProvider source={state}>{children}</PluginClientStateProvider>
      ) : (
        children
      );
      return (
        <PaseoApiProvider paseo={paseo}>
          <PluginRpcProvider invoke={rpc.invoke}>{content}</PluginRpcProvider>
        </PaseoApiProvider>
      );
    },
    [paseo, rpc, state],
  );
}
