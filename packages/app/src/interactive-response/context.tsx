import { createContext, useContext, type ReactNode } from "react";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
export interface InteractiveConversation {
  client: DaemonClient | null;
  serverId: string;
  agentId: string;
  supported: boolean;
  readOnly: boolean;
}
const Context = createContext<InteractiveConversation | null>(null);
export function InteractiveConversationProvider({
  value,
  children,
}: {
  value: InteractiveConversation;
  children: ReactNode;
}) {
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useInteractiveConversation() {
  return useContext(Context);
}
