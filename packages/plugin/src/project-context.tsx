import type { PaseoApi } from "@getpaseo/client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { PluginProjectSnapshot } from "./contracts.js";

interface PluginProjectContextValue {
  projects: readonly PluginProjectSnapshot[];
  resolvePaseo(serverId: string): PaseoApi | null;
}

const PluginProjectContext = createContext<PluginProjectContextValue | null>(null);

export function PluginProjectProvider({
  children,
  projects,
  resolvePaseo,
}: PluginProjectContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ projects, resolvePaseo }), [projects, resolvePaseo]);
  return <PluginProjectContext.Provider value={value}>{children}</PluginProjectContext.Provider>;
}

function usePluginProjectContext(): PluginProjectContextValue {
  const context = useContext(PluginProjectContext);
  if (!context) {
    throw new Error("Project hooks must run inside a contributed plugin surface");
  }
  return context;
}

/** All known Paseo projects, grouped across every connected host. */
export function useProjects(): readonly PluginProjectSnapshot[] {
  return usePluginProjectContext().projects;
}

/** Borrow an online host's existing Paseo connection. */
export function usePaseoHost(serverId: string | null): PaseoApi | null {
  const context = usePluginProjectContext();
  return serverId ? context.resolvePaseo(serverId) : null;
}
