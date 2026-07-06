import AsyncStorage from "@react-native-async-storage/async-storage";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  applyBrowserPatch,
  type BrowserIndexState,
  type BrowserRecord,
  type BrowserRecordPatch,
  createBrowserRecord,
  normalizeBrowserUrl,
  removeBrowserFromIndex,
  sanitizeBrowsersForPersist,
  trimNonEmpty,
} from "./state";

export type { BrowserRecord } from "./state";

interface BrowserStoreState extends BrowserIndexState {
  createBrowser: (input?: { initialUrl?: string }) => string;
  updateBrowser: (browserId: string, patch: BrowserRecordPatch) => void;
  removeBrowser: (browserId: string) => void;
}

function createBrowserId(): string {
  let browserId: string;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    browserId = globalThis.crypto.randomUUID();
  } else {
    const randomSuffix = Math.random().toString(16).slice(2) || "0";
    browserId = `${Date.now()}-${randomSuffix}`;
  }
  return BrowserAutomationBrowserIdSchema.parse(browserId);
}

export const useBrowserStore = create<BrowserStoreState>()(
  persist(
    (set) => ({
      browsersById: {},
      createBrowser: (input) => {
        const browserId = createBrowserId();
        const record = createBrowserRecord({
          browserId,
          initialUrl: input?.initialUrl,
          now: Date.now(),
        });

        set((state) => ({
          browsersById: {
            ...state.browsersById,
            [browserId]: record,
          },
        }));

        return browserId;
      },
      updateBrowser: (browserId, patch) => {
        set((state) => applyBrowserPatch(state, browserId, patch));
      },
      removeBrowser: (browserId) => {
        set((state) => removeBrowserFromIndex(state, browserId));
      },
    }),
    {
      name: "workspace-browser-store",
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => sanitizeBrowsersForPersist(state),
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
