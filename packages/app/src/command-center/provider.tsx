import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import type { CommandCenterContribution } from "./contributions";
import { createCommandCenterRegistry, type CommandCenterRegistry } from "./registry";

const CommandCenterRegistryContext = createContext<CommandCenterRegistry | null>(null);

export function CommandCenterProvider({ children }: { children: ReactNode }) {
  const registryRef = useRef<CommandCenterRegistry | null>(null);
  if (!registryRef.current) registryRef.current = createCommandCenterRegistry();

  return (
    <CommandCenterRegistryContext.Provider value={registryRef.current}>
      {children}
    </CommandCenterRegistryContext.Provider>
  );
}

function useCommandCenterRegistry(): CommandCenterRegistry {
  const registry = useContext(CommandCenterRegistryContext);
  if (!registry) throw new Error("CommandCenterProvider is required");
  return registry;
}

export function useCommandCenterContributions() {
  const registry = useCommandCenterRegistry();
  return useSyncExternalStore(registry.subscribe, registry.getSnapshot, registry.getSnapshot);
}

export function useCommandCenterActions(input: {
  sourceId: string;
  enabled: boolean;
  actions: readonly CommandCenterContribution[];
}): void {
  const registry = useCommandCenterRegistry();
  const ownerRef = useRef({ sourceId: input.sourceId, token: Symbol(input.sourceId) });
  if (ownerRef.current.sourceId !== input.sourceId) {
    ownerRef.current = { sourceId: input.sourceId, token: Symbol(input.sourceId) };
  }
  const owner = ownerRef.current;

  useEffect(() => {
    if (!input.enabled) {
      registry.remove(owner);
      return;
    }
    registry.replace({ owner, contributions: input.actions });
    return () => registry.remove(owner);
  }, [input.actions, input.enabled, owner, registry]);
}
