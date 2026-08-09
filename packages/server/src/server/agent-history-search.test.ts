import { describe, expect, it } from "vitest";
import {
  type AgentHistorySearchCandidate,
  describeAgentHistoryMatches,
  rankAgentHistoryCandidates,
  scoreAgentHistoryCandidate,
} from "./agent-history-search.js";

function candidate(input: {
  title?: string | null;
  workspaceName?: string | null;
  branch?: string | null;
  projectName?: string;
  updatedAt?: string;
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
    // The module only reads the four names; the rest of the payload is the
    // session's business.
  } as unknown as AgentHistorySearchCandidate & { agent: { id: string; updatedAt: string } };
}

const byUpdatedAtDesc = (
  left: { agent: { updatedAt: string } },
  right: { agent: { updatedAt: string } },
) => right.agent.updatedAt.localeCompare(left.agent.updatedAt);

describe("scoreAgentHistoryCandidate", () => {
  it("matches the workspace name", () => {
    expect(
      scoreAgentHistoryCandidate("stripe", candidate({ workspaceName: "Add Stripe billing" })),
    ).not.toBeNull();
  });

  it("matches the agent title", () => {
    expect(
      scoreAgentHistoryCandidate("entitlements", candidate({ title: "Reshape entitlements" })),
    ).not.toBeNull();
  });

  it("matches the branch name", () => {
    expect(
      scoreAgentHistoryCandidate("billing", candidate({ branch: "add-stripe-billing" })),
    ).not.toBeNull();
  });

  it("matches the project name", () => {
    expect(
      scoreAgentHistoryCandidate("paseo", candidate({ projectName: "getpaseo/paseo" })),
    ).not.toBeNull();
  });

  it("requires every token to match somewhere", () => {
    const entry = candidate({ workspaceName: "Add Stripe billing", branch: "main" });
    expect(scoreAgentHistoryCandidate("stripe main", entry)).not.toBeNull();
    expect(scoreAgentHistoryCandidate("stripe rosetta", entry)).toBeNull();
  });

  it("tolerates a typo", () => {
    expect(
      scoreAgentHistoryCandidate("bulling", candidate({ workspaceName: "Add Stripe billing" })),
    ).not.toBeNull();
  });

  it("tolerates a transposed branch name", () => {
    expect(scoreAgentHistoryCandidate("mian", candidate({ branch: "main" }))).not.toBeNull();
    expect(scoreAgentHistoryCandidate("rain", candidate({ branch: "main" }))).toBeNull();
  });

  it("returns null for a blank query so an empty box never filters", () => {
    expect(scoreAgentHistoryCandidate("   ", candidate({ title: "anything" }))).toBeNull();
  });
});

describe("rankAgentHistoryCandidates", () => {
  it("drops candidates that do not match", () => {
    const ranked = rankAgentHistoryCandidates(
      "stripe",
      [candidate({ title: "Add Stripe billing" }), candidate({ title: "Fix terminal resize" })],
      byUpdatedAtDesc,
    );
    expect(ranked.map((result) => result.candidate.agent.title)).toEqual(["Add Stripe billing"]);
  });

  it("ranks a whole-word hit above a hit buried inside a word", () => {
    const ranked = rankAgentHistoryCandidates(
      "bill",
      [candidate({ title: "unbilled usage report" }), candidate({ title: "bill the customer" })],
      byUpdatedAtDesc,
    );
    expect(ranked.map((result) => result.candidate.agent.title)).toEqual([
      "bill the customer",
      "unbilled usage report",
    ]);
  });

  it("ranks the workspace name above the project name that every session shares", () => {
    const ranked = rankAgentHistoryCandidates(
      "paseo",
      [
        candidate({ title: "unrelated work", projectName: "getpaseo/paseo" }),
        candidate({ workspaceName: "paseo", projectName: "getpaseo/paseo" }),
      ],
      byUpdatedAtDesc,
    );
    expect(ranked[0].candidate.project.workspaceName).toBe("paseo");
  });

  it("ranks every exact hit above a typo hit", () => {
    const ranked = rankAgentHistoryCandidates(
      "billing",
      [
        candidate({ title: "bulling the customer" }),
        candidate({ title: "prorated billing edge cases" }),
      ],
      byUpdatedAtDesc,
    );
    expect(ranked.map((result) => result.candidate.agent.title)).toEqual([
      "prorated billing edge cases",
      "bulling the customer",
    ]);
  });

  it("breaks ties with the caller's ordering", () => {
    const ranked = rankAgentHistoryCandidates(
      "stripe",
      [
        candidate({ title: "stripe one", updatedAt: "2026-08-01T00:00:00.000Z" }),
        candidate({ title: "stripe two", updatedAt: "2026-08-06T00:00:00.000Z" }),
      ],
      byUpdatedAtDesc,
    );
    expect(ranked.map((result) => result.candidate.agent.title)).toEqual([
      "stripe two",
      "stripe one",
    ]);
  });
});

describe("describeAgentHistoryMatches", () => {
  it("says which field matched and where", () => {
    expect(
      describeAgentHistoryMatches("stripe", candidate({ workspaceName: "Add Stripe billing" })),
    ).toEqual([{ field: "workspace", ranges: [{ start: 4, length: 6 }] }]);
  });

  it("describes each field a multi-token query landed on", () => {
    expect(
      describeAgentHistoryMatches(
        "stripe main",
        candidate({ workspaceName: "Add Stripe billing", branch: "main" }),
      ),
    ).toEqual([
      { field: "workspace", ranges: [{ start: 4, length: 6 }] },
      { field: "branch", ranges: [{ start: 0, length: 4 }] },
    ]);
  });

  it("merges overlapping spans two tokens found in one field", () => {
    expect(
      describeAgentHistoryMatches("bill billing", candidate({ title: "prorated billing" })),
    ).toEqual([{ field: "title", ranges: [{ start: 9, length: 7 }] }]);
  });

  it("marks the whole word behind a typo", () => {
    expect(
      describeAgentHistoryMatches("bulling", candidate({ title: "customer billing" })),
    ).toEqual([{ field: "title", ranges: [{ start: 9, length: 7 }] }]);
  });

  it("returns nothing when the candidate does not match", () => {
    expect(
      describeAgentHistoryMatches("rosetta", candidate({ title: "customer billing" })),
    ).toEqual([]);
  });
});
