import type { PaseoPluginApi } from "@getpaseo/client";
import { createContext, useContext, type ReactNode } from "react";

const PaseoApiContext = createContext<PaseoPluginApi | null>(null);

export function usePaseoContextValue(): PaseoPluginApi | null {
  return useContext(PaseoApiContext);
}

export function PaseoApiProvider({
  children,
  paseo,
}: {
  children: ReactNode;
  paseo: PaseoPluginApi;
}) {
  return <PaseoApiContext.Provider value={paseo}>{children}</PaseoApiContext.Provider>;
}

export function usePaseo(): PaseoPluginApi {
  const paseo = usePaseoContextValue();
  if (!paseo) throw new Error("usePaseo must run inside a contributed plugin surface");
  return paseo;
}
