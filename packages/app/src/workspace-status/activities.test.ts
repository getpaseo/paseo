import { describe, expect, it } from "vitest";
import type { WorkspaceActivity } from "@getpaseo/protocol/messages";
import { primaryWorkspaceActivity, summarizeWorkspaceActivities } from "./activities";

const shell: WorkspaceActivity = {
  id: "shell/background",
  pluginId: "shell",
  activityId: "background",
  workspaceId: "ws-1",
  kind: "async-shell",
  label: "Background shells",
  status: "running",
  count: 2,
  icon: "SquareTerminal",
  changedAt: "2026-10-27T12:00:00.000Z",
};

describe("plugin workspace activities", () => {
  it("shows the plugin mark when it owns the effective status", () => {
    expect(
      primaryWorkspaceActivity({
        status: "running",
        activities: [shell],
        primaryActivityId: shell.id,
      }),
    ).toEqual(shell);
    expect(
      primaryWorkspaceActivity({
        status: "needs_input",
        activities: [shell],
        primaryActivityId: shell.id,
      }),
    ).toBeNull();
  });
  it("keeps background work visible while native permission requests take precedence", () => {
    expect(
      summarizeWorkspaceActivities([
        { status: "running", activities: [shell], primaryActivityId: shell.id },
        { status: "needs_input" },
      ]),
    ).toEqual({ primary: null, activities: [shell], count: 2 });
  });
  it("prefers native activity on ties and counts separate hosts without collapsing their ids", () => {
    expect(
      summarizeWorkspaceActivities([
        { status: "running", activities: [shell], primaryActivityId: shell.id },
        { status: "running", activities: [{ ...shell, count: 1 }], primaryActivityId: null },
      ]),
    ).toEqual({ primary: null, activities: [shell, { ...shell, count: 1 }], count: 3 });
  });
  it("returns to an empty presentation when the plugin removes its last activity", () => {
    expect(summarizeWorkspaceActivities([{ status: "done", activities: [] }])).toEqual({
      primary: null,
      activities: [],
      count: 0,
    });
  });
});
