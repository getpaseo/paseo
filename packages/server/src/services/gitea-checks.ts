import { z } from "zod";
import { normalizeHost } from "@getpaseo/protocol/git-remote";

// 50 is the page-size cap Gitea enforces on list endpoints; five pages bounds
// the sweep to the 250 most recent Actions tasks.
export const GITEA_ACTION_PAGE_LIMIT = 50;
export const GITEA_ACTION_MAX_PAGES = 5;

const GITEA_RELATIVE_URL_ORIGIN = "https://gitea.invalid";

export const GiteaLoginSchema = z
  .object({
    name: z.string().optional(),
    url: z.string().optional(),
    ssh_host: z.string().optional(),
  })
  .passthrough();

export const GiteaCommitStatusSchema = z
  .object({
    id: z.number(),
    status: z.string(),
    target_url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    context: z.string().optional().default(""),
    creator: z.unknown().nullable().optional(),
  })
  .passthrough();

export const GiteaCombinedCommitStatusSchema = z
  .object({
    state: z.string().optional().default(""),
    sha: z.string().optional(),
    total_count: z.number().optional(),
    statuses: z
      .array(GiteaCommitStatusSchema)
      .nullable()
      .optional()
      .transform((value) => value ?? []),
  })
  .passthrough();

export const GiteaActionTaskSchema = z
  .object({
    id: z.number(),
    name: z.string().nullable().optional(),
    head_branch: z.string().nullable().optional(),
    head_sha: z.string(),
    run_number: z.number().optional(),
    event: z.string().nullable().optional(),
    display_title: z.string().nullable().optional(),
    status: z.string(),
    need_approval: z.boolean().optional().default(false),
    workflow_id: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    run_started_at: z.string().nullable().optional(),
  })
  .passthrough();

// The item shape is validated per-task rather than as `z.array(GiteaActionTaskSchema)`
// so one malformed task (missing id/status/head_sha) drops only itself instead of
// throwing out the whole page and zeroing every Actions check for the PR.
export const GiteaActionsListResponseSchema = z
  .object({
    workflow_runs: z
      .array(z.unknown())
      .nullable()
      .optional()
      .transform((value) => value ?? []),
    total_count: z.number().optional(),
  })
  .passthrough();

export type GiteaCommitStatus = z.infer<typeof GiteaCommitStatusSchema>;
export type GiteaCombinedCommitStatus = z.infer<typeof GiteaCombinedCommitStatusSchema>;
export type GiteaActionTask = z.infer<typeof GiteaActionTaskSchema>;

export function getGiteaActionTaskName(task: GiteaActionTask): string {
  return task.name || task.display_title || task.workflow_id || `actions-${task.id}`;
}

export function getUrlOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function getGiteaActionRunIdFromUrl(value: string | null | undefined): number | null {
  if (!value) return null;
  try {
    const url = new URL(value, GITEA_RELATIVE_URL_ORIGIN);
    const match = url.pathname.match(/\/actions\/runs\/(\d+)(?:\/jobs\/\d+)?\/?$/);
    return match?.[1] ? Number.parseInt(match[1], 10) : null;
  } catch {
    return null;
  }
}

function isNativeActionJobUrl(
  targetUrl: string | null | undefined,
  nativeOrigins: ReadonlySet<string>,
  nativeRunIds: ReadonlySet<number>,
): boolean {
  if (!targetUrl) return false;
  try {
    const url = new URL(targetUrl, GITEA_RELATIVE_URL_ORIGIN);
    if (!/\/actions\/runs\/\d+\/jobs\/\d+\/?$/.test(url.pathname)) return false;
    if (url.origin !== GITEA_RELATIVE_URL_ORIGIN && !nativeOrigins.has(url.origin)) return false;
    const runId = getGiteaActionRunIdFromUrl(targetUrl);
    return runId !== null && nativeRunIds.has(runId);
  } catch {
    return false;
  }
}

// A "shadow" is the commit status Gitea synthesizes to mirror one of its own
// Actions jobs; keeping both would double-report every job. Detection is purely
// structural: Gitea always creates these statuses with a target_url of the form
// "<run link>/jobs/<job id>" (services/actions/commit_status.go upstream), so a
// status is a shadow exactly when its URL points at a job of a run we actually
// fetched from the Actions API. Anything else - external CI, URL-less statuses,
// contexts that merely look like "<workflow> / <job> (<event>)" - is kept.
export function isGiteaActionShadowStatus(
  status: GiteaCommitStatus,
  nativeOrigins: ReadonlySet<string>,
  nativeRunIds: ReadonlySet<number>,
): boolean {
  return isNativeActionJobUrl(status.target_url, nativeOrigins, nativeRunIds);
}

function getGiteaActionWorkflowIdentity(task: GiteaActionTask): string {
  if (task.workflow_id) {
    return `workflow\u0000${task.workflow_id}`;
  }
  // Instances that omit workflow_id (older Gitea/Forgejo payloads) still need
  // reruns of the same job collapsed to the latest execution, so fall back to
  // the job name before treating the task as its own group.
  const name = task.name || task.display_title;
  if (name) {
    return `name\u0000${name}`;
  }
  return `task\u0000${getGiteaActionExecutionIdentity(task)}`;
}

