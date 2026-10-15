import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

interface ExplorerTerminalState {
  byWorkspace: Record<
    string,
    { shellId?: string; scriptId?: string; selected: "shell" | "script"; height: number }
  >;
  pendingByWorkspace: Record<string, number>;
  setPending: (workspaceKey: string, pending: boolean) => void;
  update: (
    workspaceKey: string,
    patch: Partial<ExplorerTerminalState["byWorkspace"][string]>,
  ) => void;
}

const schema = z.strictObject({
  byWorkspace: z.record(
    z.string(),
    z.strictObject({
      shellId: z.string().optional(),
      scriptId: z.string().optional(),
      selected: z.enum(["shell", "script"]),
      height: z.number().min(0.15).max(0.85),
    }),
  ),
});

export function excludeExplorerTerminals(
  ids: string[],
  saved?: ExplorerTerminalState["byWorkspace"][string],
): string[] {
  return ids.filter((id) => id !== saved?.shellId && id !== saved?.scriptId);
}

export function createExplorerTerminalStore(storage: StateStorage) {
  return create<ExplorerTerminalState>()(
    persist<ExplorerTerminalState, [], [], z.infer<typeof schema>>(
      (set) => ({
        byWorkspace: {},
        pendingByWorkspace: {},
        setPending: (workspaceKey, pending) =>
          set((state) => ({
            pendingByWorkspace: {
              ...state.pendingByWorkspace,
              [workspaceKey]: Math.max(
                0,
                (state.pendingByWorkspace[workspaceKey] ?? 0) + (pending ? 1 : -1),
              ),
            },
          })),
        update: (workspaceKey, patch) =>
          set((state) => ({
            byWorkspace: {
              ...state.byWorkspace,
              [workspaceKey]: {
                ...({ selected: "shell", height: 0.35 } as const),
                ...state.byWorkspace[workspaceKey],
                ...patch,
              },
            },
          })),
      }),
      {
        name: "explorer-terminal",
        storage: createValidatedPersistStorage(storage, schema),
        partialize: (state) => ({ byWorkspace: state.byWorkspace }),
        merge: (persisted, current) => {
          const parsed = schema.safeParse(persisted);
          return { ...current, byWorkspace: parsed.success ? parsed.data.byWorkspace : {} };
        },
      },
    ),
  );
}

export const useExplorerTerminalStore = createExplorerTerminalStore(AsyncStorage);
