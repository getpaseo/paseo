import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

/**
 * Derives the project key for grouping agents.
 * For worktrees, returns the parent repo path.
 * For regular repos/directories, returns the cwd.
 */
export function deriveProjectKey(cwd: string): string {
  const worktreeMarker = ".paseo/worktrees/";
  const idx = cwd.indexOf(worktreeMarker);
  if (idx !== -1) {
    // Return parent repo path (before .paseo/worktrees/)
    return cwd.slice(0, idx).replace(/\/$/, "");
  }
  return cwd;
}

/**
 * Produces a stable grouping key from a git remote URL.
 *
 * Waterfall:
 * - Prefer a GitHub key (normalizes SSH/HTTPS to the same key).
 * - Fallback to a generic host/path key (still normalized across SSH/HTTPS).
 */
export function deriveRemoteProjectKey(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return null;
  }

  const trimmed = remoteUrl.trim();
  if (!trimmed) {
    return null;
  }

  // Support the common forms:
  // - git@github.com:owner/repo.git
  // - https://github.com/owner/repo(.git)
  // - ssh://git@github.com/owner/repo(.git)
  let host: string | null = null;
  let path: string | null = null;

  // SSH scp-like form: user@host:owner/repo(.git)
  const scpLike = trimmed.match(/^[^@]+@([^:]+):(.+)$/);
  if (scpLike) {
    host = scpLike[1] ?? null;
    path = scpLike[2] ?? null;
  } else if (trimmed.includes("://")) {
    try {
      const parsed = new URL(trimmed);
      host = parsed.hostname || null;
      path = parsed.pathname ? parsed.pathname.replace(/^\//, "") : null;
    } catch {
      // Fall through to best-effort parsing below.
    }
  }

  if (!host || !path) {
    return null;
  }

  let cleanedPath = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (cleanedPath.endsWith(".git")) {
    cleanedPath = cleanedPath.slice(0, -4);
  }

  // Best-effort: owner/repo is the common case.
  // If the path is longer (e.g. groups/subgroups/repo), still keep it.
  if (!cleanedPath.includes("/")) {
    return null;
  }

  const cleanedHost = host.toLowerCase();

  // GitHub normalization: treat github.com as a special "well-known" host to
  // match the intended UX: group by repo even across different local worktrees.
  if (cleanedHost === "github.com") {
    return `remote:github.com/${cleanedPath}`;
  }

  return `remote:${cleanedHost}/${cleanedPath}`;
}

/**
 * Extracts the repo name from a git remote URL.
 * Examples:
 *   git@github.com:anthropics/claude-code.git -> anthropics/claude-code
 *   https://github.com/anthropics/claude-code.git -> anthropics/claude-code
 *   https://github.com/anthropics/claude-code -> anthropics/claude-code
 */
export function parseRepoNameFromRemoteUrl(remoteUrl: string | null): string | null {
  if (!remoteUrl) {
    return null;
  }

  let cleaned = remoteUrl;

  // Handle SSH format: git@github.com:owner/repo.git
  if (cleaned.startsWith("git@")) {
    const colonIdx = cleaned.indexOf(":");
    if (colonIdx !== -1) {
      cleaned = cleaned.slice(colonIdx + 1);
    }
  }
  // Handle HTTPS format: https://github.com/owner/repo.git
  else if (cleaned.includes("://")) {
    const urlPath = cleaned.split("://")[1];
    if (urlPath) {
      // Remove host (e.g., github.com/)
      const slashIdx = urlPath.indexOf("/");
      if (slashIdx !== -1) {
        cleaned = urlPath.slice(slashIdx + 1);
      }
    }
  }

  // Remove .git suffix
  if (cleaned.endsWith(".git")) {
    cleaned = cleaned.slice(0, -4);
  }

  // Should be in format owner/repo now
  if (cleaned.includes("/")) {
    return cleaned;
  }

  return null;
}

/**
 * Extracts just the repo name (without owner) from a remote URL.
 * Examples:
 *   git@github.com:anthropics/claude-code.git -> claude-code
 */
