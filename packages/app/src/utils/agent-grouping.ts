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
 * Extracts the repo name from a git remote URL.
 * Examples:
 *   git@github.com:anthropics/claude-code.git -> anthropics/claude-code
 *   https://github.com/anthropics/claude-code.git -> anthropics/claude-code
 *   https://github.com/anthropics/claude-code -> anthropics/claude-code
 */
export function parseRepoNameFromRemoteUrl(
  remoteUrl: string | null
): string | null {
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
export function parseRepoShortNameFromRemoteUrl(
  remoteUrl: string | null
): string | null {
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
  const segments = projectKey.split("/").filter(Boolean);
  return segments[segments.length - 1] || projectKey;
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
    lastActivityAt.getDate()
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
}

export interface DateGroup {
  label: string;
  agents: AggregatedAgent[];
}

export interface GroupedAgents {
  activeGroups: ProjectGroup[];
  inactiveGroups: DateGroup[];
}

const ACTIVE_GRACE_PERIOD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Groups agents into active (by project) and inactive (by date) sections.
 * Active = running, requires attention, or had activity within the last 5 minutes.
 */
export function groupAgents(agents: AggregatedAgent[]): GroupedAgents {
  const activeAgents: AggregatedAgent[] = [];
  const inactiveAgents: AggregatedAgent[] = [];
  const now = Date.now();

  for (const agent of agents) {
    const isRunningOrAttention =
      agent.status === "running" || agent.requiresAttention;
    const isRecentlyActive =
      now - agent.lastActivityAt.getTime() < ACTIVE_GRACE_PERIOD_MS;
    const isActive = isRunningOrAttention || isRecentlyActive;

    if (isActive) {
      activeAgents.push(agent);
    } else {
      inactiveAgents.push(agent);
    }
  }

  // Group active agents by project
  const projectMap = new Map<string, AggregatedAgent[]>();
  for (const agent of activeAgents) {
    const projectKey = deriveProjectKey(agent.cwd);
    const existing = projectMap.get(projectKey) || [];
    existing.push(agent);
    projectMap.set(projectKey, existing);
  }

  // Sort agents within each project by lastActivityAt (newest first)
  const activeGroups: ProjectGroup[] = [];
  for (const [projectKey, projectAgents] of projectMap) {
    projectAgents.sort(
      (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
    );
    activeGroups.push({
      projectKey,
      projectName: deriveProjectName(projectKey),
      agents: projectAgents,
    });
  }

  // Sort project groups by most recent activity
  activeGroups.sort((a, b) => {
    const aRecent = a.agents[0]?.lastActivityAt.getTime() ?? 0;
    const bRecent = b.agents[0]?.lastActivityAt.getTime() ?? 0;
    return bRecent - aRecent;
  });

  // Group inactive agents by date
  const dateMap = new Map<string, AggregatedAgent[]>();
  for (const agent of inactiveAgents) {
    const dateLabel = deriveDateGroup(agent.lastActivityAt);
    const existing = dateMap.get(dateLabel) || [];
    existing.push(agent);
    dateMap.set(dateLabel, existing);
  }

  // Sort agents within each date group by lastActivityAt (newest first)
  const dateOrder = ["Recent", "Yesterday", "This week", "This month", "Older"];
  const inactiveGroups: DateGroup[] = [];
  for (const label of dateOrder) {
    const dateAgents = dateMap.get(label);
    if (dateAgents && dateAgents.length > 0) {
      dateAgents.sort(
        (a, b) => b.lastActivityAt.getTime() - a.lastActivityAt.getTime()
      );
      inactiveGroups.push({ label, agents: dateAgents });
    }
  }

  return { activeGroups, inactiveGroups };
}
