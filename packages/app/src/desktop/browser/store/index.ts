import AsyncStorage from "@react-native-async-storage/async-storage";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  applyBrowserPatch,
  BrowserIndexStateSchema,
  type BrowserIndexState,
  type BrowserRecord,
  type BrowserRecordPatch,
  type BrowserViewport,
  createBrowserRecord,
  createRemoteBrowserRecord,
  normalizeBrowserIndexState,
  normalizeBrowserUrl,
  removeBrowserFromIndex,
  sanitizeBrowsersForPersist,
  trimNonEmpty,
} from "./state";

export {
  createFixedBrowserViewport,
  RESPONSIVE_BROWSER_VIEWPORT,
  type BrowserRecord,
  type BrowserViewport,
} from "./state";

interface BrowserStoreState extends BrowserIndexState {
  createBrowser: (input?: { initialUrl?: string; ownerAgentId?: string }) => string;
  upsertRemoteBrowser: (input: { browserId: string; url: string; title?: string }) => void;
  updateBrowser: (browserId: string, patch: BrowserRecordPatch) => void;
  setBrowserViewport: (browserId: string, viewport: BrowserViewport) => void;
  removeBrowser: (browserId: string) => void;
  setStartUrl: (url: string | null) => void;
}

// The remote tab sync reopens every daemon tab missing from the layout, so a tab the user
// closed must stay skipped while (and after) the daemon closes it.
const closedRemoteBrowserIds = new Set<string>();

export function markRemoteBrowserClosed(remoteBrowserId: string): void {
  closedRemoteBrowserIds.add(remoteBrowserId);
}

export function isRemoteBrowserClosed(remoteBrowserId: string): boolean {
  return closedRemoteBrowserIds.has(remoteBrowserId);
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
    (set, get) => ({
      browsersById: {},
      startUrl: null,
      createBrowser: (input) => {
        const browserId = createBrowserId();
        const record = createBrowserRecord({
          browserId,
          initialUrl: input?.initialUrl ?? get().startUrl,
          ownerAgentId: input?.ownerAgentId ?? null,
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
      upsertRemoteBrowser: (input) => {
        set((state) => {
          if (state.browsersById[input.browserId]) return state;
          const record = createRemoteBrowserRecord({
            browserId: input.browserId,
            initialUrl: input.url,
            ...(input.title !== undefined ? { title: input.title } : {}),
            now: Date.now(),
          });
          return { browsersById: { ...state.browsersById, [input.browserId]: record } };
        });
      },
      updateBrowser: (browserId, patch) => {
        set((state) => applyBrowserPatch(state, browserId, patch));
      },
      setBrowserViewport: (browserId, viewport) => {
        set((state) => applyBrowserPatch(state, browserId, { viewport }));
      },
      removeBrowser: (browserId) => {
        set((state) => removeBrowserFromIndex(state, browserId));
      },
      setStartUrl: (url) => {
        const trimmed = trimNonEmpty(url);
        set({ startUrl: trimmed ? normalizeBrowserUrl(trimmed) : null });
      },
    }),
    {
      name: "workspace-browser-store",
      storage: createValidatedPersistStorage(AsyncStorage, BrowserIndexStateSchema),
      partialize: (state) => sanitizeBrowsersForPersist(state),
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...normalizeBrowserIndexState(persistedState),
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

export function createWorkspaceBrowser(input?: { initialUrl?: string; ownerAgentId?: string }): {
  browserId: string;
  url: string;
} {
  const browserId = useBrowserStore.getState().createBrowser(input);
  const record = getBrowserRecord(browserId);
  return {
    browserId,
    url:
      record?.url ?? normalizeBrowserUrl(input?.initialUrl ?? useBrowserStore.getState().startUrl),
  };
}

export function normalizeWorkspaceBrowserUrl(value: string | null | undefined): string {
  return normalizeBrowserUrl(value);
}
