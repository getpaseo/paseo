import { create } from "zustand";

interface PluginSuggestionEntry {
  serverId: string;
  pluginId: string;
  text: string;
  order: number;
}

export interface ComposerSuggestionRecord {
  byPlugin: Record<string, PluginSuggestionEntry>;
  dismissedNative: string | null;
}

interface ComposerSuggestionState {
  records: Record<string, ComposerSuggestionRecord>;
  setPluginSuggestion: (input: {
    composerKey: string;
    serverId: string;
    pluginId: string;
    text: string | null;
  }) => void;
  clearPluginSuggestions: (serverId: string, pluginId: string) => void;
  acceptSuggestion: (composerKey: string, nativeSuggestion: string | null) => void;
  clearComposerSuggestions: (composerKey: string, nativeSuggestion?: string | null) => void;
  reconcileNativeSuggestion: (composerKey: string, nativeSuggestion: string | null) => void;
}

let nextSuggestionOrder = 0;

function normalizeSuggestionText(text: string | null | undefined): string | null {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function pluginEntryKey(serverId: string, pluginId: string): string {
  return `${serverId}/${pluginId}`;
}

export function composerSuggestionKey(serverId: string, agentId: string): string {
  return `${serverId}:${agentId}`;
}

export function resolveComposerSuggestion(
  record: ComposerSuggestionRecord | undefined,
  nativeSuggestion: string | null | undefined,
): string | null {
  if (record) {
    let latest: PluginSuggestionEntry | null = null;
    for (const entry of Object.values(record.byPlugin)) {
      if (!latest || entry.order > latest.order) {
        latest = entry;
      }
    }
    if (latest) return latest.text;
  }
  const normalizedNative = normalizeSuggestionText(nativeSuggestion);
  if (!normalizedNative) return null;
  if (record?.dismissedNative === normalizedNative) return null;
  return normalizedNative;
}

function pruneRecord(
  records: Record<string, ComposerSuggestionRecord>,
  composerKey: string,
  nextRecord: ComposerSuggestionRecord,
): Record<string, ComposerSuggestionRecord> {
  const hasPluginEntries = Object.keys(nextRecord.byPlugin).length > 0;
  if (!hasPluginEntries && nextRecord.dismissedNative === null) {
    if (!(composerKey in records)) return records;
    const { [composerKey]: _removed, ...rest } = records;
    return rest;
  }
  return { ...records, [composerKey]: nextRecord };
}

export const useComposerSuggestionStore = create<ComposerSuggestionState>((set) => ({
  records: {},

  setPluginSuggestion({ composerKey, serverId, pluginId, text }) {
    const normalized = normalizeSuggestionText(text);
    const entryKey = pluginEntryKey(serverId, pluginId);
    set((state) => {
      const current = state.records[composerKey];
      const existing = current?.byPlugin[entryKey];
      if (normalized === null) {
        if (!existing) return state;
        const { [entryKey]: _removed, ...remaining } = current.byPlugin;
        return {
          records: pruneRecord(state.records, composerKey, {
            byPlugin: remaining,
            dismissedNative: current.dismissedNative,
          }),
        };
      }
      if (existing && existing.text === normalized) {
        return state;
      }
      const nextEntry: PluginSuggestionEntry = {
        serverId,
        pluginId,
        text: normalized,
        order: ++nextSuggestionOrder,
      };
      return {
        records: {
          ...state.records,
          [composerKey]: {
            byPlugin: { ...current?.byPlugin, [entryKey]: nextEntry },
            dismissedNative: current?.dismissedNative ?? null,
          },
        },
      };
    });
  },

  clearPluginSuggestions(serverId, pluginId) {
    const entryKey = pluginEntryKey(serverId, pluginId);
    set((state) => {
      let changed = false;
      const nextRecords: Record<string, ComposerSuggestionRecord> = {};
      for (const [composerKey, record] of Object.entries(state.records)) {
        if (!(entryKey in record.byPlugin)) {
          nextRecords[composerKey] = record;
          continue;
        }
        changed = true;
        const { [entryKey]: _removed, ...remaining } = record.byPlugin;
        if (Object.keys(remaining).length > 0 || record.dismissedNative !== null) {
          nextRecords[composerKey] = {
            byPlugin: remaining,
            dismissedNative: record.dismissedNative,
          };
        }
      }
      return changed ? { records: nextRecords } : state;
    });
  },

  acceptSuggestion(composerKey, nativeSuggestion) {
    const normalizedNative = normalizeSuggestionText(nativeSuggestion);
    set((state) => {
      const current = state.records[composerKey];
      const hadPluginEntries = current ? Object.keys(current.byPlugin).length > 0 : false;
      const nextDismissed = normalizedNative ?? current?.dismissedNative ?? null;
      if (!hadPluginEntries && (current?.dismissedNative ?? null) === nextDismissed) {
        return state;
      }
      return {
        records: pruneRecord(state.records, composerKey, {
          byPlugin: {},
          dismissedNative: nextDismissed,
        }),
      };
    });
  },

  clearComposerSuggestions(composerKey, nativeSuggestion) {
    const normalizedNative = normalizeSuggestionText(nativeSuggestion);
    set((state) => {
      const current = state.records[composerKey];
      const hadPluginEntries = current ? Object.keys(current.byPlugin).length > 0 : false;
      const nextDismissed = normalizedNative;
      if (!hadPluginEntries && (current?.dismissedNative ?? null) === nextDismissed) {
        return state;
      }
      return {
        records: pruneRecord(state.records, composerKey, {
          byPlugin: {},
          dismissedNative: nextDismissed,
        }),
      };
    });
  },

  reconcileNativeSuggestion(composerKey, nativeSuggestion) {
    const normalizedNative = normalizeSuggestionText(nativeSuggestion);
    set((state) => {
      const current = state.records[composerKey];
      if (!current || current.dismissedNative === null) return state;
      if (normalizedNative === current.dismissedNative) return state;
      return {
        records: pruneRecord(state.records, composerKey, {
          byPlugin: current.byPlugin,
          dismissedNative: null,
        }),
      };
    });
  },
}));
