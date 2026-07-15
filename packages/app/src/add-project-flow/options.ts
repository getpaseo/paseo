import type { AddProjectHost } from "./model";

export type AddProjectMethodId = "directory-search" | "browse" | "github" | "new-directory";

export interface AddProjectMethodOption {
  id: AddProjectMethodId;
  label: string;
  description: string;
  disabled?: boolean;
}

export interface AddProjectPathOption {
  id: string;
  path: string;
  displayPath: string;
  secondaryText: string | null;
  disabled: boolean;
}

export function filterAddProjectHosts(hosts: AddProjectHost[], query: string): AddProjectHost[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return hosts;
  return hosts.filter(
    (host) =>
      host.label.toLowerCase().includes(normalized) ||
      host.serverId.toLowerCase().includes(normalized),
  );
}

export function buildAddProjectMethods(host: AddProjectHost): AddProjectMethodOption[] {
  const options: AddProjectMethodOption[] = [];
  if (host.canAddProject) {
    options.push({
      id: "directory-search",
      label: "Search for directory",
      description: `Find a directory on ${host.label}`,
    });
  }
  if (host.canBrowse) {
    options.push({
      id: "browse",
      label: "Browse",
      description: "Choose or create a directory in Finder",
    });
  }
  options.push({
    id: "github",
    label: "Clone from GitHub",
    description: host.canSearchGithubRepositories
      ? "Search projects available to your GitHub account"
      : "Update this host to search GitHub",
    disabled: !host.canSearchGithubRepositories,
  });
  options.push({
    id: "new-directory",
    label: "New directory",
    description: host.canCreateDirectory
      ? `Create an empty directory on ${host.label}`
      : "Update this host to create directories",
    disabled: !host.canCreateDirectory,
  });
  return options;
}

export function pathBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

export function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  if (index === 0) return trimmed.slice(0, 1);
  return trimmed.slice(0, index);
}

export function joinDirectoryPath(parent: string, name: string): string {
  const trimmedParent = parent.replace(/[\\/]+$/, "");
  const separator = trimmedParent.includes("\\") && !trimmedParent.includes("/") ? "\\" : "/";
  return `${trimmedParent}${separator}${name}`;
}

export function buildSuggestedParentDirectories(projectPaths: string[]): string[] {
  const values = [
    ...projectPaths.flatMap((path) => {
      const parent = parentDirectory(path);
      return parent ? [parent] : [];
    }),
    "~/dev",
    "~/Developer",
    "~/src",
    "~/projects",
    "~/workspace",
    "~",
  ];
  return [...new Set(values)];
}

export function buildCloneLocationOptions(input: {
  parents: string[];
  repositoryName: string;
  existingPaths: string[];
}): AddProjectPathOption[] {
  const existing = new Set(input.existingPaths);
  return input.parents.map((parent) => {
    const path = joinDirectoryPath(parent, input.repositoryName);
    return {
      id: parent,
      path: parent,
      displayPath: path,
      secondaryText: existing.has(path) ? "Already exists" : `Parent directory: ${parent}`,
      disabled: existing.has(path),
    };
  });
}
