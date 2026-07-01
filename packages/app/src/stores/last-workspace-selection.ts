export interface ActiveWorkspaceSelection {
  serverId: string;
  workspaceId: string;
}

export const LAST_WORKSPACE_SELECTION_STORAGE_KEY = "paseo:last-workspace-route-selection";

export interface LastWorkspaceSelectionStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

function normalizeWorkspaceSelection(input: unknown): ActiveWorkspaceSelection | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return null;
  }
  const record = input as Record<string, unknown>;
  const serverId = typeof record.serverId === "string" ? record.serverId.trim() : "";
  const workspaceId = typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";
  if (!serverId || !workspaceId) {
    return null;
  }
  return { serverId, workspaceId };
}

function parseStoredWorkspaceSelection(stored: string | null): ActiveWorkspaceSelection | null {
  if (!stored) {
    return null;
  }
  try {
    return normalizeWorkspaceSelection(JSON.parse(stored));
  } catch {
    return null;
  }
}

export function createLastWorkspaceSelectionStore(storage: LastWorkspaceSelectionStorage) {
  let selection: ActiveWorkspaceSelection | null = null;
  let hydrated = false;
  let hydrationPromise: Promise<void> | null = null;
  let revision = 0;
  const listeners = new Set<() => void>();

  function notifyListeners() {
    for (const listener of listeners) {
      listener();
    }
  }

  function remember(next: ActiveWorkspaceSelection) {
    const normalized = normalizeWorkspaceSelection(next);
    if (!normalized) {
      return;
    }
    if (
      selection?.serverId === normalized.serverId &&
      selection.workspaceId === normalized.workspaceId
    ) {
      return;
    }
    selection = normalized;
    revision += 1;
    notifyListeners();
    // workspaceId is opaque; do not parse this persisted selection back into a path.
    void storage.write(JSON.stringify(normalized)).catch(() => {});
  }

  function hydrate(): Promise<void> {
    if (hydrationPromise) {
      return hydrationPromise;
    }
    const hydrationRevision = revision;
    hydrationPromise = storage
      .read()
      .then((stored) => {
        if (revision === hydrationRevision) {
          selection = parseStoredWorkspaceSelection(stored);
        }
        return undefined;
      })
      .catch(() => {
        if (revision === hydrationRevision) {
          selection = null;
        }
      })
      .finally(() => {
        hydrated = true;
        notifyListeners();
      });
    return hydrationPromise;
  }

  return {
    getSelection: () => selection,
    hydrate,
    isHydrated: () => hydrated,
    remember,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