function getGiteaActionExecutionIdentity(task: GiteaActionTask): string {
  if (task.run_number !== undefined) return `run-number\u0000${task.run_number}`;
  const runId = getGiteaActionRunIdFromUrl(task.url);
  if (runId !== null) return `run-id\u0000${runId}`;
  if (task.url) return `url\u0000${task.url}`;
  return `task\u0000${task.id}`;
}

function parseGiteaActionTaskTime(task: GiteaActionTask): number {
  const timestamp = task.created_at ?? task.run_started_at ?? null;
  if (!timestamp) {
    return 0;
  }
  const time = Date.parse(timestamp);
  return Number.isNaN(time) ? 0 : time;
}

function compareGiteaActionTaskRecency(left: GiteaActionTask, right: GiteaActionTask): number {
  const leftRunNumber = left.run_number ?? 0;
  const rightRunNumber = right.run_number ?? 0;
  if (leftRunNumber !== rightRunNumber) {
    return leftRunNumber - rightRunNumber;
  }

  const leftTime = parseGiteaActionTaskTime(left);
  const rightTime = parseGiteaActionTaskTime(right);
  if (leftTime !== rightTime) {
    return leftTime - rightTime;
  }

  return left.id - right.id;
}

export function parseGiteaActionTasks(rawTasks: unknown[]): GiteaActionTask[] {
  const tasks: GiteaActionTask[] = [];
  for (const raw of rawTasks) {
    const parsed = GiteaActionTaskSchema.safeParse(raw);
    if (parsed.success) {
      tasks.push(parsed.data);
    }
  }
  return tasks;
}

/**
 * Keep all sibling tasks from the latest execution of each workflow.
 * Per docs/forge-providers.md, ambiguous same-run tasks are preserved because
 * display names are not stable job identities and `/actions/tasks` omits rerun
 * attempt numbers.
 */
export function latestGiteaActionTasksByWorkflow(tasks: GiteaActionTask[]): GiteaActionTask[] {
  const latestExecutions = new Map<string, GiteaActionTask>();
  for (const task of tasks) {
    const identity = getGiteaActionWorkflowIdentity(task);
    const current = latestExecutions.get(identity);
    if (!current || compareGiteaActionTaskRecency(current, task) < 0) {
      latestExecutions.set(identity, task);
    }
  }
  return tasks.filter((task) => {
    const latest = latestExecutions.get(getGiteaActionWorkflowIdentity(task));
    return (
      latest !== undefined &&
      getGiteaActionExecutionIdentity(task) === getGiteaActionExecutionIdentity(latest)
    );
  });
}

function parseTeaLogins(stdout: string): z.infer<typeof GiteaLoginSchema>[] {
  try {
    return z.array(GiteaLoginSchema).safeParse(JSON.parse(stdout)).data ?? [];
  } catch {
    return [];
  }
}

export function findTeaLoginNameForBaseUrl(stdout: string, baseUrl: string): string | null {
  const match = parseTeaLogins(stdout).find((login) => {
    if (!login.name || !login.url) return false;
    try {
      const url = new URL(login.url);
      return `${url.origin}${url.pathname.replace(/\/+$/, "")}` === baseUrl;
    } catch {
      return false;
    }
  });
  return match?.name ?? null;
}

export function extractCandidateHost(candidate: string | undefined): string | null {
  if (!candidate) {
    return null;
  }
  const trimmed = candidate.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.includes("://")) {
    try {
      return normalizeHost(new URL(trimmed).hostname);
    } catch {
      // ignore malformed login url
    }
  }
  const withoutUser = trimmed.includes("@") ? trimmed.slice(trimmed.indexOf("@") + 1) : trimmed;
  const hostAndPort = withoutUser.split("/")[0] ?? "";
  if (hostAndPort.startsWith("[")) {
    const closing = hostAndPort.indexOf("]");
    if (closing > 0) {
      return normalizeHost(hostAndPort.slice(1, closing));
    }
  }
  const parts = hostAndPort.split(":");
  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return normalizeHost(parts[0]);
  }
  return normalizeHost(hostAndPort);
}

export function findTeaLoginNameForHost(stdout: string, host: string): string | null {
  const targetHost = normalizeHost(host);
  const match = parseTeaLogins(stdout).find((login) => {
    const candidates = [login.ssh_host, login.name];
    if (login.url) {
      try {
        candidates.push(new URL(login.url).hostname);
      } catch {
        // ignore malformed login url
      }
    }
    return candidates.some((candidate) => {
      if (!candidate) {
        return false;
      }
      if (candidate.toLowerCase() === targetHost) {
        return true;
      }
      return extractCandidateHost(candidate) === targetHost;
    });
  });
  return match?.name ?? null;
}
