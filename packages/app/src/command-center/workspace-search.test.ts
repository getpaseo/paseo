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
    background: false,
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

  it("ranks a workspace's own match above an equally good match through an agent", () => {
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

  it("matches a query split between the workspace's text and an agent's title", () => {
    const login = agent("agent-login", "Fix login retries");
    const row = workspace({ id: "payments", title: "payments", agents: [login] });
    const [ranked] = createWorkspaceRanker()([row], "payments login");
    expect(ranked?.id).toBe("payments");
    expect(ranked?.matchedAgent).toEqual(login);
  });

  it("names the agent when it matches better than a loose match on the workspace's text", () => {
    const opened: string[] = [];
    const login = agent("agent-login", "Fix login retries");
    const row = workspace({
      id: "long-input",
      title: "Long input",
      // "login" is a subsequence of "long-input", the weakest kind of match.
      subtitle: "Local · paseo · feature/long-input",
      agents: [login],
      opened,
    });
    const [ranked] = createWorkspaceRanker()([row], "login");
    expect(ranked?.matchedAgent).toEqual(login);
    ranked?.run();
    expect(opened).toEqual(["agent-login"]);
  });

  it("keeps a change-request hit on the workspace even when an agent's title names the number", () => {
    const opened: string[] = [];
    const row = workspace({
      id: "payments",
      title: "Payments refactor",
      changeRequestNumber: 42,
      agents: [agent("agent-review", "Address PR 42 review comments")],
      opened,
    });
    const rank = createWorkspaceRanker();
    for (const query of ["42", "pr 42", "#42"]) {
      const [ranked] = rank([row], query);
      expect(ranked?.matchedAgent).toBeNull();
      ranked?.run();
    }
    expect(opened).toEqual(["workspace", "workspace", "workspace"]);
  });

  it("names no agent while the workspace's own text matches every keystroke contiguously", () => {
    const row = workspace({
      id: "fix-login-bug",
      title: "fix-login-bug",
      subtitle: "paseo · fix/login-bug",
      agents: [agent("agent-login", "Login page fix")],
    });
    const rank = createWorkspaceRanker();
    for (const query of ["l", "lo", "log", "logi", "login"]) {
      expect(rank([row], query)[0]?.matchedAgent).toBeNull();
    }
  });

  it("names no agent whose one-word title matches better than the workspace's whole word", () => {
    const row = workspace({
      id: "review-queue",
      title: "Review queue",
      agents: [agent("agent-review", "Review")],
    });
    expect(createWorkspaceRanker()([row], "review")[0]?.matchedAgent).toBeNull();
  });

  it("ranks a better match through an agent above a looser match on a workspace's own text", () => {
    const loose = workspace({
      id: "loose-own",
      title: "Long input",
      subtitle: "Local · paseo · feature/long-input",
      activityAt: new Date("2026-10-17T00:00:00Z"),
    });
    const viaAgent = workspace({
      id: "via-agent",
      title: "Auth",
      activityAt: new Date("2026-10-01T00:00:00Z"),
      agents: [agent("a", "login page")],
    });
    expect(ids([loose, viaAgent], "login")).toEqual(["via-agent", "loose-own"]);
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