export function parseRepoShortNameFromRemoteUrl(remoteUrl: string | null): string | null {
  const fullName = parseRepoNameFromRemoteUrl(remoteUrl);
  if (!fullName) {
    return null;
  }
  const parts = fullName.split("/");
  return parts[parts.length - 1] || null;
}

/**
 * Extracts the project name from a path (last segment).
 */
export function deriveProjectName(projectKey: string): string {
  const githubRemotePrefix = "remote:github.com/";
  if (projectKey.startsWith(githubRemotePrefix)) {
    return projectKey.slice(githubRemotePrefix.length) || projectKey;
  }
  const segments = projectKey.split("/").filter(Boolean);
  return segments[segments.length - 1] || projectKey;
}

/**
 * Formats a project name for display in the UI.
 *
 * - GitHub remotes show owner/repo
 * - Other remotes show the remote path when possible
 * - Local projects prefer the provided projectName, then fallback to cwd tail
 */
export function deriveProjectDisplayName(input: {
  projectKey: string;
  projectName: string;
}): string {
  const githubPrefix = "remote:github.com/";
  if (input.projectKey.startsWith(githubPrefix)) {
    return input.projectKey.slice(githubPrefix.length);
  }

  if (input.projectKey.startsWith("remote:")) {
    const withoutPrefix = input.projectKey.slice("remote:".length);
    const slashIdx = withoutPrefix.indexOf("/");
    if (slashIdx >= 0) {
      const remotePath = withoutPrefix.slice(slashIdx + 1).trim();
      if (remotePath.length > 0) {
        return remotePath;
      }
    }
    return withoutPrefix;
  }

  const trimmedProjectName = input.projectName.trim();
  if (trimmedProjectName.length > 0) {
    return trimmedProjectName;
  }

  const normalized = input.projectKey.replace(/\\/g, "/").replace(/\/+$/, "");
  const segments = normalized.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? input.projectKey;
}

/**
 * Determines the date group label for an agent based on lastActivityAt.
 */
export function deriveDateGroup(lastActivityAt: Date): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const activityDate = new Date(
    lastActivityAt.getFullYear(),
    lastActivityAt.getMonth(),
    lastActivityAt.getDate(),
  );

  if (activityDate.getTime() >= today.getTime()) {
    return "Recent";
  }
  if (activityDate.getTime() >= yesterday.getTime()) {
    return "Yesterday";
  }

  const diffTime = today.getTime() - activityDate.getTime();
  const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

  if (diffDays <= 7) {
    return "This week";
  }
  if (diffDays <= 30) {
    return "This month";
  }
  return "Older";
}

export interface ProjectGroup {
  projectKey: string;
  projectName: string;
  agents: AggregatedAgent[];
  /** Number of truly active agents (running, needs input, or requires attention) */
  activeCount: number;
  /** Total agents before any limit was applied */
  totalCount: number;
}

export interface DateGroup {
  label: string;
  agents: AggregatedAgent[];
}

export interface GroupedAgents {
  activeGroups: ProjectGroup[];
  inactiveGroups: DateGroup[];
}

const ACTIVE_GRACE_PERIOD_MS = 2 * 24 * 60 * 60 * 1000; // 2 days (temporary for screenshots)

interface GroupAgentsOptions {
  /**
   * Optional function to read a remote URL for an agent.
   * If present and a remote URL is available, agents are grouped by remote.
   */
  getRemoteUrl?: (agent: AggregatedAgent) => string | null;
}

const MAX_INACTIVE_PER_PROJECT = 5;

/**
 * Groups agents into active (by project) and inactive (by date) sections.
 * Active = running, needs input, requires attention, or had activity within the grace period.
 *
 * Within each project group:
 * - All truly active agents (running/needs input/requires attention) are always shown
 * - Recently active (within grace period but not truly active) are limited to MAX_INACTIVE_PER_PROJECT
 */
function isAgentTrulyActive(agent: AggregatedAgent): boolean {
  return (
    agent.status === "running" || agent.requiresAttention || (agent.pendingPermissionCount ?? 0) > 0
  );
}

