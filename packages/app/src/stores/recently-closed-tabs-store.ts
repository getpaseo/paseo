import AsyncStorage from "@react-native-async-storage/async-storage";
import { z } from "zod";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { useBrowserStore } from "@/desktop/browser/store";
import type { WorkspaceTabTarget } from "@/workspace-tabs/model";

const MAX_CLOSED_PER_WORKSPACE = 8;

export type ReopenableTabTarget = Extract<
  WorkspaceTabTarget,
  { kind: "agent" } | { kind: "terminal" } | { kind: "browser" }
>;

export interface ClosedTabEntry {
  id: string;
  target: ReopenableTabTarget;
  /** A browser tab's page; the tab itself is gone once closed, so it reopens here. */
  url?: string;
  title?: string;
  closedAt: number;
}

interface RecentlyClosedTabsState {
  byWorkspace: Record<string, ClosedTabEntry[]>;
  record: (workspaceKey: string, target: WorkspaceTabTarget) => void;
  forget: (workspaceKey: string, entryId: string) => void;
}

function isReopenable(target: WorkspaceTabTarget): target is ReopenableTabTarget {
  return target.kind === "agent" || target.kind === "terminal" || target.kind === "browser";
}

// Closing a browser tab drops its record before the layout closes the tab, so the last
// page each tab showed is kept here.
const lastPageByBrowserId = new Map<string, { url: string; title: string }>();
useBrowserStore.subscribe((state) => {
  for (const [browserId, browser] of Object.entries(state.browsersById)) {
    if (browser?.url)
      lastPageByBrowserId.set(browserId, { url: browser.url, title: browser.title });
  }
});

function entryFor(target: ReopenableTabTarget): ClosedTabEntry {
  const closedAt = Date.now();
  if (target.kind !== "browser") {
    return { id: `${target.kind}:${closedAt}`, target, closedAt };
  }
  const browser =
    useBrowserStore.getState().browsersById[target.browserId] ??
    lastPageByBrowserId.get(target.browserId);
  return {
    id: `browser:${closedAt}`,
    target,
    closedAt,
    ...(browser?.url ? { url: browser.url } : {}),
    ...(browser?.title ? { title: browser.title } : {}),
  };
}

const ClosedTabEntrySchema = z.object({
  id: z.string(),
  target: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), agentId: z.string() }),
    z.object({ kind: z.literal("terminal"), terminalId: z.string() }),
    z.object({ kind: z.literal("browser"), browserId: z.string() }),
  ]),
  url: z.string().optional(),
  title: z.string().optional(),
  closedAt: z.number(),
});
const PersistedStateSchema = z.object({
  byWorkspace: z.record(z.string(), z.array(ClosedTabEntrySchema)),
});

/** What was closed in each workspace, newest first, so the new-tab page can bring it back. */
export const useRecentlyClosedTabsStore = create<RecentlyClosedTabsState>()(
  persist(
    (set) => ({
      byWorkspace: {},
      record: (workspaceKey, target) => {
        if (!isReopenable(target)) return;
        set((state) => {
          const sameTab = (entry: ClosedTabEntry) =>
            JSON.stringify(entry.target) === JSON.stringify(target);
          const previous = (state.byWorkspace[workspaceKey] ?? []).filter(
            (entry) => !sameTab(entry),
          );
          return {
            byWorkspace: {
              ...state.byWorkspace,
              [workspaceKey]: [entryFor(target), ...previous].slice(0, MAX_CLOSED_PER_WORKSPACE),
            },
          };
        });
      },
      forget: (workspaceKey, entryId) =>
        set((state) => ({
          byWorkspace: {
            ...state.byWorkspace,
            [workspaceKey]: (state.byWorkspace[workspaceKey] ?? []).filter(
              (entry) => entry.id !== entryId,
            ),
          },
        })),
    }),
    {
      name: "workspace-recently-closed-tabs",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedStateSchema),
      partialize: (state) => ({ byWorkspace: state.byWorkspace }),
    },
  ),
);
