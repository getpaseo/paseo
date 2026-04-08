import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

export interface BrowserRecord {
  browserId: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  faviconUrl: string | null;
  lastError: string | null;
  createdAt: number;
}

type BrowserRecordPatch = Partial<Omit<BrowserRecord, "browserId" | "createdAt">>;

interface BrowserStoreState {
  browsersById: Record<string, BrowserRecord>;
  createBrowser: (input?: { initialUrl?: string }) => string;
  updateBrowser: (browserId: string, patch: BrowserRecordPatch) => void;
  removeBrowser: (browserId: string) => void;
}

function trimNonEmpty(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeBrowserUrl(value: string | null | undefined): string {
  const trimmed = trimNonEmpty(value);
  if (!trimmed) {
    return "https://example.com";
  }
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) {
    return trimmed;
  }
  if (trimmed.startsWith("//")) {
    return `https:${trimmed}`;
  }
  return `https://${trimmed}`;
}

function createBrowserId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export const useBrowserStore = create<BrowserStoreState>()(
  persist(
    (set) => ({
      browsersById: {},
      createBrowser: (input) => {
        const browserId = createBrowserId();
        const now = Date.now();
        const initialUrl = normalizeBrowserUrl(input?.initialUrl);

        set((state) => ({
          browsersById: {
            ...state.browsersById,
            [browserId]: {
              browserId,
              url: initialUrl,
              title: "",
              isLoading: false,
              canGoBack: false,
              canGoForward: false,
              faviconUrl: null,
              lastError: null,
              createdAt: now,
            },
          },
        }));

        return browserId;
      },
      updateBrowser: (browserId, patch) => {
        const normalizedBrowserId = trimNonEmpty(browserId);
        if (!normalizedBrowserId) {
          return;
        }

        set((state) => {
          const existing = state.browsersById[normalizedBrowserId];
          if (!existing) {
            return state;
          }

          const nextRecord: BrowserRecord = {
            ...existing,
            ...patch,
            url: normalizeBrowserUrl(patch.url ?? existing.url),
          };

          if (
            nextRecord.url === existing.url &&
            nextRecord.title === existing.title &&
            nextRecord.isLoading === existing.isLoading &&
            nextRecord.canGoBack === existing.canGoBack &&
            nextRecord.canGoForward === existing.canGoForward &&
            nextRecord.faviconUrl === existing.faviconUrl &&
            nextRecord.lastError === existing.lastError
          ) {
            return state;
          }

          return {
            browsersById: {
              ...state.browsersById,
              [normalizedBrowserId]: nextRecord,
            },
          };
        });
      },
      removeBrowser: (browserId) => {
        const normalizedBrowserId = trimNonEmpty(browserId);
        if (!normalizedBrowserId) {
          return;
        }

        set((state) => {
          if (!state.browsersById[normalizedBrowserId]) {
            return state;
          }
          const next = { ...state.browsersById };
          delete next[normalizedBrowserId];
          return { browsersById: next };
        });
      },
    }),
    {
      name: "workspace-browser-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        browsersById: state.browsersById,
      }),
    },
  ),
);

export function getBrowserRecord(browserId: string): BrowserRecord | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  return useBrowserStore.getState().browsersById[normalizedBrowserId] ?? null;
}

export function createWorkspaceBrowser(input?: { initialUrl?: string }): {
  browserId: string;
  url: string;
} {
  const browserId = useBrowserStore.getState().createBrowser(input);
  const record = getBrowserRecord(browserId);
  return {
    browserId,
    url: record?.url ?? normalizeBrowserUrl(input?.initialUrl),
  };
}

export function normalizeWorkspaceBrowserUrl(value: string | null | undefined): string {
  return normalizeBrowserUrl(value);
}
