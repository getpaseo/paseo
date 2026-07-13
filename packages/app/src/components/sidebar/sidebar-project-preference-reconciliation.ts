interface SidebarProjectIdentity {
  projectKey: string;
}

export function resolveProjectPreferenceReconciliationKeys(input: {
  hostRegistryLoaded: boolean;
  allServerIds: readonly string[];
  hydratedServerIds: readonly string[];
  allHostProjects: readonly SidebarProjectIdentity[];
}): string[] | null {
  if (!input.hostRegistryLoaded) return null;
  const hydrated = new Set(input.hydratedServerIds);
  if (input.allServerIds.some((serverId) => !hydrated.has(serverId))) return null;
  return Array.from(
    new Set(input.allHostProjects.map((project) => project.projectKey.trim()).filter(Boolean)),
  );
}
