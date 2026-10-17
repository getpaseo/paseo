import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import { resolveSchedule, scheduleBucket, type ScheduleTargetAgent } from "./schedule-derivation";
import {
  buildScheduleProjectTargets,
  buildScheduleWorkspaceIndex,
  canJudgeWorkspaceMissing,
  type ScheduleWorkspaceRef,
} from "./schedule-project-targets";

const NOW = Date.parse("2026-07-02T00:00:00.000Z");
const AGENT_ID = "00000000-0000-4000-8000-000000000000";

function makeSchedule(overrides: Partial<ScheduleSummary>): ScheduleSummary {
  return {
    id: "schedule-1",
    name: "Nightly",
    prompt: "Run the task",
    cadence: { type: "every", everyMs: 60_000 },
    target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp/project" } },
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    nextRunAt: "2026-07-02T01:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: null,
    ...overrides,
  };
}

function resolve(
  schedule: ScheduleSummary,
  options?: {
    agents?: Array<[string, ScheduleTargetAgent]>;
    projects?: Array<[string, string]>;
    workspaces?: Array<[string, ScheduleWorkspaceRef]>;
    agentDataLoaded?: boolean;
    workspaceDataLoaded?: boolean;
  },
) {
  return resolveSchedule({
    schedule,
    serverId: "host-1",
    now: NOW,
    agentsByKey: new Map(options?.agents ?? []),
    projectNameByCwd: new Map(options?.projects ?? []),
    agentDataLoaded: options?.agentDataLoaded ?? true,
    workspacesByKey: new Map(options?.workspaces ?? []),
    workspaceDataLoaded: options?.workspaceDataLoaded ?? true,
  });
}

function makeWorkspaceSchedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return makeSchedule({
    target: {
      type: "new-agent",
      config: { provider: "codex", cwd: "/tmp/project", workspaceId: "wks_report" },
    },
    ...overrides,
  });
}

const REPORT_WORKSPACE: Array<[string, ScheduleWorkspaceRef]> = [
  ["host-1:wks_report", { name: "Weekly report", projectName: "Project A" }],
];

describe("resolveSchedule state", () => {
  it("keeps active and paused schedules runnable", () => {
    expect(resolve(makeSchedule({ status: "active" })).state).toBe("active");
    expect(resolve(makeSchedule({ status: "paused" })).state).toBe("paused");
    expect(scheduleBucket("active")).toBe("runnable");
    expect(scheduleBucket("paused")).toBe("runnable");
  });

  it("treats a past expiresAt as expired regardless of status", () => {
    const result = resolve(
      makeSchedule({ status: "active", expiresAt: "2026-07-01T00:00:00.000Z" }),
    );
    expect(result.state).toBe("expired");
    expect(result.bucket).toBe("ended");
  });

  it("ignores an unparseable expiresAt", () => {
    expect(resolve(makeSchedule({ expiresAt: "not-a-date" })).state).toBe("active");
  });

  it("derives finished only from completed-and-not-expired", () => {
    expect(resolve(makeSchedule({ status: "completed" })).state).toBe("finished");
    expect(
      resolve(makeSchedule({ status: "completed", expiresAt: "2026-07-01T00:00:00.000Z" })).state,
    ).toBe("expired");
  });

  it("marks an agent target gone when the client has no such agent", () => {
    const schedule = makeSchedule({ target: { type: "agent", agentId: AGENT_ID } });
    expect(resolve(schedule).state).toBe("targetGone");
    expect(resolve(schedule).bucket).toBe("ended");
  });

  it("does not claim gone before the agent directory has loaded", () => {
    const schedule = makeSchedule({ target: { type: "agent", agentId: AGENT_ID } });
    expect(resolve(schedule, { agentDataLoaded: false }).state).toBe("active");
  });

  it("prefers target-gone over the raw paused/completed status for a live agent target", () => {
    const paused = makeSchedule({
      status: "paused",
      target: { type: "agent", agentId: AGENT_ID },
    });
    expect(resolve(paused).state).toBe("targetGone");
  });

  it("never claims a new-agent cwd is gone", () => {
    expect(resolve(makeSchedule({ status: "active" })).state).toBe("active");
  });
});

