import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { groupArchivedWorkspaces } from "./group";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const minutes = (count: number) => new Date(T0 + count * 60_000);

function historyAgent(input: {
  id: string;
  serverId?: string;
  workspaceId?: string | null;
  title?: string | null;
  activeAt: number;
  archivedAt?: number | null;
  workspaceName?: string | null;
  branch?: string | null;
  cwd?: string;
}): AggregatedAgent {
  const cwd = input.cwd ?? "/repos/payments";
  return {
    id: input.id,
    serverId: input.serverId ?? "host-a",
    serverLabel: input.serverId ?? "host-a",
    title: input.title ?? null,
    status: "closed",
    turn: { phase: "open", turnId: null, startedAt: null, cancellationRequestId: null },
    lastActivityAt: minutes(input.activeAt),
    cwd,
    workspaceId: input.workspaceId === undefined ? "ws-1" : input.workspaceId,
    provider: "claude",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: input.archivedAt == null ? null : minutes(input.archivedAt),
    createdAt: minutes(0),
    labels: {},
    projectPlacement: {
      projectKey: "prj-payments",
      projectName: "payments",
      workspaceName: input.workspaceName === undefined ? "Billing cleanup" : input.workspaceName,
      checkout: {
        cwd,
        isGit: true,
        currentBranch: input.branch === undefined ? "billing-cleanup" : input.branch,
        remoteUrl: null,
        worktreeRoot: cwd,
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
  } as AggregatedAgent;
}

const NO_ACTIVE = new Map<string, ReadonlySet<string>>();

describe("groupArchivedWorkspaces", () => {
  it("folds a workspace's agents into one entry led by its most recent agent", () => {
    const [workspace] = groupArchivedWorkspaces({
      agents: [
        historyAgent({ id: "older", title: "Audit invoices", activeAt: 1, archivedAt: 5 }),
        historyAgent({ id: "newer", title: "Fix totals", activeAt: 3, archivedAt: 4 }),
      ],
      activeIds: NO_ACTIVE,
    });

    expect(workspace).toMatchObject({
      key: "host-a:ws-1",
      serverId: "host-a",
      workspaceId: "ws-1",
      name: "Billing cleanup",
      projectName: "payments",
      projectKey: "prj-payments",
      branch: "billing-cleanup",
      archivedAt: minutes(5),
    });
    expect(workspace.agents.map((agent) => agent.id)).toEqual(["newer", "older"]);
  });

  it("leaves out workspaces that are still active on their host", () => {
    const workspaces = groupArchivedWorkspaces({
      agents: [historyAgent({ id: "a", activeAt: 1, archivedAt: 2 })],
      activeIds: new Map([["host-a", new Set(["ws-1"])]]),
    });

    expect(workspaces).toEqual([]);
  });

  it("leaves out an inactive workspace none of whose agents were archived", () => {
    const workspaces = groupArchivedWorkspaces({
      agents: [historyAgent({ id: "a", activeAt: 1, archivedAt: null })],
      activeIds: NO_ACTIVE,
    });

    expect(workspaces).toEqual([]);
  });

  it("keeps the same workspace ID on two hosts apart and lists the latest archive first", () => {
    const workspaces = groupArchivedWorkspaces({
      agents: [
        historyAgent({ id: "a", serverId: "host-a", activeAt: 1, archivedAt: 2 }),
        historyAgent({ id: "b", serverId: "host-b", activeAt: 1, archivedAt: 9 }),
      ],
      activeIds: NO_ACTIVE,
    });

    expect(workspaces.map((workspace) => workspace.key)).toEqual(["host-b:ws-1", "host-a:ws-1"]);
  });

  it("skips agents with no workspace and names an unnamed workspace after its folder", () => {
    const workspaces = groupArchivedWorkspaces({
      agents: [
        historyAgent({ id: "loose", workspaceId: null, activeAt: 1, archivedAt: 2 }),
        historyAgent({
          id: "a",
          workspaceName: null,
          branch: null,
          cwd: "/repos/receipts",
          activeAt: 1,
          archivedAt: 2,
        }),
      ],
      activeIds: NO_ACTIVE,
    });

    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]).toMatchObject({ name: "receipts", branch: null });
  });
});
