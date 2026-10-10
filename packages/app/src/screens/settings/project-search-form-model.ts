import {
  ProjectSearchConfigSchema,
  type MutableDaemonConfigPatch,
} from "@getpaseo/protocol/messages";

interface SearchRootField {
  id: number;
  path: string;
  isValid: boolean;
}

interface ProjectSearchFormState {
  roots: SearchRootField[];
  isDirty: boolean;
  canSave: boolean;
  canAdd: boolean;
}

export function openProjectSearchForm(initialRoots?: string[]) {
  const listeners = new Set<() => void>();
  let nextId = 0;
  let savedRoots = initialRoots ?? ["~"];
  let state: ProjectSearchFormState;

  function createFields(paths: string[]) {
    return paths.map((path) => ({ id: nextId++, path, isValid: true }));
  }

  function publish(roots: SearchRootField[]) {
    const paths = roots.map((root) => root.path.trim());
    const isDirty = JSON.stringify(paths) !== JSON.stringify(savedRoots);
    const valid = ProjectSearchConfigSchema.safeParse({ searchRoots: paths }).success;
    state = {
      roots: roots.map((root) => ({
        ...root,
        isValid: ProjectSearchConfigSchema.safeParse({ searchRoots: [root.path.trim()] }).success,
      })),
      isDirty,
      canSave: isDirty && valid,
      canAdd: roots.length < 16,
    };
    for (const listener of listeners) listener();
  }

  publish(createFields(savedRoots));

  return {
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
    },
    setRoot(id: number, path: string) {
      publish(state.roots.map((root) => (root.id === id ? { ...root, path } : root)));
    },
    addRoot() {
      if (state.canAdd) publish([...state.roots, ...createFields([""])]);
    },
    removeRoot(id: number) {
      if (state.roots.length > 1) publish(state.roots.filter((root) => root.id !== id));
    },
    resetToHome() {
      publish(createFields(["~"]));
    },
    applySavedRoots(roots?: string[]) {
      const wasDirty = state.isDirty;
      const nextSaved = roots ?? ["~"];
      if (JSON.stringify(nextSaved) === JSON.stringify(savedRoots)) return;
      savedRoots = [...nextSaved];
      publish(wasDirty ? state.roots : createFields(savedRoots));
    },
    markSaved() {
      savedRoots = state.roots.map((root) => root.path.trim());
      publish(state.roots);
    },
    getSubmission(): MutableDaemonConfigPatch | null {
      if (!state.canSave) return null;
      const searchRoots = state.roots.map((root) => root.path.trim());
      const useHome = searchRoots.length === 1 && searchRoots[0] === "~";
      return { projects: useHome ? {} : { searchRoots } };
    },
  };
}
