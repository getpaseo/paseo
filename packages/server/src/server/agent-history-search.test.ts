import { describe, expect, it } from "vitest";
import {
  conversationTextFromGrokJsonl,
  type HistoryConversation,
} from "./agent-history-content.js";
import {
  agentHistoryMatchBand,
  type AgentHistorySearchCandidate,
  historyContentHit,
  historyContentSnippet,
  matchesAgentHistoryQuery,
  orderHistoryMatchesByBand,
} from "./agent-history-search.js";

function candidate(input: {
  title?: string | null;
  workspaceName?: string | null;
  branch?: string | null;
  projectName?: string;
  updatedAt?: string;
  content?: string;
  conversation?: HistoryConversation;
}): AgentHistorySearchCandidate & { agent: { id: string; updatedAt: string } } {
  const branch = input.branch ?? null;
  return {
    agent: {
      id: input.title ?? "agent",
      title: input.title ?? null,
      updatedAt: input.updatedAt ?? "2026-08-07T00:00:00.000Z",
    },
    project: {
      projectKey: "key",
      projectName: input.projectName ?? "getpaseo/paseo",
      workspaceName: input.workspaceName ?? null,
      checkout: {
        cwd: "/tmp/repo",
        isGit: branch !== null,
        currentBranch: branch,
        remoteUrl: null,
        worktreeRoot: "/tmp/repo",
        isPaseoOwnedWorktree: false,
        mainRepoRoot: null,
      },
    },
    content: input.content,
    conversation: input.conversation,
    // The module only reads the names and the conversation text.
  } as unknown as AgentHistorySearchCandidate & { agent: { id: string; updatedAt: string } };
}

function grok(rows: readonly unknown[]): HistoryConversation {
  return conversationTextFromGrokJsonl(rows.map((row) => JSON.stringify(row)).join("\n"));
}

describe("matchesAgentHistoryQuery", () => {
  it("rejects scattered letters across words while keeping within-word subsequences", () => {
    expect(
      matchesAgentHistoryQuery(
        "terminal",
        candidate({
          title: "Let me diagnose this problem in a diagnose this problem and",
        }),
      ),
    ).toBe(false);
    expect(matchesAgentHistoryQuery("trmnl", candidate({ title: "Fix terminal resizing" }))).toBe(
      true,
    );
  });

  it("matches the workspace name", () => {
    expect(
      matchesAgentHistoryQuery("stripe", candidate({ workspaceName: "Add Stripe billing" })),
    ).toBe(true);
  });

  it("matches the agent title", () => {
    expect(
      matchesAgentHistoryQuery("entitlements", candidate({ title: "Reshape entitlements" })),
    ).toBe(true);
  });

  it("matches the branch name", () => {
    expect(matchesAgentHistoryQuery("billing", candidate({ branch: "add-stripe-billing" }))).toBe(
      true,
    );
  });

  it("matches the project name", () => {
    expect(matchesAgentHistoryQuery("paseo", candidate({ projectName: "getpaseo/paseo" }))).toBe(
      true,
    );
  });

  it("requires every token to match somewhere", () => {
    const entry = candidate({ workspaceName: "Add Stripe billing", branch: "main" });
    expect(matchesAgentHistoryQuery("stripe main", entry)).toBe(true);
    expect(matchesAgentHistoryQuery("stripe rosetta", entry)).toBe(false);
  });

  it("tolerates a typo", () => {
    expect(
      matchesAgentHistoryQuery("bulling", candidate({ workspaceName: "Add Stripe billing" })),
    ).toBe(true);
  });

  it("tolerates a transposed branch name", () => {
    expect(matchesAgentHistoryQuery("mian", candidate({ branch: "main" }))).toBe(true);
    expect(matchesAgentHistoryQuery("rain", candidate({ branch: "main" }))).toBe(false);
  });

  it("keeps candidates for a blank query", () => {
    expect(matchesAgentHistoryQuery("   ", candidate({ title: "anything" }))).toBe(true);
  });

  it("matches a phrase that is only in the conversation", () => {
    expect(
      matchesAgentHistoryQuery(
        "obsidian kanban",
        candidate({
          title: "Help me find the note",
          content: "The obsidian kanban board was left with community plugins off.",
        }),
      ),
    ).toBe(true);
  });

  it("lets one token match the title and another match the conversation", () => {
    const entry = candidate({
      title: "Invoice export",
      content: "The failure is a missing entitlements row.",
    });
    expect(matchesAgentHistoryQuery("invoice entitlements", entry)).toBe(true);
    expect(matchesAgentHistoryQuery("invoice rosetta", entry)).toBe(false);
  });

  it("does not treat an empty conversation as a match", () => {
    expect(matchesAgentHistoryQuery("kanban", candidate({ title: "Help me find the note" }))).toBe(
      false,
    );
  });
});

