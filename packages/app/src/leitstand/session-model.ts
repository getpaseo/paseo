import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import type { SidebarWorkspaceEntry } from "@/hooks/sidebar-workspaces-view-model";
import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import { isWorkspaceRootAgent } from "@/subagents/policies";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { extractJiraKeys } from "./jira";

export type ChecksStatus = "none" | "pending" | "success" | "failure";

export interface LeitstandPullRequest {
  number: number;
  url: string;
  title: string | null;
  state: "open" | "merged" | "closed";
  isDraft: boolean;
  checksStatus: ChecksStatus | null;
}

export interface LeitstandAgent {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  bucket: SidebarStateBucket;
  /** Title of the oldest open permission request, when one is waiting. */
  pendingPermission: { id: string; title: string } | null;
  lastError: string | null;
}

/** One Leitstand session: today's workspace, with what the Leitstand shows about it. */
export interface LeitstandSession {
  key: string;
  serverId: string;
  workspaceId: string;
  projectViewKey: string;
  projectName: string;
  projectRootPath: string | null;
  name: string;
  branch: string | null;
  /** Branch, or the workspace directory when there is none. */
  context: string;
  bucket: SidebarStateBucket;
  since: Date | null;
  agents: LeitstandAgent[];
  /** Stack order, bottom first. */
  pullRequests: LeitstandPullRequest[];
  jiraKeys: string[];
}

export interface LeitstandSchedule {
  key: string;
  serverId: string;
  schedule: ScheduleSummary;
  /** The session project the schedule works in, when the client can tell. */
  projectViewKey: string | null;
  projectName: string | null;
}

// Same reading as the sidebar's workspace activity: a closed turn is idle even while the
// lifecycle still says running.
function agentLifecycleStatus(agent: Agent): Agent["status"] {
  if (agent.turn.phase === "open") return "running";
  return agent.status === "running" ? "idle" : agent.status;
}

function toLeitstandAgent(agent: Agent): LeitstandAgent {
  const permission = agent.pendingPermissions[0];
  return {
    id: agent.id,
    title: agent.title,
    provider: agent.provider,
    model: agent.model,
    bucket: deriveSidebarStateBucket({
      status: agentLifecycleStatus(agent),
      pendingPermissionCount: agent.pendingPermissions.length,
      requiresAttention: agent.requiresAttention,
      attentionReason: agent.attentionReason,
    }),
    pendingPermission: permission
      ? { id: permission.id, title: permission.title ?? permission.name }
      : null,
    lastError: agent.lastError ?? null,
  };
}

/** Root agents of each workspace, keyed by workspace id; subagents live inside their parent. */
export function groupRootAgentsByWorkspace(agents: Iterable<Agent>): Map<string, LeitstandAgent[]> {
  const byId = new Map<string, Agent>();
  for (const agent of agents) byId.set(agent.id, agent);
  const grouped = new Map<string, LeitstandAgent[]>();
  for (const agent of byId.values()) {
    if (agent.archivedAt || !agent.workspaceId) continue;
    const parent = agent.parentAgentId ? byId.get(agent.parentAgentId) : undefined;
    if (!isWorkspaceRootAgent(agent, parent)) continue;
    const list = grouped.get(agent.workspaceId) ?? [];
    list.push(toLeitstandAgent(agent));
    grouped.set(agent.workspaceId, list);
  }
  return grouped;
}

/**
 * Every change request of the workspace: the related set when the daemon reports one, otherwise
 * the single change request of the checked-out branch.
 */
export function selectSessionPullRequests(
  entry: Pick<SidebarWorkspaceEntry, "prHint" | "relatedPullRequests">,
  githubRuntime: WorkspaceDescriptor["githubRuntime"],
): LeitstandPullRequest[] {
  const related = entry.relatedPullRequests ?? [];
  if (related.length > 0) {
    return related
      .map((pr, index) => ({ pr, order: pr.stackIndex ?? related.length + index }))
      .sort((left, right) => left.order - right.order)
      .map(({ pr }) => ({
        number: pr.number,
        url: pr.url,
        title: pr.title ?? null,
        state: pr.state,
        isDraft: pr.isDraft ?? false,
        checksStatus: pr.checksStatus ?? null,
      }));
  }
  const hint = entry.prHint;
  if (!hint) return [];
  const current = githubRuntime?.pullRequest;
  return [
    {
      number: hint.number,
      url: hint.url,
      title: current?.title ?? null,
      state: hint.state,
      isDraft: current?.isDraft ?? false,
      checksStatus: hint.checksStatus ?? null,
    },
  ];
}

