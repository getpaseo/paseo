import { useSyncExternalStore } from "react";

/**
 * Selected organization scope. Drives which shares, members, projects, and
 * workspaces are visible across the app. Initial value is read from
 * localStorage (web) / AsyncStorage-like sessionStorage so the choice
 * survives reloads within the same browser context.
 *
 * When no selection has been made yet (first run) the consumer should fall
 * back to `organizations[0]` and call `setActiveOrgId` on user action.
 */

const STORAGE_KEY = "hubcode_active_org_id";

function readInitial(): string | null {
  try {
    if (typeof localStorage !== "undefined") {
      return localStorage.getItem(STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
  return null;
}

let activeOrgId: string | null = readInitial();
const listeners = new Set<() => void>();

function persist(value: string | null) {
  try {
    if (typeof localStorage !== "undefined") {
      if (value) localStorage.setItem(STORAGE_KEY, value);
      else localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function setActiveOrgId(orgId: string | null): void {
  if (activeOrgId === orgId) return;
  activeOrgId = orgId;
  persist(orgId);
  for (const listener of listeners) listener();
}

export function getActiveOrgIdSnapshot(): string | null {
  return activeOrgId;
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

export function useActiveOrgId(): string | null {
  return useSyncExternalStore(subscribe, getActiveOrgIdSnapshot, getActiveOrgIdSnapshot);
}