function partitionAgentsByActivity(
  agents: AggregatedAgent[],
  now: number,
): { activeAgents: AggregatedAgent[]; inactiveAgents: AggregatedAgent[] } {
  const activeAgents: AggregatedAgent[] = [];
  const inactiveAgents: AggregatedAgent[] = [];

  for (const agent of agents) {
    if (agent.archivedAt) {
      inactiveAgents.push(agent);
      continue;
    }

    const isRecentlyActive = now - agent.lastActivityAt.getTime() < ACTIVE_GRACE_PERIOD_MS;
    if (isAgentTrulyActive(agent) || isRecentlyActive) {
      activeAgents.push(agent);
    } else {
      inactiveAgents.push(agent);
    }
  }

  return { activeAgents, inactiveAgents };
}

interface ProjectActivityBucket {
  trulyActive: AggregatedAgent[];
  recentlyActive: AggregatedAgent[];
}

function buildProjectActivityMap(
  activeAgents: AggregatedAgent[],
  options: GroupAgentsOptions | undefined,
): Map<string, ProjectActivityBucket> {
  const projectMap = new Map<string, ProjectActivityBucket>();
  for (const agent of activeAgents) {
    const remoteKey = deriveRemoteProjectKey(options?.getRemoteUrl?.(agent) ?? null);
    const projectKey = remoteKey ?? deriveProjectKey(agent.cwd);
    const existing = projectMap.get(projectKey) || { trulyActive: [], recentlyActive: [] };

    if (isAgentTrulyActive(agent)) {
      existing.trulyActive.push(agent);
    } else {
      existing.recentlyActive.push(agent);
    }

    projectMap.set(projectKey, existing);
  }
  return projectMap;
}

function byLastActivityDescending(a: AggregatedAgent, b: AggregatedAgent): number {
  return b.lastActivityAt.getTime() - a.lastActivityAt.getTime();
}

function buildActiveProjectGroups(projectMap: Map<string, ProjectActivityBucket>): ProjectGroup[] {
  const activeGroups: ProjectGroup[] = [];
  for (const [projectKey, { trulyActive, recentlyActive }] of projectMap) {
    trulyActive.sort(byLastActivityDescending);
    recentlyActive.sort(byLastActivityDescending);

    const limitedRecentlyActive = recentlyActive.slice(0, MAX_INACTIVE_PER_PROJECT);
    const combinedAgents = [...trulyActive, ...limitedRecentlyActive];
    combinedAgents.sort(byLastActivityDescending);

    activeGroups.push({
      projectKey,
      projectName: deriveProjectName(projectKey),
      agents: combinedAgents,
      activeCount: trulyActive.length,
      totalCount: trulyActive.length + recentlyActive.length,
    });
  }

  activeGroups.sort((a, b) => {
    const aRecent = a.agents[0]?.lastActivityAt.getTime() ?? 0;
    const bRecent = b.agents[0]?.lastActivityAt.getTime() ?? 0;
    return bRecent - aRecent;
  });

  return activeGroups;
}

function buildInactiveDateGroups(inactiveAgents: AggregatedAgent[]): DateGroup[] {
  const dateMap = new Map<string, AggregatedAgent[]>();
  for (const agent of inactiveAgents) {
    const dateLabel = deriveDateGroup(agent.lastActivityAt);
    const existing = dateMap.get(dateLabel) || [];
    existing.push(agent);
    dateMap.set(dateLabel, existing);
  }

  const dateOrder = ["Recent", "Yesterday", "This week", "This month", "Older"];
  const inactiveGroups: DateGroup[] = [];
  for (const label of dateOrder) {
    const dateAgents = dateMap.get(label);
    if (dateAgents && dateAgents.length > 0) {
      dateAgents.sort(byLastActivityDescending);
      inactiveGroups.push({ label, agents: dateAgents });
    }
  }
  return inactiveGroups;
}

export function groupAgents(
  agents: AggregatedAgent[],
  options?: GroupAgentsOptions,
): GroupedAgents {
  const { activeAgents, inactiveAgents } = partitionAgentsByActivity(agents, Date.now());
  const projectMap = buildProjectActivityMap(activeAgents, options);
  const activeGroups = buildActiveProjectGroups(projectMap);
  const inactiveGroups = buildInactiveDateGroups(inactiveAgents);
  return { activeGroups, inactiveGroups };
}
