interface ProjectSettingsTarget {
  projectKey: string;
}

export function findProjectSettingsTarget<T extends ProjectSettingsTarget>(
  projects: readonly T[],
  routeKey: string,
): T | undefined {
  return projects.find((project) => project.projectKey === routeKey);
}
