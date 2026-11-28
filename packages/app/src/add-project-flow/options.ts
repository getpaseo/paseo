import {
  isCompleteGitRemote,
  parseGitHubRemoteUrl,
  parseGitRemoteLocation,
} from "@getpaseo/protocol/git-remote";
import type { GithubRepositoryChoice } from "./model";

export function pathBaseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] ?? trimmed;
}

/** Starts the id of every choice built from what the user typed. */
export const MANUAL_CHOICE_PREFIX = "manual:";

export function buildManualGithubRepositoryChoices(query: string): GithubRepositoryChoice[] {
  const repo = query.trim();
  if (!repo) return [];

  if (isCompleteGitRemote(repo)) {
    const identity = parseGitHubRemoteUrl(repo);
    const location = parseGitRemoteLocation(repo);
    const remoteName = location ? pathBaseName(location.path).replace(/\.git$/u, "") : repo;
    return [
      {
        id: `${MANUAL_CHOICE_PREFIX}${repo}`,
        nameWithOwner: identity?.repo ?? remoteName,
        cloneUrl: repo,
        description: "Clone this repository URL",
        updatedAt: null,
      },
    ];
  }

  const shorthand = repo.match(/^([^\s/]+)\/([^\s/]+)$/u);
  if (!shorthand) return [];
  const nameWithOwner = `${shorthand[1]}/${shorthand[2]}`;
  return (["https", "ssh"] as const).map((cloneProtocol) => ({
    id: `${MANUAL_CHOICE_PREFIX}${cloneProtocol}:${nameWithOwner}`,
    nameWithOwner,
    cloneUrl: nameWithOwner,
    cloneProtocol,
    description: `Clone owner/repo via ${cloneProtocol.toUpperCase()}`,
    updatedAt: null,
  }));
}

/** The folder that holds `path`. A root keeps its separator: `C:\repo` gives `C:\`, not `C:`. */
export function parentDirectory(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  // A share root (\\server\share) has no parent folder; `\\server` alone is not a directory.
  if (/^[\\/]{2}[^\\/]+[\\/][^\\/]+$/u.test(trimmed)) return null;
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  const parent = trimmed.slice(0, index);
  const isRoot = parent === "" || /^[A-Za-z]:$/u.test(parent);
  return isRoot ? trimmed.slice(0, index + 1) : parent;
}

export function joinDirectoryPath(parent: string, name: string): string {
  const separator = parent.includes("\\") && !parent.includes("/") ? "\\" : "/";
  return `${parent.replace(/[\\/]+$/, "")}${separator}${name}`;
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

/**
 * Where a new folder or clone goes when the user has not picked a location on this host: the last
 * one used, else the parent of a recent project, else home. Only folders known to exist qualify;
 * guesses like `~/dev` stay suggestions in the Location picker.
 */
export function defaultProjectLocation(input: {
  remembered: string | undefined;
  projectPaths: string[];
}): string {
  const projectParent = input.projectPaths
    .map(parentDirectory)
    .find((parent): parent is string => parent !== null);
  return input.remembered ?? projectParent ?? "~";
}

/** The folder a clone of `nameWithOwner` checks out into; the host drops a trailing `.git`. */
export function checkoutName(nameWithOwner: string): string {
  return pathBaseName(nameWithOwner).replace(/\.git$/u, "");
}

export function validateNewFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") return "Enter a folder name";
  if (/[\\/]/.test(trimmed)) return "Use a name without slashes";
  // The host rejects a drive prefix on every platform.
  if (/^[A-Za-z]:/u.test(trimmed)) return "Use a name without a drive letter";
  return null;
}
