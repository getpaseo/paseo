import { describe, expect, it } from "vitest";
import { renderTable } from "../../output/table.js";
import { agentLsSchema, buildAgentLsFetchOptions, toAgentListItem } from "./ls.js";

describe("buildAgentLsFetchOptions", () => {
  it("fetches active agents by default", () => {
    expect(buildAgentLsFetchOptions({})).toEqual({
      scope: "active",
    });
  });

  it("keeps label and thinking filters within the active scope", () => {
    expect(
      buildAgentLsFetchOptions({
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      scope: "active",
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("keeps -a within the active scope", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      scope: "active",
      filter: {
        includeArchived: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
      },
    });
  });

  it("applies filters to global queries", () => {
    expect(
      buildAgentLsFetchOptions({
        global: true,
        label: ["surface=workspace"],
        thinking: " medium ",
      }),
    ).toEqual({
      filter: {
        labels: { surface: "workspace" },
        thinkingOptionId: "medium",
      },
    });
  });
});

describe("toAgentListItem", () => {
  const agent = {
    id: "agent-1234567890",
    title: "Fix login",
    provider: "claude",
    model: "claude-opus-5",
    effectiveThinkingOptionId: "high",
    status: "idle" as const,
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    labels: { team: "platform", "paseo.worktree": "feature-auth" },
  };

  it("carries labels into structured output", () => {
    expect(toAgentListItem(agent)).toMatchObject({
      id: "agent-1234567890",
      shortId: "agent-1",
      name: "Fix login",
      provider: "claude/claude-opus-5",
      thinking: "high",
      status: "idle",
      cwd: "/tmp/project",
      labels: { team: "platform", "paseo.worktree": "feature-auth" },
    });
  });

  it("keeps labels out of the table", () => {
    const line = renderTable(
      { type: "list", data: [toAgentListItem(agent)], schema: agentLsSchema },
      { format: "table", quiet: false, noHeaders: true, noColor: true },
    );
    expect(line).toContain("Fix login");
    expect(line).not.toContain("platform");
  });
});