export function buildLeitstandSession(input: {
  entry: SidebarWorkspaceEntry;
  githubRuntime: WorkspaceDescriptor["githubRuntime"];
  agents: readonly LeitstandAgent[];
}): LeitstandSession {
  const { entry } = input;
  const pullRequests = selectSessionPullRequests(entry, input.githubRuntime);
  return {
    key: entry.workspaceKey,
    serverId: entry.serverId,
    workspaceId: entry.workspaceId,
    projectViewKey: entry.projectViewKey,
    projectName: entry.projectName,
    projectRootPath: entry.projectRootPath ?? null,
    name: entry.name,
    branch: entry.currentBranch,
    context: entry.currentBranch ?? entry.workspaceDirectoryLabel,
    bucket: entry.statusBucket,
    since: entry.statusEnteredAt,
    agents: [...input.agents],
    pullRequests,
    jiraKeys: extractJiraKeys([
      entry.name,
      entry.currentBranch,
      ...pullRequests.map((pr) => pr.title),
    ]),
  };
}

function isInsideRoot(cwd: string, root: string): boolean {
  return cwd === root || cwd.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** Which session project a schedule belongs to: its target agent's, else the one holding its cwd. */
export function resolveScheduleProject(
  input: { serverId: string; schedule: ScheduleSummary },
  sessions: readonly LeitstandSession[],
): Pick<LeitstandSchedule, "projectViewKey" | "projectName"> {
  const target = input.schedule.target;
  const onHost = sessions.filter((session) => session.serverId === input.serverId);
  const match =
    target.type === "agent"
      ? onHost.find((session) => session.agents.some((agent) => agent.id === target.agentId))
      : onHost.find(
          (session) =>
            session.projectRootPath !== null &&
            isInsideRoot(target.config.cwd, session.projectRootPath),
        );
  return match
    ? { projectViewKey: match.projectViewKey, projectName: match.projectName }
    : { projectViewKey: null, projectName: null };
}

export type BoardColumnId = "running" | "planned" | "done";

export interface LeitstandBoard {
  running: LeitstandSession[];
  planned: LeitstandSchedule[];
  done: LeitstandSession[];
}

const RUNNING_BUCKETS: ReadonlySet<SidebarStateBucket> = new Set([
  "needs_input",
  "failed",
  "running",
]);

function newestFirst(left: LeitstandSession, right: LeitstandSession): number {
  return (right.since?.getTime() ?? 0) - (left.since?.getTime() ?? 0);
}

function nextRunTime(schedule: LeitstandSchedule): number {
  return schedule.schedule.nextRunAt ? Date.parse(schedule.schedule.nextRunAt) : Infinity;
}

/**
 * Sessions still moving (or waiting on you) are "running"; finished ones are "done". "Planned" is
 * every active schedule with a next run. `projectViewKey` null means every project.
 */
export function buildLeitstandBoard(input: {
  sessions: readonly LeitstandSession[];
  schedules: readonly LeitstandSchedule[];
  projectViewKey: string | null;
}): LeitstandBoard {
  const inProject = (key: string | null) =>
    input.projectViewKey === null || key === input.projectViewKey;
  const sessions = input.sessions.filter((session) => inProject(session.projectViewKey));
  return {
    running: sessions.filter((session) => RUNNING_BUCKETS.has(session.bucket)).sort(newestFirst),
    done: sessions.filter((session) => !RUNNING_BUCKETS.has(session.bucket)).sort(newestFirst),
    planned: input.schedules
      .filter(
        (entry) =>
          entry.schedule.status === "active" &&
          entry.schedule.nextRunAt !== null &&
          inProject(entry.projectViewKey),
      )
      .sort((left, right) => nextRunTime(left) - nextRunTime(right)),
  };
}

/** Two-letter tag for a project: initials of its first two words, else its first two letters. */
export function projectMonogram(projectName: string): string {
  const [first = projectName, second] = projectName.split(/[^A-Za-z0-9]+/).filter(Boolean);
  const letters = second ? `${first.charAt(0)}${second.charAt(0)}` : first.slice(0, 2);
  return letters.toUpperCase();
}

export interface PullRequestStack {
  merged: number;
  total: number;
}

export function summarizeStack(pullRequests: readonly LeitstandPullRequest[]): PullRequestStack {
  return {
    merged: pullRequests.filter((pr) => pr.state === "merged").length,
    total: pullRequests.length,
  };
}
