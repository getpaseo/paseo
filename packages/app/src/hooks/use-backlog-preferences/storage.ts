import type { QueryClient } from "@tanstack/react-query";
import { z } from "zod";

export const BACKLOG_PREFERENCES_STORAGE_KEY = "@paseo:backlog-preferences";
export const BACKLOG_PREFERENCES_QUERY_KEY = ["backlog-preferences"] as const;

const backlogViewModeSchema = z.enum(["grid", "list"]);

const backlogPreferencesSchema = z.object({
  viewMode: backlogViewModeSchema.nullable().optional(),
});

export type BacklogViewModePreference = "grid" | "list";

export interface BacklogPreferences {
  /**
   * Explicit user choice. `null` means unset so the UI can default by form factor.
   */
  viewMode: BacklogViewModePreference | null;
}

export const DEFAULT_BACKLOG_PREFERENCES: BacklogPreferences = {
  viewMode: null,
};

export interface KeyValueStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

function normalizeBacklogPreferences(value: unknown): BacklogPreferences {
  if (typeof value !== "object" || value === null) {
    return DEFAULT_BACKLOG_PREFERENCES;
  }
  const parsed = backlogPreferencesSchema.safeParse(value);
  if (!parsed.success) {
    return DEFAULT_BACKLOG_PREFERENCES;
  }
  return {
    viewMode: parsed.data.viewMode ?? null,
  };
}

export async function loadBacklogPreferencesFromStorage(
  storage: KeyValueStorage,
): Promise<BacklogPreferences> {
  try {
    const stored = await storage.getItem(BACKLOG_PREFERENCES_STORAGE_KEY);
    if (!stored) {
      return DEFAULT_BACKLOG_PREFERENCES;
    }
    return normalizeBacklogPreferences(JSON.parse(stored));
  } catch {
    return DEFAULT_BACKLOG_PREFERENCES;
  }
}

export async function saveBacklogPreferences(input: {
  queryClient: QueryClient;
  updates: Partial<BacklogPreferences>;
  storage: KeyValueStorage;
}): Promise<BacklogPreferences> {
  const prev =
    input.queryClient.getQueryData<BacklogPreferences>(BACKLOG_PREFERENCES_QUERY_KEY) ??
    DEFAULT_BACKLOG_PREFERENCES;
  const next: BacklogPreferences = {
    viewMode: input.updates.viewMode !== undefined ? input.updates.viewMode : prev.viewMode,
  };
  input.queryClient.setQueryData<BacklogPreferences>(BACKLOG_PREFERENCES_QUERY_KEY, next);
  await input.storage.setItem(BACKLOG_PREFERENCES_STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function resolveBacklogViewMode(input: {
  preference: BacklogViewModePreference | null | undefined;
  isCompact: boolean;
}): BacklogViewModePreference {
  if (input.preference === "grid" || input.preference === "list") {
    return input.preference;
  }
  return input.isCompact ? "list" : "grid";
}
