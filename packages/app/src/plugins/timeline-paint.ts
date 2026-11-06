import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { useSessionStore } from "@/stores/session-store";
import { hostSupportsFeature } from "@/runtime/host-features";

const STORAGE_KEY = "@paseo:plugin-timeline-expected";

/** A download still in flight may finish after this and replace the fallback rows. */
export const PLUGIN_TIMELINE_CATALOG_TIMEOUT_MS = 60_000;
const EXPECTATION_HYDRATION_TIMEOUT_MS = 2_000;

export type PluginTimelinePaint = "paint" | "wait";
type Expectation = boolean | "unknown";
type CatalogPhase = "pending" | "ready";

/**
 * Cached chats paint before a plugin bundle exists. Hold them when this host has
 * replaced timeline rows before, or when we have not learned that yet. A host that
 * already answered "no timeline plugins" keeps painting during later catalog loads.
 */
export function pluginTimelinePaint(input: {
  hydrated: boolean;
  expectation: Expectation;
  pluginsFeature: boolean | null;
  catalogReady: boolean;
}): PluginTimelinePaint {
  if (input.catalogReady) return "paint";
  if (!input.hydrated) return "wait";
  if (input.expectation === true) return "wait";
  if (input.expectation === "unknown" && input.pluginsFeature === true) return "wait";
  return "paint";
}

let hydrated = false;
let generation = 0;
let expectations = new Map<string, Expectation>();
let catalogs = new Map<string, CatalogPhase>();
let hydration: Promise<void> | null = null;
let persistQueue = Promise.resolve();
const listeners = new Set<() => void>();
const timeouts = new Map<string, ReturnType<typeof setTimeout>>();

function publish(): void {
  for (const listener of listeners) listener();
}

export function subscribePluginTimelinePaint(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function readPluginTimelinePaint(
  serverId: string,
  pluginsFeature: boolean | null,
): PluginTimelinePaint {
  return pluginTimelinePaint({
    hydrated,
    expectation: expectations.get(serverId) ?? "unknown",
    pluginsFeature,
    catalogReady: catalogs.get(serverId) === "ready",
  });
}

export function usePluginsFeature(serverId: string): boolean | null {
  return useSessionStore((state) => {
    const serverInfo = state.sessions[serverId]?.serverInfo;
    if (!serverInfo) return null;
    return hostSupportsFeature(serverInfo, "plugins");
  });
}

export function usePluginTimelinePaint(serverId: string): PluginTimelinePaint {
  const pluginsFeature = usePluginsFeature(serverId);
  const pluginsFeatureRef = useRef(pluginsFeature);
  const serverIdRef = useRef(serverId);
  pluginsFeatureRef.current = pluginsFeature;
  serverIdRef.current = serverId;

  useEffect(() => {
    beginPluginTimelineExpectationHydration();
  }, []);

  return useSyncExternalStore(
    subscribePluginTimelinePaint,
    () => readPluginTimelinePaint(serverIdRef.current, pluginsFeatureRef.current),
    () => readPluginTimelinePaint(serverIdRef.current, pluginsFeatureRef.current),
  );
}

export function beginPluginTimelineExpectationHydration(): void {
  if (hydration) return;
  const current = generation;
  const timeout = setTimeout(() => {
    if (current !== generation || hydrated) return;
    hydrated = true;
    publish();
  }, EXPECTATION_HYDRATION_TIMEOUT_MS);
  hydration = AsyncStorage.getItem(STORAGE_KEY)
    .then((raw) => {
      if (current !== generation) return undefined;
      mergeStoredExpectations(raw);
      hydrated = true;
      publish();
      for (const [serverId, expected] of expectations) {
        if (expected === true) armPluginCatalogFallback(serverId, false);
      }
      return undefined;
    })
    .catch(() => {
      if (current !== generation) return undefined;
      hydrated = true;
      publish();
      return undefined;
    })
    .finally(() => {
      clearTimeout(timeout);
    });
}

function mergeStoredExpectations(raw: string | null): void {
  if (!raw) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
  const next = new Map(expectations);
  for (const [serverId, value] of Object.entries(parsed)) {
    if (typeof value === "boolean" && !next.has(serverId)) next.set(serverId, value);
  }
  expectations = next;
}

export function rememberPluginTimelineExpectation(serverId: string, expected: boolean): void {
  if (expectations.get(serverId) === expected) return;
  expectations = new Map(expectations);
  expectations.set(serverId, expected);
  publish();
  const current = generation;
  const payload = JSON.stringify(Object.fromEntries(expectations));
  persistQueue = persistQueue
    .then(() => {
      if (current !== generation) return undefined;
      return AsyncStorage.setItem(STORAGE_KEY, payload);
    })
    .catch(() => undefined);
}

export function beginPluginCatalogLoad(
  serverId: string,
  input: { hasTransformers: boolean; forceWait: boolean },
): void {
  if (input.hasTransformers) {
    markPluginCatalogReady(serverId);
    return;
  }
  if (catalogs.get(serverId) === "ready" && !input.forceWait) return;
  markPluginCatalogPending(serverId);
}

export function markPluginCatalogReady(serverId: string): void {
  const timeout = timeouts.get(serverId);
  if (timeout) clearTimeout(timeout);
  timeouts.delete(serverId);
  if (catalogs.get(serverId) === "ready") return;
  catalogs = new Map(catalogs);
  catalogs.set(serverId, "ready");
  publish();
}

export function resetPluginCatalog(serverId: string): void {
  const timeout = timeouts.get(serverId);
  if (timeout) clearTimeout(timeout);
  timeouts.delete(serverId);
  if (!catalogs.has(serverId)) return;
  catalogs = new Map(catalogs);
  catalogs.delete(serverId);
  publish();
}

function markPluginCatalogPending(serverId: string): void {
  armPluginCatalogFallback(serverId, true);
  if (catalogs.get(serverId) === "pending") return;
  catalogs = new Map(catalogs);
  catalogs.set(serverId, "pending");
  publish();
}

function armPluginCatalogFallback(serverId: string, restart: boolean): void {
  if (catalogs.get(serverId) === "ready") return;
  if (timeouts.has(serverId) && !restart) return;
  const existing = timeouts.get(serverId);
  if (existing) clearTimeout(existing);
  const timeout = setTimeout(() => {
    timeouts.delete(serverId);
    markPluginCatalogReady(serverId);
  }, PLUGIN_TIMELINE_CATALOG_TIMEOUT_MS);
  timeouts.set(serverId, timeout);
}

export function resetPluginTimelinePaintState(): void {
  generation += 1;
  for (const timeout of timeouts.values()) clearTimeout(timeout);
  timeouts.clear();
  hydrated = false;
  expectations = new Map();
  catalogs = new Map();
  hydration = null;
  persistQueue = Promise.resolve();
  publish();
}
