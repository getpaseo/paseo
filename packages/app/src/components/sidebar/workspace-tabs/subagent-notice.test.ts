import { describe, expect, it } from "vitest";
import type { ProviderSubagentDescriptorPayload } from "@getpaseo/protocol/messages";
import {
  moreUrgentDisclosureNotice,
  noticeForIndexedChild,
  noticeForPaseoAgent,
  noticeForProviderSubagent,
  paseoDisclosureNotice,
  providerDisclosureNotice,
  subagentRowNotice,
  type DisclosureNoticeAgent,
} from "./subagent-notice";

function agent(extra: Partial<DisclosureNoticeAgent> = {}): DisclosureNoticeAgent {
  return {
    id: "child",
    serverId: "s",
    workspaceId: "review",
    labels: { "paseo.parent-agent-id": "parent" },
    status: "idle",
    turnOpen: false,
    pendingPermissionCount: 0,
    requiresAttention: false,
    attentionReason: null,
    ...extra,
  };
}

describe("noticeForPaseoAgent", () => {
  it("marks a permission as needs input", () => {
    expect(noticeForPaseoAgent(agent({ pendingPermissionCount: 1 }), null)).toBe("needs_input");
  });

  it("marks unread finished work as attention and an unread error as failed", () => {
    expect(
      noticeForPaseoAgent(agent({ requiresAttention: true, attentionReason: "finished" }), null),
    ).toBe("attention");
    expect(
      noticeForPaseoAgent(
        agent({ status: "error", requiresAttention: true, attentionReason: "error" }),
        null,
      ),
    ).toBe("failed");
  });

  it("keeps a nested workspace's unread mark after the agent's attention is cleared", () => {
    expect(noticeForPaseoAgent(agent(), "attention")).toBe("attention");
  });

  it("ignores a subagent that is working or idle", () => {
    expect(noticeForPaseoAgent(agent({ status: "running" }), null)).toBeNull();
    expect(noticeForPaseoAgent(agent({ turnOpen: true }), null)).toBeNull();
    expect(noticeForPaseoAgent(agent(), null)).toBeNull();
  });

  it("prefers needs input over attention", () => {
    expect(moreUrgentDisclosureNotice("attention", "needs_input")).toBe("needs_input");
  });
});

describe("paseoDisclosureNotice", () => {
  const statuses = new Map<string, "attention" | "done">([["s:review", "attention"]]);

  it("uses a nested workspace's status and ignores the workspace the tab already shows", () => {
    const nested = paseoDisclosureNotice({
      listingServerId: "s",
      listingWorkspaceId: "main",
      parentAgentIds: new Set(["parent"]),
      agents: [agent()],
      pendingArchiveIds: new Set(),
      workspaceStatus: (serverId, workspaceId) =>
        statuses.get(`${serverId}:${workspaceId}`) ?? null,
    });
    const shared = paseoDisclosureNotice({
      listingServerId: "s",
      listingWorkspaceId: "review",
      parentAgentIds: new Set(["parent"]),
      agents: [agent()],
      pendingArchiveIds: new Set(),
      workspaceStatus: (serverId, workspaceId) =>
        statuses.get(`${serverId}:${workspaceId}`) ?? null,
    });
    expect(nested).toBe("attention");
    expect(shared).toBeNull();
  });

  it("skips archived, background, and unrelated agents", () => {
    expect(
      paseoDisclosureNotice({
        listingServerId: "s",
        listingWorkspaceId: "main",
        parentAgentIds: new Set(["parent"]),
        agents: [
          agent({ archivedAt: new Date(), requiresAttention: true, attentionReason: "finished" }),
          agent({ id: "bg", background: true, pendingPermissionCount: 1 }),
          agent({ id: "pending", requiresAttention: true, attentionReason: "finished" }),
          agent({ id: "other", labels: { "paseo.parent-agent-id": "someone" } }),
        ],
        pendingArchiveIds: new Set(["s:pending"]),
        workspaceStatus: () => "needs_input",
      }),
    ).toBeNull();
  });
});

describe("providerDisclosureNotice", () => {
  function descriptor(
    status: ProviderSubagentDescriptorPayload["status"],
  ): ProviderSubagentDescriptorPayload {
    return {
      id: "sub",
      parentAgentId: "parent",
      parentSubagentId: null,
      provider: "codex",
      title: null,
      description: null,
      status,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      toolCallId: null,
    };
  }

  it("marks a failed provider subagent and ignores one that is still running", () => {
    expect(noticeForProviderSubagent("failed")).toBe("failed");
    expect(noticeForProviderSubagent("running")).toBeNull();
    expect(
      providerDisclosureNotice({
        serverId: "s",
        parentAgentIds: new Set(["parent"]),
        descriptors: [["s\0parent\0sub", descriptor("failed")]],
        hiddenFromTrack: new Set(),
        nestingSupported: true,
      }),
    ).toBe("failed");
  });

  it("ignores a provider subagent hidden from the list", () => {
    expect(
      providerDisclosureNotice({
        serverId: "s",
        parentAgentIds: new Set(["parent"]),
        descriptors: [["s\0parent\0sub", descriptor("failed")]],
        hiddenFromTrack: new Set(["s\0parent\0sub"]),
        nestingSupported: false,
      }),
    ).toBeNull();
  });
});

describe("noticeForIndexedChild", () => {
  const listing = {
    listingServerId: "s",
    listingWorkspaceId: "main",
    workspaceStatus: (serverId: string, workspaceId: string) =>
      `${serverId}:${workspaceId}` === "s:review" ? ("attention" as const) : null,
  };

  it("names the one subagent that finished unread, among siblings that did not", () => {
    const finished = { id: "a", serverId: "s", workspaceId: "main", notice: "attention" as const };
    const read = { id: "b", serverId: "s", workspaceId: "main", notice: null };
    expect(noticeForIndexedChild(finished, listing)).toBe("attention");
    expect(noticeForIndexedChild(read, listing)).toBeNull();
  });

  it("carries a nested workspace's unread mark onto its subagent", () => {
    const nested = { id: "c", serverId: "s", workspaceId: "review", notice: null };
    expect(noticeForIndexedChild(nested, listing)).toBe("attention");
  });
});

describe("subagentRowNotice", () => {
  it("marks what a row's icon cannot show and leaves failed to the icon", () => {
    expect(subagentRowNotice("attention")).toBe("attention");
    expect(subagentRowNotice("needs_input")).toBe("needs_input");
    expect(subagentRowNotice("failed")).toBeNull();
    expect(subagentRowNotice(null)).toBeNull();
  });
});
