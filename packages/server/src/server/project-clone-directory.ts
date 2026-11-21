import { validateDirectoryName } from "./project-directory-service.js";

export interface CloneDirectoryNameInput {
  repositoryName: string;
  directoryName: string | undefined;
}

/**
 * The folder a clone lands in inside the target directory. Clients that let the
 * user rename it send `directoryName`, so two repositories with the same name
 * (vitejs/devtools, nuxt/devtools) can share one parent.
 */
export function resolveCloneDirectoryName(input: CloneDirectoryNameInput): string {
  if (input.directoryName === undefined) return input.repositoryName;
  const name = input.directoryName.trim();
  validateDirectoryName(name);
  return name;
}
