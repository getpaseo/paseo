import { describe, expect, it } from "vitest";
import { resolveReviewCommentAgentId } from "./pr-review-comment-dispatch";

interface AgentIdentity {
  id: string;
  cwd: string;
}

function agentMap(entries: AgentIdentity[]): Map<string, AgentIdentity> {
  return new Map(entries.map((entry) => [entry.id, entry]));
}

describe("resolveReviewCommentAgentId", () => {
  it("prefers the focused agent when it belongs to the workspace", () => {
    const agents = agentMap([
      { id: "a", cwd: "/repo" },
      { id: "b", cwd: "/repo" },
    ]);
    expect(resolveReviewCommentAgentId({ agents, focusedAgentId: "b", cwd: "/repo" })).toBe("b");
  });

  it("falls back to the first workspace agent when the focused agent is elsewhere", () => {
    const agents = agentMap([
      { id: "other", cwd: "/elsewhere" },
      { id: "here", cwd: "/repo" },
    ]);
    expect(resolveReviewCommentAgentId({ agents, focusedAgentId: "other", cwd: "/repo" })).toBe(
      "here",
    );
  });

  it("falls back to the first workspace agent when nothing is focused", () => {
    const agents = agentMap([{ id: "here", cwd: "/repo" }]);
    expect(resolveReviewCommentAgentId({ agents, focusedAgentId: null, cwd: "/repo" })).toBe(
      "here",
    );
  });

  it("returns null when no agent belongs to the workspace", () => {
    const agents = agentMap([{ id: "other", cwd: "/elsewhere" }]);
    expect(
      resolveReviewCommentAgentId({ agents, focusedAgentId: "other", cwd: "/repo" }),
    ).toBeNull();
  });

  it("returns null when the agents map is undefined", () => {
    expect(
      resolveReviewCommentAgentId({ agents: undefined, focusedAgentId: null, cwd: "/repo" }),
    ).toBeNull();
  });
});
