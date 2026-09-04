import { describe, expect, it } from "vitest";
import { formatSince, projectLanes } from "./lanes";
import type { Agent, PermissionRequest, Workspace } from "./types";

function agent(input: Partial<Agent> & { id: string }): Agent {
  return {
    provider: "claude",
    cwd: "/repo",
    workspaceId: "ws_1",
    model: "claude-fable-5-1",
    status: "idle",
    createdAt: "2026-09-04T10:00:00.000Z",
    updatedAt: "2026-09-04T10:00:00.000Z",
    lastUserMessageAt: null,
    pendingPermissions: [],
    title: null,
    labels: {},
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    ...input,
  } as unknown as Agent;
}

const question = {
  id: "perm_q",
  provider: "claude",
  name: "AskUserQuestion",
  kind: "question",
  input: { questions: [{ question: "Which?", header: "Pick", options: [{ label: "A" }] }] },
} as unknown as PermissionRequest;

const workspaces = new Map<string, Workspace>();

describe("projectLanes", () => {
  it("puts a running agent with a pending question in Needs you only", () => {
    const lanes = projectLanes(
      [agent({ id: "a", status: "running", pendingPermissions: [question] })],
      workspaces,
    );
    expect(lanes.needsYou.map((card) => card.reason)).toEqual(["question"]);
    expect(lanes.working).toEqual([]);
    expect(lanes.done).toEqual([]);
  });

  it("rolls a same-workspace subagent's request up into its root", () => {
    const lanes = projectLanes(
      [
        agent({ id: "root", status: "running" }),
        agent({
          id: "child",
          labels: { "paseo.parent-agent-id": "root" },
          pendingPermissions: [question],
        }),
      ],
      workspaces,
    );
    expect(lanes.needsYou).toHaveLength(1);
    expect(lanes.needsYou[0].agent.id).toBe("root");
    expect(lanes.needsYou[0].requestAgentId).toBe("child");
    expect(lanes.needsYou[0].subagentCount).toBe(1);
  });

  it("keeps a cross-workspace subagent as its own card", () => {
    const lanes = projectLanes(
      [
        agent({ id: "root", status: "running" }),
        agent({
          id: "child",
          labels: { "paseo.parent-agent-id": "root" },
          workspaceId: "ws_2",
          status: "running",
        }),
      ],
      workspaces,
    );
    expect(lanes.working.map((card) => card.agent.id).sort()).toEqual(["child", "root"]);
  });

  it("hides idle agents without attention and archived agents", () => {
    const lanes = projectLanes(
      [
        agent({ id: "idle" }),
        agent({
          id: "archived",
          requiresAttention: true,
          attentionReason: "finished",
          archivedAt: "2026-09-04T11:00:00.000Z",
        }),
      ],
      workspaces,
    );
    expect(lanes).toEqual({ needsYou: [], working: [], done: [] });
  });

  it("sorts Needs you oldest first and Done newest first", () => {
    const lanes = projectLanes(
      [
        agent({
          id: "newer",
          requiresAttention: true,
          attentionReason: "error",
          status: "error",
          attentionTimestamp: "2026-09-04T10:05:00.000Z",
        }),
        agent({
          id: "older",
          pendingPermissions: [question],
          attentionTimestamp: "2026-09-04T10:01:00.000Z",
        }),
        agent({
          id: "done-old",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "2026-09-04T09:00:00.000Z",
        }),
        agent({
          id: "done-new",
          requiresAttention: true,
          attentionReason: "finished",
          attentionTimestamp: "2026-09-04T09:30:00.000Z",
        }),
      ],
      workspaces,
    );
    expect(lanes.needsYou.map((card) => card.agent.id)).toEqual(["older", "newer"]);
    expect(lanes.done.map((card) => card.agent.id)).toEqual(["done-new", "done-old"]);
  });

  it("filters to one workspace when asked", () => {
    const lanes = projectLanes(
      [
        agent({ id: "a", status: "running" }),
        agent({ id: "b", status: "running", workspaceId: "ws_2" }),
      ],
      workspaces,
      { workspaceId: "ws_2" },
    );
    expect(lanes.working.map((card) => card.agent.id)).toEqual(["b"]);
  });
});

describe("formatSince", () => {
  const now = Date.parse("2026-09-04T12:00:00.000Z");
  it("formats seconds, minutes, hours, and days", () => {
    expect(formatSince("2026-09-04T11:59:30.000Z", now)).toBe("30s");
    expect(formatSince("2026-09-04T11:40:00.000Z", now)).toBe("20m");
    expect(formatSince("2026-09-04T09:00:00.000Z", now)).toBe("3h");
    expect(formatSince("2026-09-01T12:00:00.000Z", now)).toBe("3d");
    expect(formatSince(null, now)).toBe("");
  });
});
