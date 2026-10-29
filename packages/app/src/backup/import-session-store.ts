import { create } from "zustand";
import type { ParsedBackup } from "./bundle";
import type {
  BackupImportResult,
  DeviceItemId,
  HostImportChoice,
  ReenterItem,
} from "./import-model";

export type ImportStep =
  | { kind: "choose" }
  | { kind: "applying" }
  | { kind: "error"; message: string }
  | { kind: "results"; results: BackupImportResult[]; reenter: ReenterItem[] };

/** What the user changed in the preview. Anything left unset falls back to the sheet's defaults. */
export interface ImportEdits {
  device?: DeviceItemId[];
  targets: Record<string, string | null>;
  choices: Record<string, HostImportChoice>;
}

export interface ImportSession {
  backup: ParsedBackup;
  key: number;
  step: ImportStep;
  edits: ImportEdits;
}

interface ImportSessionStore {
  session: ImportSession | null;
  open: (backup: ParsedBackup) => void;
  /** Ignored when `key` is not the open session, so a finished apply cannot write into a newer one. */
  setStep: (key: number, step: ImportStep) => void;
  /** Ignored when `key` is not the open session. */
  updateEdits: (key: number, update: (edits: ImportEdits) => ImportEdits) => void;
  close: () => void;
}

// The session lives outside the Settings screen: an appearance change remounts every screen
// (AppearanceStyleBoundary), and an import that changes the theme would otherwise lose its results,
// and a light/dark switch while the preview is open would undo the user's choices.
let nextSessionKey = 1;

export const useImportSessionStore = create<ImportSessionStore>((set) => ({
  session: null,
  open: (backup) =>
    set({
      session: {
        backup,
        key: nextSessionKey++,
        step: { kind: "choose" },
        edits: { targets: {}, choices: {} },
      },
    }),
  setStep: (key, step) =>
    set((state) => (state.session?.key === key ? { session: { ...state.session, step } } : state)),
  updateEdits: (key, update) =>
    set((state) =>
      state.session?.key === key
        ? { session: { ...state.session, edits: update(state.session.edits) } }
        : state,
    ),
  close: () => set({ session: null }),
}));