describe("resolveSchedule workspace target", () => {
  it("stays active while the bound workspace exists", () => {
    const result = resolve(makeWorkspaceSchedule(), { workspaces: REPORT_WORKSPACE });
    expect(result.state).toBe("active");
    expect(result.target).toEqual({ label: "Weekly report · Project A", provider: "codex" });
  });

  it("marks the target gone when the loaded workspace list lacks the bound workspace", () => {
    const result = resolve(makeWorkspaceSchedule());
    expect(result.state).toBe("targetGone");
    expect(result.bucket).toBe("ended");
    expect(result.target).toEqual({ label: "Workspace unavailable", provider: "codex" });
  });

  it("does not claim the workspace is gone before workspaces have loaded", () => {
    const result = resolve(makeWorkspaceSchedule(), { workspaceDataLoaded: false });
    expect(result.state).toBe("active");
    expect(result.target.label).toBe("/tmp/project");
  });

  it("keeps showing target gone after the daemon ended the schedule", () => {
    const completed = makeWorkspaceSchedule({ status: "completed", nextRunAt: null });
    expect(resolve(completed).state).toBe("targetGone");
    expect(resolve(completed, { workspaces: REPORT_WORKSPACE }).state).toBe("finished");
  });

  it("returns to active once the workspace is restored", () => {
    const schedule = makeWorkspaceSchedule();
    expect(resolve(schedule).state).toBe("targetGone");
    expect(resolve(schedule, { workspaces: REPORT_WORKSPACE }).state).toBe("active");
  });

  it("shows target gone on an online host with no projects, but not on an offline one", () => {
    // Fed the way the Schedules screen feeds it: the host has no projects, so the workspace index
    // is empty, and whether that counts as gone depends on the host being online and loaded.
    const emptyIndex = buildScheduleWorkspaceIndex(buildScheduleProjectTargets([]));
    const resolveOnHost = (input: { workspacesLoaded: boolean; hostOnline: boolean }) =>
      resolveSchedule({
        schedule: makeWorkspaceSchedule(),
        serverId: "host-1",
        now: NOW,
        agentsByKey: new Map(),
        projectNameByCwd: new Map(),
        agentDataLoaded: true,
        workspacesByKey: emptyIndex,
        workspaceDataLoaded: canJudgeWorkspaceMissing(input),
      });

    expect(resolveOnHost({ workspacesLoaded: true, hostOnline: true })).toMatchObject({
      state: "targetGone",
      workspaceUnavailable: true,
      target: { label: "Workspace unavailable" },
    });
    expect(resolveOnHost({ workspacesLoaded: true, hostOnline: false })).toMatchObject({
      state: "active",
      workspaceUnavailable: false,
    });
    expect(resolveOnHost({ workspacesLoaded: false, hostOnline: true })).toMatchObject({
      state: "active",
      workspaceUnavailable: false,
    });
  });

  it("reports an unavailable workspace whatever the badge says, and only once it is known gone", () => {
    const expired = makeWorkspaceSchedule({ expiresAt: "2026-07-01T00:00:00.000Z" });
    expect(resolve(expired).state).toBe("expired");
    expect(resolve(expired).workspaceUnavailable).toBe(true);

    expect(resolve(makeWorkspaceSchedule(), { workspaces: REPORT_WORKSPACE })).toMatchObject({
      workspaceUnavailable: false,
    });
    expect(resolve(makeWorkspaceSchedule(), { workspaceDataLoaded: false })).toMatchObject({
      workspaceUnavailable: false,
    });
    expect(resolve(makeSchedule({}))).toMatchObject({ workspaceUnavailable: false });
  });
});

describe("resolveSchedule target line", () => {
  it("names an agent target by its client title and provider", () => {
    const schedule = makeSchedule({ target: { type: "agent", agentId: AGENT_ID } });
    const result = resolve(schedule, {
      agents: [[`host-1:${AGENT_ID}`, { title: "Fix build", provider: "claude" }]],
    });
    expect(result.target).toEqual({ label: "Fix build", provider: "claude" });
    expect(result.state).toBe("active");
  });

  it("falls back to Untitled agent when the agent has no title", () => {
    const schedule = makeSchedule({ target: { type: "agent", agentId: AGENT_ID } });
    const result = resolve(schedule, {
      agents: [[`host-1:${AGENT_ID}`, { title: "  ", provider: "codex" }]],
    });
    expect(result.target.label).toBe("Untitled agent");
  });

  it("labels a gone agent target as unavailable with no glyph", () => {
    const schedule = makeSchedule({ target: { type: "agent", agentId: AGENT_ID } });
    expect(resolve(schedule).target).toEqual({ label: "Agent unavailable", provider: null });
  });

  it("names a new-agent cwd by matched project, else the shortened path", () => {
    const matched = makeSchedule({
      target: { type: "new-agent", config: { provider: "codex", cwd: "/tmp/project" } },
    });
    expect(resolve(matched, { projects: [["host-1:/tmp/project", "My Project"]] }).target).toEqual({
      label: "My Project",
      provider: "codex",
    });

    const unmatched = makeSchedule({
      target: { type: "new-agent", config: { provider: "codex", cwd: "/Users/alex/work/api" } },
    });
    expect(resolve(unmatched).target).toEqual({ label: "~/work/api", provider: "codex" });
  });
});
