import { createRealpathAwarePathMatcher } from "../utils/path.js";
import type { PersistedProjectRecord, ProjectRegistry } from "./workspace-registry.js";

export async function resolveProjectReference(
  reference: string,
  projectRegistry: Pick<ProjectRegistry, "get" | "list">,
  pathHints: readonly string[] = [],
): Promise<PersistedProjectRecord | null> {
  const direct = await projectRegistry.get(reference);
  if (direct && !direct.archivedAt) return direct;

  // COMPAT(projectKeyAsProjectId): added in v0.2.4 on 2026-07-29; remove after 2027-01-29.
  // Older clients return ProjectPlacementPayload.projectKey in workspace source.projectId.
  const candidates = (await projectRegistry.list()).filter(
    (project) => !project.archivedAt && project.projectKey === reference,
  );
  for (const pathHint of pathHints) {
    const matches = candidates.filter((project) =>
      createRealpathAwarePathMatcher(project.rootPath)(pathHint),
    );
    if (matches.length === 1) return matches[0] ?? null;
  }
  return candidates.length === 1 ? (candidates[0] ?? null) : direct;
}
