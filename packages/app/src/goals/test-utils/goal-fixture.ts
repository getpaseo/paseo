import type { AgentRun, ChangeSet, Goal, Task } from "@getpaseo/protocol/goal/types";

export const FIXTURE_AT = "2026-10-21T00:00:00.000Z";

export function makeTask(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    description: "",
    kind: "implement",
    dependsOn: [],
    status: "pending",
    attempts: 0,
    summary: null,
    error: null,
    ...overrides,
  };
}

export function makeRun(id: string, taskId: string, overrides: Partial<AgentRun> = {}): AgentRun {
  return {
    id,
    taskId,
    provider: "codex",
    agentId: `agent-${id}`,
    workspaceId: `ws-${id}`,
    status: "running",
    startedAt: FIXTURE_AT,
    endedAt: null,
    error: null,
    ...overrides,
  };
}

export function makeChangeSet(
  id: string,
  taskId: string,
  overrides: Partial<ChangeSet> = {},
): ChangeSet {
  return {
    id,
    taskId,
    runId: `run-${taskId}`,
    round: 0,
    supersedes: null,
    workspaceId: `ws-${taskId}`,
    cwd: "/repo",
    branch: `branch-${taskId}`,
    baseCommit: "base",
    headCommit: "head",
    files: [],
    status: "captured",
    findings: null,
    testSummary: null,
    integratedCommit: null,
    error: null,
    createdAt: FIXTURE_AT,
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}

export function makeGoal(overrides: Partial<Goal> = {}): Goal {
  return {
    id: "goal-1",
    title: "Goal",
    objective: "",
    status: "planning",
    config: {
      cwd: "/repo",
      leadProvider: "claude",
      defaultProvider: "codex",
      maxParallel: 2,
      maxAttempts: 2,
      autoApprovePlan: false,
      notifyLead: true,
    },
    leadAgentId: null,
    leadWorkspaceId: null,
    criteria: [],
    tasks: [],
    runs: [],
    changeSets: [],
    integration: null,
    lastSeq: 1,
    failureReason: null,
    createdAt: FIXTURE_AT,
    updatedAt: FIXTURE_AT,
    ...overrides,
  };
}
