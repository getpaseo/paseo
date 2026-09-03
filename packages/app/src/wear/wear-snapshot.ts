import type { Agent, WorkspaceDescriptor } from "@/stores/session-store";
import {
  WEAR_PROTOCOL_VERSION,
  type WearAgent,
  type WearAgentState,
  type WearSnapshot,
  type WearWorkspace,
} from "./wear-protocol";

/**
 * Upper bound on what we push to the watch.
 *
 * A DataItem has a hard ~100 KB limit and the watch shows three rows at a time, so
 * sending hundreds of workspaces would be both fragile and pointless. Workspaces are
 * ranked before truncation, so the ones that get cut are always the least urgent.
 */
const MAX_WORKSPACES = 24;
const MAX_AGENTS_PER_WORKSPACE = 8;
const MAX_SUMMARY_LENGTH = 160;
const MAX_PERMISSION_DETAIL_LENGTH = 200;

export interface WearSnapshotInput {
  serverId: string;
  agents: Agent[];
  workspaces: Map<string, WorkspaceDescriptor>;
}

/** "12m", "2h", "3d" — the watch renders this verbatim. */
export function formatAge(from: Date, now: number): string {
  const seconds = Math.max(0, Math.floor((now - from.getTime()) / 1000));
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function agentState(agent: Agent): WearAgentState {
  if (agent.pendingPermissions.length > 0) return "needsInput";
  // requiresAttention covers finished/error too, but only "permission" is
  // actionable from the wrist. Everything else reads as its lifecycle status so the
  // watch never shows an urgent dot for something it can't resolve.
  if (agent.status === "running" || agent.status === "initializing") return "running";
  return "idle";
}

/**
 * Providers are stored as ids (`claude`, `codex`); the watch shows them as the
 * agent row's primary line, so they need to be presentable.
 */
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  copilot: "Copilot",
  opencode: "OpenCode",
  pi: "Pi",
  omp: "Oh My Pi",
};

export function providerLabel(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1);
}

function truncate(value: string, max: number): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max - 1)}…`;
}

/**
 * Turn a pending permission into the two strings the watch renders.
 *
 * The watch shows `detail` as the thing being approved, so it must be the most
 * specific text available — a bare tool name like "Bash" is not enough to approve
 * against.
 */
function permissionFor(agent: Agent): WearAgent["permission"] {
  const request = agent.pendingPermissions[0];
  if (!request) return undefined;

  const input = request.input ?? {};
  // Most-specific-first: the command being run beats a path, which beats a
  // description, which beats the bare tool name. Approving "Bash" tells the user
  // nothing.
  const specific = ["command", "file_path", "path"]
    .map((key) => input[key])
    .find((value): value is string => typeof value === "string");

  const detail = specific ?? request.description ?? request.title ?? request.name;
  const normalizedDetail = detail.replace(/\s+/g, " ").trim();
  // A watch can authorize this request by id, but it cannot expand a truncated
  // operation. Omit oversized approvals rather than hiding a destructive suffix
  // or letting one command overflow the whole snapshot DataItem.
  if (normalizedDetail.length > MAX_PERMISSION_DETAIL_LENGTH) {
    return undefined;
  }

  return {
    id: request.id,
    title: request.title ?? titleForKind(request.kind, request.name),
    // Authorization is keyed by request id, so the watch must show the complete
    // operation rather than a misleading prefix that hides a destructive suffix.
    detail: normalizedDetail,
  };
}

function titleForKind(kind: string, name: string): string {
  switch (kind) {
    case "tool":
      return name === "Bash" ? "Run command?" : `Allow ${name}?`;
    case "plan":
      return "Approve plan?";
    case "question":
      return "Question";
    case "mode":
      return "Change mode?";
    default:
      return "Approval needed";
  }
}

/** Sort priority: needs-attention first, then running, then idle. */
const STATE_RANK: Record<WearAgentState, number> = {
  needsInput: 0,
  running: 1,
  idle: 2,
};

function rank(state: WearAgentState): number {
  return STATE_RANK[state];
}

/**
 * Flatten one daemon's agents and workspaces into the watch's view.
 *
 * Iterates WORKSPACES, not agents. Grouping by agent silently dropped every
 * workspace that had none, which broke two things: the design's empty-workspace
 * row ("no agents · tap to start") and its whole 0-agents-goes-straight-to-voice
 * navigation rule. Worse, with no agents running anywhere the snapshot came out
 * completely empty and the watch sat on its "open Paseo on your phone" screen as
 * though the bridge were down.
 *
 * Agents whose workspace we don't know about are still dropped rather than shown
 * under a synthetic parent: the watch's whole model is workspace-first, and a
 * workspace with a made-up name would be worse than an absent row.
 */
export function buildWearWorkspaces(input: WearSnapshotInput, now: number): WearWorkspace[] {
  const byWorkspace = new Map<string, WearAgent[]>();

  for (const agent of input.agents) {
    if (agent.archivedAt) continue;
    const workspaceId = agent.workspaceId;
    if (!workspaceId || !input.workspaces.has(workspaceId)) continue;

    const summary = agent.title ? truncate(agent.title, MAX_SUMMARY_LENGTH) : undefined;
    const entry: WearAgent = {
      id: agent.id,
      provider: providerLabel(agent.provider),
      state: agentState(agent),
      age: formatAge(agent.lastActivityAt, now),
      ...(summary ? { summary } : {}),
      ...(() => {
        const permission = permissionFor(agent);
        return permission ? { permission } : {};
      })(),
    };

    const bucket = byWorkspace.get(workspaceId);
    if (bucket) {
      bucket.push(entry);
    } else {
      byWorkspace.set(workspaceId, [entry]);
    }
  }

  const workspaces: WearWorkspace[] = [];
  for (const [workspaceId, descriptor] of input.workspaces) {
    // A workspace mid-archive is on its way out; showing it invites a reply to an
    // agent whose cwd is about to disappear.
    if (descriptor.archivingAt) continue;

    const agents = byWorkspace.get(workspaceId) ?? [];
    agents.sort((left, right) => rank(left.state) - rank(right.state));

    workspaces.push({
      id: workspaceId,
      name: descriptor.name,
      // projectKey drives the icon color on the watch, and must match what the phone
      // uses. Fall back to projectId so the color is at least stable per project.
      projectKey: descriptor.project?.projectKey ?? descriptor.projectId,
      projectName:
        descriptor.projectCustomName ??
        descriptor.project?.projectName ??
        descriptor.projectDisplayName,
      serverId: input.serverId,
      agents: agents.slice(0, MAX_AGENTS_PER_WORKSPACE),
    });
  }

  return workspaces;
}

function workspaceRank(workspace: WearWorkspace): number {
  return workspace.agents.reduce((worst, agent) => Math.min(worst, rank(agent.state)), 3);
}

/**
 * Build the full snapshot across every connected daemon.
 *
 * Sorting happens here rather than on the watch so that truncation drops the least
 * urgent workspaces; the watch re-sorts anyway, but it can only sort what it got.
 */
export function buildWearSnapshot(inputs: WearSnapshotInput[], now: number): WearSnapshot {
  const workspaces = inputs.flatMap((input) => buildWearWorkspaces(input, now));

  workspaces.sort((left, right) => {
    const byUrgency = workspaceRank(left) - workspaceRank(right);
    if (byUrgency !== 0) return byUrgency;
    return left.name.localeCompare(right.name);
  });

  return {
    v: WEAR_PROTOCOL_VERSION,
    updatedAt: now,
    workspaces: workspaces.slice(0, MAX_WORKSPACES),
  };
}
