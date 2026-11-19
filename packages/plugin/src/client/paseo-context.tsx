import type { PluginPaseoApi } from "./reference-api.js";
import { createContext, useContext, type ReactNode } from "react";

const PaseoApiContext = createContext<PluginPaseoApi | null>(null);

export function usePaseoContextValue(): PluginPaseoApi | null {
  return useContext(PaseoApiContext);
}

export function PaseoApiProvider({
  children,
  paseo,
}: {
  children: ReactNode;
  paseo: PluginPaseoApi;
}) {
  return <PaseoApiContext.Provider value={paseo}>{children}</PaseoApiContext.Provider>;
}

export function usePaseo(): PluginPaseoApi {
  const paseo = usePaseoContextValue();
  if (!paseo) throw new Error("usePaseo must run inside a contributed plugin surface");
  return paseo;
}
