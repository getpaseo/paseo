import type { ReactNode } from "react";
import type { SidebarCalloutAction, SidebarCalloutVariant } from "@/components/sidebar-callout";

export interface SidebarCalloutOptions {
  id: string;
  dismissalKey?: string;
  title: string;
  description?: ReactNode;
  icon?: ReactNode;
  variant?: SidebarCalloutVariant;
  actions?: readonly SidebarCalloutAction[];
  dismissible?: boolean;
  priority?: number;
  onDismiss?: () => void;
  testID?: string;
}

export interface SidebarCalloutEntry extends SidebarCalloutOptions {
  order: number;
  priority: number;
  token: number;
}

export interface SidebarCalloutState {
  callouts: readonly SidebarCalloutEntry[];
  dismissedKeys: ReadonlySet<string>;
  dismissalStorageLoaded: boolean;
  nextOrder: number;
  nextToken: number;
}

export function createSidebarCalloutState(): SidebarCalloutState {
  return {
    callouts: [],
    dismissedKeys: new Set(),
    dismissalStorageLoaded: false,
    nextOrder: 0,
    nextToken: 0,
  };
}

export function normalizeDismissalKey(key: string | null | undefined): string | null {
  const trimmed = key?.trim();
  return trimmed ? trimmed : null;
}

export function parseDismissedCalloutKeys(value: string | null): Set<string> {
  if (!value) {
    return new Set();
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"));
  } catch {
    return new Set();
  }
}

export function serializeDismissedCalloutKeys(keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys]);
}

export function loadDismissedCalloutKeys(
  state: SidebarCalloutState,
  dismissedKeys: ReadonlySet<string>,
): SidebarCalloutState {
  return {
    ...state,
    dismissedKeys: new Set(dismissedKeys),
    dismissalStorageLoaded: true,
  };
}

export function showSidebarCallout(
  state: SidebarCalloutState,
  callout: SidebarCalloutOptions,
): { state: SidebarCalloutState; token: number } {
  const token = state.nextToken + 1;
  const existing = state.callouts.find((entry) => entry.id === callout.id);
  const nextEntry: SidebarCalloutEntry = {
    ...callout,
    priority: callout.priority ?? 0,
    order: existing?.order ?? state.nextOrder + 1,
    token,
  };
  const callouts = existing
    ? state.callouts.map((entry) => (entry.id === callout.id ? nextEntry : entry))
    : [...state.callouts, nextEntry];

  return {
    state: {
      ...state,
      callouts,
      nextOrder: existing ? state.nextOrder : state.nextOrder + 1,
      nextToken: token,
    },
    token,
  };
}

export function unregisterSidebarCallout(
  state: SidebarCalloutState,
  input: { id: string; token: number },
): SidebarCalloutState {
  const callouts = state.callouts.filter(
    (entry) => entry.id !== input.id || entry.token !== input.token,
  );
  return callouts.length === state.callouts.length ? state : { ...state, callouts };
}

export function dismissSidebarCallout(
  state: SidebarCalloutState,
  id: string,
): {
  state: SidebarCalloutState;
  dismissedCallout: SidebarCalloutEntry | null;
  dismissalKey: string | null;
} {
  const dismissedCallout = state.callouts.find((entry) => entry.id === id) ?? null;
  const callouts = state.callouts.filter((entry) => entry.id !== id);
  const dismissalKey = normalizeDismissalKey(dismissedCallout?.dismissalKey);
  const dismissedKeys = dismissalKey
    ? new Set([...state.dismissedKeys, dismissalKey])
    : state.dismissedKeys;

  return {
    state: {
      ...state,
      callouts,
      dismissedKeys,
    },
    dismissedCallout,
    dismissalKey,
  };
}

export function clearSidebarCallouts(state: SidebarCalloutState): SidebarCalloutState {
  return { ...state, callouts: [] };
}

export function selectActiveSidebarCallout(
  state: Pick<SidebarCalloutState, "callouts" | "dismissedKeys" | "dismissalStorageLoaded">,
): SidebarCalloutEntry | null {
  const visibleCallouts = state.callouts.filter((entry) => {
    const dismissalKey = normalizeDismissalKey(entry.dismissalKey);
    if (!dismissalKey) {
      return true;
    }
    return state.dismissalStorageLoaded && !state.dismissedKeys.has(dismissalKey);
  });

  if (visibleCallouts.length === 0) {
    return null;
  }
  return (
    [...visibleCallouts].sort((a, b) => b.priority - a.priority || a.order - b.order)[0] ?? null
  );
}
