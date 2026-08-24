import type { PaseoApi } from "@getpaseo/client";
import { createContext, useContext, type ReactNode } from "react";

const PaseoApiContext = createContext<PaseoApi | null>(null);

export function PaseoApiProvider({ children, paseo }: { children: ReactNode; paseo: PaseoApi }) {
  return <PaseoApiContext.Provider value={paseo}>{children}</PaseoApiContext.Provider>;
}

export function usePaseo(): PaseoApi {
  const paseo = useContext(PaseoApiContext);
  if (!paseo) throw new Error("usePaseo must run inside a contributed plugin surface");
  return paseo;
}
