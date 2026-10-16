import { describe, expect, it } from "vitest";
import {
  type AgentHistorySearchCandidate,
  matchAgentHistoryQuery,
} from "./agent-history-search.js";

type Candidate = AgentHistorySearchCandidate & { agent: { id: string; updatedAt: string } };

function candidate(
  input: {
    title?: string | null;
    workspaceName?: string | null;
    branch?: string | null;
    projectName?: string;
    updatedAt?: string;
    previewMessages?: { role: "user" | "assistant"; text: string }[];
  } = {},
): Candidate {
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
    previewMessages: input.previewMessages,
    // The module only reads the names and the preview; the rest of the payload
    // is the session's business.
  } as unknown as Candidate;
}

/** Every assertion here cares about `matched`; the snippet has its own describe. */
function matches(query: string, entry: Candidate): boolean {
  return matchAgentHistoryQuery(query, entry).matched;
}

describe("matchAgentHistoryQuery names", () => {
  it("rejects scattered letters across words while keeping within-word subsequences", () => {
    expect(
      matches(
        "terminal",
        candidate({ title: "Let me diagnose this problem in a diagnose this problem and" }),
      ),
    ).toBe(false);
    expect(matches("trmnl", candidate({ title: "Fix terminal resizing" }))).toBe(true);
  });

  it("matches the workspace name", () => {
    expect(matches("stripe", candidate({ workspaceName: "Add Stripe billing" }))).toBe(true);
  });

  it("matches the agent title", () => {
    expect(matches("entitlements", candidate({ title: "Reshape entitlements" }))).toBe(true);
  });

  it("matches the branch name", () => {
    expect(matches("billing", candidate({ branch: "add-stripe-billing" }))).toBe(true);
  });

  it("matches the project name", () => {
    expect(matches("paseo", candidate({ projectName: "getpaseo/paseo" }))).toBe(true);
  });

  it("requires every token to match somewhere", () => {
    const entry = candidate({ workspaceName: "Add Stripe billing", branch: "main" });
    expect(matches("stripe main", entry)).toBe(true);
    expect(matches("stripe rosetta", entry)).toBe(false);
  });

  it("tolerates a typo", () => {
    expect(matches("bulling", candidate({ workspaceName: "Add Stripe billing" }))).toBe(true);
  });

  it("tolerates a transposed branch name", () => {
    expect(matches("mian", candidate({ branch: "main" }))).toBe(true);
    expect(matches("rain", candidate({ branch: "main" }))).toBe(false);
  });

  it("keeps candidates for a blank query", () => {
    expect(matches("   ", candidate({ title: "anything" }))).toBe(true);
  });
});

describe("matchAgentHistoryQuery stored messages", () => {
  const conversation = candidate({
    title: "Rename the importer",
    previewMessages: [
      { role: "user", text: "please rename the legacy importer" },
      { role: "assistant", text: "I renamed it and updated its callers" },
    ],
  });

  it("matches a word that only appears in a message", () => {
    expect(matches("callers", conversation)).toBe(true);
  });

  it("matches the user's own question", () => {
    expect(matches("legacy", conversation)).toBe(true);
  });

  it("still rejects a word that appears nowhere", () => {
    expect(matches("kubernetes", conversation)).toBe(false);
  });

  it("matches message text literally, without the name typo budget", () => {
    // The names say nothing close to the token, so only the message path can match.
    const messageOnly = candidate({
      title: "Session notes",
      previewMessages: [{ role: "user", text: "please rename the legacy importer" }],
    });
    expect(matches("importer", messageOnly)).toBe(true);
    expect(matches("impoter", messageOnly)).toBe(false);
  });

  it("lets tokens land in different places", () => {
    expect(matches("importer callers", conversation)).toBe(true);
    expect(matches("importer kubernetes", conversation)).toBe(false);
  });

  it("does not match a preview the agent never stored", () => {
    expect(matches("legacy", candidate({ title: "Rename the importer" }))).toBe(false);
  });
});

describe("matchAgentHistoryQuery snippet", () => {
  const conversation = candidate({
    title: "Rename the importer",
    previewMessages: [
      { role: "user", text: "please rename the legacy importer" },
      { role: "assistant", text: "I renamed it and updated its callers" },
    ],
  });

  it("returns no snippet when the names are why the row matched", () => {
    expect(matchAgentHistoryQuery("rename", conversation)).toEqual({
      matched: true,
      messageSnippet: null,
    });
  });

  it("returns the message when the names missed", () => {
    const result = matchAgentHistoryQuery("callers", conversation);
    expect(result.matched).toBe(true);
    expect(result.messageSnippet).toEqual({
      role: "assistant",
      text: "I renamed it and updated its callers",
    });
  });

  it("picks the message with the word the names could not explain", () => {
    const entry = candidate({
      title: "Fix the terminal",
      previewMessages: [
        { role: "user", text: "the admin panel is slow" },
        { role: "assistant", text: "I fixed the terminal redraw" },
      ],
    });
    // "fix" is already explained by the title and also appears in the reply;
    // only "admin" makes the message necessary, so that message is the snippet.
    const result = matchAgentHistoryQuery("fix admin", entry);
    expect(result.matched).toBe(true);
    expect(result.messageSnippet).toEqual({ role: "user", text: "the admin panel is slow" });
  });
});
