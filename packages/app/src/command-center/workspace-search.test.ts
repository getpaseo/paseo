import { describe, expect, it } from "vitest";
import type { CommandCenterWorkspaceAgent, CommandCenterWorkspaceResult } from "./results";
import { createWorkspaceRanker } from "./workspace-search";

function workspace(input: {
  id: string;
  title?: string;
  subtitle?: string;
  changeRequestNumber?: number | null;
  activityAt?: Date | null;
  agents?: readonly CommandCenterWorkspaceAgent[];
  opened?: string[];
}): CommandCenterWorkspaceResult {
  return {
    kind: "workspace",
    serverId: "server",
    workspaceId: "workspace",
    id: input.id,
    title: input.title ?? input.id,
    subtitle: input.subtitle ?? "",
    project: { viewKey: "project", name: "project", iconDataUri: null },
    changeRequestNumber: input.changeRequestNumber ?? null,
    activityAt: input.activityAt ?? null,
    agents: input.agents ?? [],
    matchedAgent: null,
    archived: false,
    run: () => input.opened?.push("workspace"),
    openAgent: (agentId) => input.opened?.push(agentId),
  };
}

function agent(id: string, title: string): CommandCenterWorkspaceAgent {
  return { id, title, provider: "mock" };
}

function ids(rows: readonly CommandCenterWorkspaceResult[], query: string): string[] {
  return createWorkspaceRanker()(rows, query).map((row) => row.id);
}

describe("workspace ranking", () => {
  const subject = workspace({
    id: "payments",
    title: "Payments refactor",
    subtitle: "Primary host · feature/checkout",
    changeRequestNumber: 42,
  });

  it("matches everything when the query is empty", () => {
    expect(ids([subject], "  ")).toEqual(["payments"]);
  });

  it("matches its own change-request number in every spelling", () => {
    const spellings = ["42", " 42 ", "#42", "!42", "pr 42", "mr 42", "PR #42", "mr!42", "pr42"];
    for (const query of spellings) {
      expect(ids([subject], query)).toEqual(["payments"]);
    }
  });

  it("does not take the number path for text that merely contains digits", () => {
    const numbered = workspace({ id: "unrelated workspace", changeRequestNumber: 42 });
    for (const query of ["fix-42-retries", "42x", "v4.2", "pr"]) {
      expect(ids([numbered], query)).toEqual([]);
    }
  });

  it("does not match a different change-request number that shares digits", () => {
    const other = workspace({ id: "unrelated", changeRequestNumber: 142 });
    expect(ids([other], "42")).toEqual([]);
  });

  it("still matches on title and branch text", () => {
    expect(ids([subject], "checkout")).toEqual(["payments"]);
    expect(ids([subject], "payments")).toEqual(["payments"]);
  });

  it("leaves a workspace without a change request unaffected", () => {
    const noPr = workspace({ id: "docs workspace" });
    expect(ids([noPr], "42")).toEqual([]);
    expect(ids([noPr], "docs")).toEqual(["docs workspace"]);
  });

  it("falls back to text matching when the number does not match", () => {
    const textual = workspace({
      id: "text",
      subtitle: "branch fix-42-retries",
      changeRequestNumber: 7,
    });
    expect(ids([textual], "42")).toEqual(["text"]);
  });

  it("ranks an exact change request above an ordinary text match", () => {
    const text = workspace({ id: "a-text", title: "Migration 42" });
    expect(ids([text, subject], "42")).toEqual(["payments", "a-text"]);
  });

  it("orders workspaces in the same match tier by recency", () => {
    const older = workspace({
      id: "older",
      title: "Usage hover card",
      activityAt: new Date("2026-10-01T00:00:00Z"),
    });
    const newer = workspace({
      id: "newer",
      title: "Deliver sidebar usage",
      activityAt: new Date("2026-10-17T00:00:00Z"),
    });
    expect(ids([older, newer], "usage")).toEqual(["newer", "older"]);
  });

  it("lists every workspace most recent first when the query is empty", () => {
    const rows = Array.from({ length: 8 }, (_, index) =>
      workspace({ id: `w${index}`, activityAt: new Date(2026, 0, index + 1) }),
    );
    expect(ids(rows, "")).toEqual(["w7", "w6", "w5", "w4", "w3", "w2", "w1", "w0"]);
  });

  it("matches a workspace through one of its agents and names that agent", () => {
    const receipts = agent("agent-receipts", "Add receipt emails");
    const row = workspace({
      id: "onboarding",
      title: "Onboarding flow",
      agents: [agent("agent-welcome", "Polish welcome screen"), receipts],
    });
    const [ranked] = createWorkspaceRanker()([row], "receipt");
    expect(ranked.id).toBe("onboarding");
    expect(ranked.matchedAgent).toEqual(receipts);
  });

  it("names no agent when the workspace's own text matched", () => {
    const row = workspace({
      id: "payments",
      title: "Payments refactor",
      agents: [agent("agent-payments", "Payments retries")],
    });
    const [ranked] = createWorkspaceRanker()([row], "payments");
    expect(ranked.matchedAgent).toBeNull();
  });

  it("ranks a workspace's own match above a match through an agent", () => {
    const viaAgent = workspace({
      id: "via-agent",
      title: "Onboarding flow",
      activityAt: new Date("2026-10-17T00:00:00Z"),
      agents: [agent("a", "Receipt emails")],
    });
    const own = workspace({
      id: "own",
      title: "Receipt redesign",
      activityAt: new Date("2026-10-01T00:00:00Z"),
    });
    expect(ids([viaAgent, own], "receipt")).toEqual(["own", "via-agent"]);
  });

  it("picks the best-matching agent for the line", () => {
    const row = workspace({
      id: "w",
      title: "Onboarding",
      agents: [agent("loose", "Reconcile cash receipts later"), agent("exact", "receipts")],
    });
    const [ranked] = createWorkspaceRanker()([row], "receipts");
    expect(ranked.matchedAgent?.id).toBe("exact");
  });

  it("opens the matched agent's tab, and the workspace otherwise", () => {
    const opened: string[] = [];
    const row = workspace({
      id: "w",
      title: "Onboarding flow",
      agents: [agent("agent-receipts", "Add receipt emails")],
      opened,
    });
    const rank = createWorkspaceRanker();
    rank([row], "receipt")[0].run();
    rank([row], "onboarding")[0].run();
    expect(opened).toEqual(["agent-receipts", "workspace"]);
  });

  it("returns the same row object across keystrokes while the matched agent holds", () => {
    const row = workspace({
      id: "w",
      title: "Onboarding flow",
      agents: [agent("agent-receipts", "Add receipt emails")],
    });
    const rank = createWorkspaceRanker();
    expect(rank([row], "rece")[0]).toBe(rank([row], "receipt")[0]);
    expect(rank([row], "onboard")[0]).toBe(row);
  });

  it("keeps rows the host already matched when asked to, without an agent line", () => {
    const row = workspace({ id: "archived", title: "Billing cleanup" });
    const rank = createWorkspaceRanker();
    expect(rank([row], "billign")).toEqual([]);
    expect(rank([row], "billign", { keepUnmatched: true })).toEqual([row]);
  });
});
