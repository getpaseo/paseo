import { createContext, useContext, useEffect, useMemo, useRef, type ReactNode } from "react";

interface PluginEventContextValue {
  on(eventName: string, handler: (data: unknown) => void): () => void;
}

const PluginEventContext = createContext<PluginEventContextValue | null>(null);

export function PluginEventProvider({
  children,
  on,
}: {
  children: ReactNode;
  on(eventName: string, handler: (data: unknown) => void): () => void;
}) {
  // Memoized so useEvent's effect (keyed on this context object) doesn't tear down and
  // re-subscribe on every render, which would drop any event that arrives in between.
  const value = useMemo(() => ({ on }), [on]);
  return <PluginEventContext.Provider value={value}>{children}</PluginEventContext.Provider>;
}

/**
 * Subscribes to context.emit(eventName, data) calls from this plugin's server-target
 * contribute(). The handler ref updates every render without resubscribing, so callers
 * can pass an inline closure the same way they would to a plain useEffect.
 */
export function useEvent(eventName: string, handler: (data: unknown) => void): void {
  const context = useContext(PluginEventContext);
  if (!context) throw new Error("useEvent must run inside a contributed plugin surface");

  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    return context.on(eventName, (data) => handlerRef.current(data));
  }, [context, eventName]);
}
