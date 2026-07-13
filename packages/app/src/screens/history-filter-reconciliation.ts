interface HistoryProjectIdentity {
  projectKey: string;
}

export interface HistoryFilterReconciliation {
  hostKeys: string[];
  projectKeys: string[] | null;
}

export function resolveHistoryFilterReconciliation(input: {
  preferencesHydrated: boolean;
  hostRegistryLoaded: boolean;
  allServerIds: readonly string[];
  hydratedServerIds: readonly string[];
  allHostProjects: readonly HistoryProjectIdentity[];
}): HistoryFilterReconciliation | null {
  if (!input.preferencesHydrated || !input.hostRegistryLoaded) return null;

  const hostKeys = Array.from(
    new Set(input.allServerIds.map((serverId) => serverId.trim()).filter(Boolean)),
  );
  const hydrated = new Set(input.hydratedServerIds);
  const allProjectsHydrated = hostKeys.every((serverId) => hydrated.has(serverId));

  return {
    hostKeys,
    projectKeys: allProjectsHydrated
      ? Array.from(
          new Set(
            input.allHostProjects.map((project) => project.projectKey.trim()).filter(Boolean),
          ),
        )
      : null,
  };
}