describe("historyContentSnippet", () => {
  it("quotes the conversation around the matched word", () => {
    const snippet = historyContentSnippet(
      "authorization",
      "The order gate checks authorization before any live placement.",
    );
    expect(snippet).toContain("authorization");
    expect(snippet?.startsWith("…") || snippet?.includes("order gate")).toBe(true);
  });

  it("returns null when the conversation does not contain the query", () => {
    expect(historyContentSnippet("authorization", "Nothing about that here.")).toBeNull();
  });
});

describe("conversation bands", () => {
  it("matches a word in user_query and ignores the same word in rules or user_info", () => {
    const conversation = grok([
      {
        type: "user",
        content:
          "<user_info>kanban lives in the info block</user_info><rules>kanban lives in the rules</rules><user_query>Where is the obsidian note?</user_query>",
      },
      {
        type: "user",
        content: "<user_info>xylophone in info</user_info><rules>xylophone in rules</rules>",
      },
    ]);
    const entry = candidate({ title: "Help me find the note", conversation });
    expect(matchesAgentHistoryQuery("obsidian", entry)).toBe(true);
    expect(historyContentHit("obsidian", conversation)?.source).toBe("user");
    expect(matchesAgentHistoryQuery("kanban", entry)).toBe(false);
    expect(matchesAgentHistoryQuery("xylophone", entry)).toBe(false);
    expect(agentHistoryMatchBand("obsidian", entry)).toBe(0);
  });

  it("quotes the reply instead of an earlier tool result", () => {
    const conversation = grok([
      { type: "tool_result", content: "The authorization dump from the tool ran first." },
      { type: "assistant", content: "The reply mentions authorization at the end." },
    ]);
    const hit = historyContentHit("authorization", conversation);
    expect(hit?.source).toBe("reply");
    expect(hit?.snippet).toContain("reply mentions");
    expect(hit?.snippet).not.toContain("dump from the tool");
    expect(agentHistoryMatchBand("authorization", candidate({ conversation }))).toBe(0);
  });

  it("matches thinking below a reply", () => {
    const thinking = grok([
      {
        type: "reasoning",
        encrypted_content: "secret xylophone blob",
        summary: [{ type: "summary_text", text: "pondering xylophone quietly" }],
      },
    ]);
    const reply = grok([{ type: "assistant", content: "The reply says xylophone plainly." }]);
    expect(historyContentHit("xylophone", thinking)?.source).toBe("thinking");
    expect(JSON.stringify(thinking)).not.toContain("secret xylophone blob");
    expect(
      agentHistoryMatchBand(
        "xylophone",
        candidate({ title: "Quiet notes", conversation: thinking }),
      ),
    ).toBe(1);
    expect(
      agentHistoryMatchBand("xylophone", candidate({ title: "Plain answer", conversation: reply })),
    ).toBe(0);
    const ordered = orderHistoryMatchesByBand([
      { id: "newer-thinking", contentMatchBand: "trace" as const },
      { id: "older-reply", contentMatchBand: "message" as const },
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["older-reply", "newer-thinking"]);
  });

  it("matches a tool result below a reply", () => {
    const tool = grok([{ type: "tool_result", content: "only a tool result mentions marimba" }]);
    const reply = grok([{ type: "assistant", content: "the reply mentions marimba" }]);
    expect(historyContentHit("marimba", tool)?.source).toBe("tool");
    expect(agentHistoryMatchBand("marimba", candidate({ conversation: tool }))).toBe(1);
    expect(agentHistoryMatchBand("marimba", candidate({ conversation: reply }))).toBe(0);
    const ordered = orderHistoryMatchesByBand([
      { id: "newest-reply", contentMatchBand: "message" as const },
      { id: "newer-tool", contentMatchBand: "trace" as const },
      { id: "older-reply", contentMatchBand: "message" as const },
    ]);
    expect(ordered.map((entry) => entry.id)).toEqual(["newest-reply", "older-reply", "newer-tool"]);
  });

  it("keeps a body excerpt when the title also matches", () => {
    const conversation = grok([
      { type: "tool_result", content: "kanban showed up in a tool dump" },
      { type: "assistant", content: "The reply never says that word." },
    ]);
    const entry = candidate({ title: "Kanban note", conversation });
    expect(matchesAgentHistoryQuery("kanban", entry)).toBe(true);
    expect(agentHistoryMatchBand("kanban", entry)).toBe(0);
    const hit = historyContentHit("kanban", conversation);
    expect(hit?.source).toBe("tool");
    expect(hit?.snippet).toContain("tool dump");
  });

  it("keeps every candidate for an empty query", () => {
    expect(matchesAgentHistoryQuery("", candidate({ title: "anything" }))).toBe(true);
    expect(matchesAgentHistoryQuery("   ", candidate({}))).toBe(true);
    expect(agentHistoryMatchBand("   ", candidate({ title: "anything" }))).toBe(0);
  });
});
