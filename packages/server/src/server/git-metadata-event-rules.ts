export type GitMetadataScope = "worktree" | "common";

type GitMetadataEventRule = {
  id: string;
  scope: GitMetadataScope | "both";
  path: string;
  prune?: true;
} & (
  | { match: "exact" | "prefix" | "suffix"; route: "ignore" }
  | { match: "exact" | "prefix" | "suffix"; route: "owner" | "all"; refreshBase: boolean }
  | { match: "prefix"; route: "local-ref" | "remote-ref" }
);

export type GitMetadataEffect =
  | { kind: "ignore" }
  | { kind: "owner" | "all"; refreshBase: boolean }
  | { kind: "ref"; namespace: "local" | "remote"; ref: string };

export const GIT_METADATA_EVENT_RULES = [
  { id: "lock", scope: "both", match: "suffix", path: ".lock", route: "ignore" },
  {
    id: "worktree-index",
    scope: "worktree",
    match: "exact",
    path: "index",
    route: "owner",
    refreshBase: false,
  },
  {
    id: "worktree-head",
    scope: "worktree",
    match: "exact",
    path: "HEAD",
    route: "owner",
    refreshBase: true,
  },
  {
    id: "worktree-config",
    scope: "worktree",
    match: "exact",
    path: "config.worktree",
    route: "owner",
    refreshBase: true,
  },
  {
    id: "paseo-worktree-metadata",
    scope: "worktree",
    match: "exact",
    path: "paseo/worktree.json",
    route: "owner",
    refreshBase: true,
  },
  {
    id: "main-index",
    scope: "common",
    match: "exact",
    path: "index",
    route: "owner",
    refreshBase: false,
  },
  {
    id: "main-head",
    scope: "common",
    match: "exact",
    path: "HEAD",
    route: "owner",
    refreshBase: true,
  },
  {
    id: "local-branch",
    scope: "common",
    match: "prefix",
    path: "refs/heads/",
    route: "local-ref",
  },
  {
    id: "remote-branch",
    scope: "common",
    match: "prefix",
    path: "refs/remotes/",
    route: "remote-ref",
  },
  {
    id: "packed-refs",
    scope: "common",
    match: "exact",
    path: "packed-refs",
    route: "all",
    refreshBase: true,
  },
  {
    id: "reftable",
    scope: "common",
    match: "prefix",
    path: "reftable/",
    route: "all",
    refreshBase: true,
  },
  {
    id: "shared-config",
    scope: "common",
    match: "exact",
    path: "config",
    route: "all",
    refreshBase: true,
  },
  {
    id: "worktree-administration",
    scope: "common",
    match: "prefix",
    path: "worktrees/",
    route: "ignore",
  },
  {
    id: "hooks",
    scope: "common",
    match: "prefix",
    path: "hooks/",
    route: "ignore",
    prune: true,
  },
  {
    id: "ref-logs",
    scope: "common",
    match: "prefix",
    path: "logs/",
    route: "ignore",
    prune: true,
  },
  {
    id: "object-database",
    scope: "common",
    match: "prefix",
    path: "objects/",
    route: "ignore",
    prune: true,
  },
] as const satisfies readonly GitMetadataEventRule[];

export function getPrunedGitMetadataPaths(scope: GitMetadataScope): string[] {
  return GIT_METADATA_EVENT_RULES.flatMap((rule) => {
    if (rule.scope !== "both" && rule.scope !== scope) return [];
    if (!("prune" in rule) || !rule.prune || rule.match !== "prefix") return [];
    return [rule.path.slice(0, -1)];
  });
}

export function classifyGitMetadataPath(
  scope: GitMetadataScope,
  inputPath: string,
): GitMetadataEffect {
  const path = inputPath.replaceAll("\\", "/");
  const submoduleEffect = classifySubmoduleMetadataPath(scope, path);
  if (submoduleEffect) {
    return submoduleEffect;
  }
  const rule = GIT_METADATA_EVENT_RULES.find(
    (candidate) =>
      (candidate.scope === "both" || candidate.scope === scope) &&
      matchesGitMetadataPath(candidate.match, candidate.path, path),
  );
  if (!rule || rule.route === "ignore") return { kind: "ignore" };
  if (rule.route === "owner" || rule.route === "all") {
    return { kind: rule.route, refreshBase: rule.refreshBase };
  }
  return {
    kind: "ref",
    namespace: rule.route === "local-ref" ? "local" : "remote",
    ref: path.slice(rule.path.length),
  };
}

function classifySubmoduleMetadataPath(
  scope: GitMetadataScope,
  path: string,
): GitMetadataEffect | null {
  if (scope !== "common" || !path.startsWith("modules/")) {
    return null;
  }
  if (path.endsWith(".lock") || path.includes("/logs/") || path.includes("/objects/")) {
    return { kind: "ignore" };
  }
  if (path.endsWith("/index")) {
    return { kind: "all", refreshBase: false };
  }
  const refDependentMetadata =
    path.endsWith("/HEAD") ||
    path.endsWith("/packed-refs") ||
    path.includes("/refs/heads/") ||
    path.includes("/reftable/");
  return refDependentMetadata ? { kind: "all", refreshBase: true } : { kind: "ignore" };
}

function matchesGitMetadataPath(
  match: GitMetadataEventRule["match"],
  pattern: string,
  path: string,
): boolean {
  if (match === "exact") return path === pattern;
  if (match === "suffix") return path.endsWith(pattern);
  return path === pattern.slice(0, -1) || path.startsWith(pattern);
}
