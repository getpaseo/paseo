import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import type { ProjectSummary } from "@/utils/projects";
import { buildShareTargetRows, rankShareTargetRows } from "./targets";

function agent(input: {
  id: string;
  title: string;
  workspaceId: string;
  lastActivityAt: Date;
}): AggregatedAgent {
  return {
    id: input.id,
    serverId: "host-1",
    serverLabel: "Laptop",
    title: input.title,
    status: "idle",
    lastActivityAt: input.lastActivityAt,
    cwd: "/Users/me/code/paseo",
    workspaceId: input.workspaceId,
    provider: "claude",
    pendingPermissionCount: 0,
    requiresAttention: false,
    archivedAt: null,
    createdAt: input.lastActivityAt,
    labels: {},
  } as AggregatedAgent;
}

const projects = [
  {
    viewKey: "project:paseo",
    projectName: "paseo",
    hosts: [
      {
        serverId: "host-1",
        serverName: "Laptop",
        workspaces: [
          {
            id: "ws-main",
            name: "main",
            title: "Main checkout",
            currentBranch: "main",
            statusEnteredAt: new Date("2026-11-01T00:00:00Z"),
          },
          {
            id: "ws-old",
            name: "old",
            currentBranch: "old",
            archivingAt: "2026-11-02T00:00:00Z",
            statusEnteredAt: new Date("2026-11-02T00:00:00Z"),
          },
        ],
      },
    ],
  },
] as unknown as ProjectSummary[];

describe("share target rows", () => {
  const rows = buildShareTargetRows({
    agents: [
      agent({
        id: "a-1",
        title: "Fix login",
        workspaceId: "ws-main",
        lastActivityAt: new Date("2026-11-03T00:00:00Z"),
      }),
      agent({
        id: "a-2",
        title: "Write release notes",
        workspaceId: "ws-main",
        lastActivityAt: new Date("2026-11-05T00:00:00Z"),
      }),
    ],
    projects,
    showHost: false,
    agentTitle: (entry) => entry.title ?? "Untitled",
  });

  it("offers agents under their workspace and skips workspaces being archived", () => {
    expect(rows.agents.map((row) => [row.title, row.subtitle])).toEqual([
      ["Fix login", "Main checkout"],
      ["Write release notes", "Main checkout"],
    ]);
    expect(rows.workspaces.map((row) => [row.title, row.subtitle])).toEqual([
      ["Main checkout", "paseo · main"],
    ]);
    expect(rows.workspaces[0]?.target).toEqual({
      kind: "workspace",
      serverId: "host-1",
      workspaceId: "ws-main",
    });
  });

  it("lists the most recent agents first and narrows them by search", () => {
    expect(rankShareTargetRows(rows, "").agents.map((row) => row.title)).toEqual([
      "Write release notes",
      "Fix login",
    ]);
    expect(rankShareTargetRows(rows, "login").agents.map((row) => row.title)).toEqual([
      "Fix login",
    ]);
  });
});
