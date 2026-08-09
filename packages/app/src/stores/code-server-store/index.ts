import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import {
  type CodeServerIndexState,
  type CodeServerRecord,
  createCodeServerRecord,
  getNextCodeServerTitle,
  removeCodeServerFromIndex,
  renameCodeServerInIndex,
  trimNonEmpty,
} from "./state";
import { createWorkspaceBrowser } from "@/desktop/browser/store";

export type { CodeServerRecord } from "./state";

interface CodeServerStoreState extends CodeServerIndexState {
  createCodeServer: (input: {
    initialUrl: string;
    browserId: string;
    workspaceKey?: string | null;
  }) => string;
  renameCodeServer: (codeServerId: string, title: string) => void;
  removeCodeServer: (codeServerId: string) => void;
}

function createCodeServerId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  const randomSuffix = Math.random().toString(16).slice(2) || "0";
  return `${Date.now()}-${randomSuffix}`;
}

export const useCodeServerStore = create<CodeServerStoreState>()(
  persist(
    (set, get) => ({
      codeServersById: {},
      createCodeServer: (input) => {
        const codeServerId = createCodeServerId();
        const record = createCodeServerRecord({
          codeServerId,
          browserId: input.browserId,
          workspaceKey: input.workspaceKey,
          initialUrl: input.initialUrl,
          title: getNextCodeServerTitle(get().codeServersById, input.workspaceKey),
          now: Date.now(),
        });

        set((state) => ({
          codeServersById: {
            ...state.codeServersById,
            [codeServerId]: record,
          },
        }));

        return codeServerId;
      },
      renameCodeServer: (codeServerId, title) => {
        set((state) => renameCodeServerInIndex(state, codeServerId, title));
      },
      removeCodeServer: (codeServerId) => {
        set((state) => removeCodeServerFromIndex(state, codeServerId));
      },
    }),
    {
      name: "workspace-code-server-store",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);

export function getCodeServerRecord(codeServerId: string): CodeServerRecord | null {
  const normalizedCodeServerId = trimNonEmpty(codeServerId);
  if (!normalizedCodeServerId) {
    return null;
  }
  return useCodeServerStore.getState().codeServersById[normalizedCodeServerId] ?? null;
}

export function createWorkspaceCodeServer(input: {
  initialUrl: string;
  workspaceKey?: string | null;
}): {
  codeServerId: string;
  browserId: string;
  initialUrl: string;
} {
  const browser = createWorkspaceBrowser({ initialUrl: input.initialUrl });
  const codeServerId = useCodeServerStore.getState().createCodeServer({
    initialUrl: browser.url,
    browserId: browser.browserId,
    workspaceKey: input.workspaceKey,
  });
  const record = getCodeServerRecord(codeServerId);
  return {
    codeServerId,
    browserId: record?.browserId ?? browser.browserId,
    initialUrl: record?.initialUrl ?? input.initialUrl,
  };
}
