import { createContext, type ReactNode, useContext } from "react";

const HostRouteServerIdContext = createContext<string | null>(null);

export function HostRouteProvider({
  children,
  serverId,
}: {
  children: ReactNode;
  serverId: string;
}) {
  return (
    <HostRouteServerIdContext.Provider value={serverId}>
      {children}
    </HostRouteServerIdContext.Provider>
  );
}

export function useHostRouteServerId(): string | null {
  return useContext(HostRouteServerIdContext);
}
