export interface PluginInstallFormState {
  source: string;
  canSubmit: boolean;
  resetKey: number;
}

export interface PluginInstallSubmission {
  source: string;
}

export interface PluginInstallFormModel {
  getState(): PluginInstallFormState;
  subscribe(listener: () => void): () => void;
  close(): void;
  setSource(value: string): void;
  getSubmission(): PluginInstallSubmission;
  reset(): void;
}

export function openPluginInstallForm(): PluginInstallFormModel {
  const listeners = new Set<() => void>();
  let state: PluginInstallFormState = {
    source: "",
    canSubmit: false,
    resetKey: 0,
  };

  const publish = (next: Pick<PluginInstallFormState, "source" | "resetKey">) => {
    state = { ...next, canSubmit: next.source.trim().length > 0 };
    for (const listener of listeners) listener();
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close() {
      listeners.clear();
    },
    setSource(source) {
      publish({ ...state, source });
    },
    getSubmission() {
      const source = state.source.trim();
      return { source };
    },
    reset() {
      publish({ source: "", resetKey: state.resetKey + 1 });
    },
  };
}
