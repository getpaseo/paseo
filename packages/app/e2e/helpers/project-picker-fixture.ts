import path from "node:path";
import type { SeedDaemonClient } from "./seed-client";

export interface ProjectPickerFixture {
  projectPath: string;
  projectName: string;
  fuzzyQuery: string;
}

export function getProjectPickerFixture(): ProjectPickerFixture {
  const projectPath = process.env.E2E_PROJECT_PICKER_SEARCH_PATH;
  if (!projectPath) {
    throw new Error("E2E_PROJECT_PICKER_SEARCH_PATH not set by global setup");
  }
  const fuzzyQuery = process.env.E2E_PROJECT_PICKER_SEARCH_QUERY;
  if (!fuzzyQuery) {
    throw new Error("E2E_PROJECT_PICKER_SEARCH_QUERY not set by global setup");
  }
  return {
    projectPath,
    projectName: path.basename(projectPath),
    fuzzyQuery,
  };
}

export async function removeProjectPickerFixture(
  client: SeedDaemonClient,
  fixture: ProjectPickerFixture,
  knownProjectId: string | null = null,
): Promise<void> {
  let projectId = knownProjectId;
  if (!projectId) {
    const lookup = await client.addProject(fixture.projectPath);
    projectId = lookup.project?.projectId ?? null;
    if (!projectId) {
      throw new Error(lookup.error ?? "Could not resolve project picker fixture for cleanup");
    }
  }
  await client.removeProject(projectId);
}
