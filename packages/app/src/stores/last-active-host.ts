export interface LastActiveHostStorage {
  read(): Promise<string | null>;
  write(value: string): Promise<void>;
}

function normalizeServerId(input: unknown): string | null {
  if (typeof input !== "string") {
    return null;
  }
  const trimmed = input.trim();
  return trimmed ? trimmed : null;
}

/**
 * Remembers the host (serverId) the user was last looking at, independent of
 * whether they had a workspace open. The last-*workspace* selection only
 * persists when both serverId and workspaceId are present, so a user sitting on
 * a host's open-project / project-list screen has no remembered workspace. Exit
 * paths that fall back on the last workspace would then drop to a no-host route
 * and re-select the default host. This store fills that gap: any route carrying
 * a serverId records it, so we can return to the same host on exit.
 */
export function createLastActiveHostStore(storage: LastActiveHostStorage) {
  let serverId: string | null = null;
  let hydrated = false;
  let hydrationPromise: Promise<void> | null = null;
  let revision = 0;
  const listeners = new Set<() => void>();

  function notifyListeners() {
    for (const listener of listeners) {
      listener();
    }
  }

  function remember(next: string) {
    const normalized = normalizeServerId(next);
    if (!normalized || serverId === normalized) {
      return;
    }
    serverId = normalized;
    revision += 1;
    notifyListeners();
    void storage.write(normalized).catch(() => {});
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
          serverId = normalizeServerId(stored);
        }
        return undefined;
      })
      .catch(() => {
        if (revision === hydrationRevision) {
          serverId = null;
        }
      })
      .finally(() => {
        hydrated = true;
        notifyListeners();
      });
    return hydrationPromise;
  }

  return {
    getServerId: () => serverId,
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
