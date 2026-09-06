import { describe, expect, it } from "vitest";
import { renderJson, renderTable, type OutputOptions } from "../../output/index.js";
import {
  buildAgentLsFetchOptions,
  runLsCommandWithDeps,
  type AgentListSource,
  type AgentLsClient,
  type AgentLsDeps,
  type FetchAgentsOptions,
} from "./ls.js";

/** Explicit so the command never consults this machine's daemon config for a default. */
const host = "127.0.0.1:6767";

const plainOutput: OutputOptions = {
  format: "table",
  quiet: false,
  noHeaders: true,
  noColor: true,
};

function agent(overrides: Partial<AgentListSource> = {}): AgentListSource {
  return {
    id: "agent-1234567890",
    title: "Fix login",
    provider: "claude",
    model: "claude-opus-5",
    effectiveThinkingOptionId: "high",
    status: "idle",
    cwd: "/tmp/project",
    createdAt: new Date().toISOString(),
    labels: { team: "platform", "paseo.worktree": "feature-auth" },
    ...overrides,
  };
}

class FakeAgentLsClient implements AgentLsClient {
  readonly requests: FetchAgentsOptions[] = [];
  closed = false;

  constructor(private readonly agents: AgentListSource[]) {}

  async fetchAgents(options: FetchAgentsOptions) {
    this.requests.push(options);
    return { entries: this.agents.map((entry) => ({ agent: entry })) };
  }

  async close() {
    this.closed = true;
  }
}

function depsFor(client: AgentLsClient): AgentLsDeps {
  return { connectToDaemon: async () => client };
}

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

describe("agent ls", () => {
  it("includes labels in structured output but not in the table", async () => {
    const client = new FakeAgentLsClient([agent()]);

    const result = await runLsCommandWithDeps({ host, global: true }, depsFor(client));

    expect(client.closed).toBe(true);
    expect(result.data).toEqual([
      expect.objectContaining({
        id: "agent-1234567890",
        shortId: "agent-1",
        name: "Fix login",
        provider: "claude/claude-opus-5",
        thinking: "high",
        status: "idle",
        cwd: "/tmp/project",
        labels: { team: "platform", "paseo.worktree": "feature-auth" },
      }),
    ]);

    const json = JSON.parse(renderJson(result, plainOutput));
    expect(json[0].labels).toEqual({ team: "platform", "paseo.worktree": "feature-auth" });

    const table = renderTable(result, plainOutput);
    expect(table).toContain("Fix login");
    expect(table).not.toContain("platform");
  });

  it("filters by label on the host and again on the returned agents", async () => {
    const client = new FakeAgentLsClient([
      agent(),
      agent({ id: "agent-0987654321", title: "Docs", labels: { team: "docs" } }),
    ]);

    const result = await runLsCommandWithDeps({ host, label: ["team=platform"] }, depsFor(client));

    expect(client.requests).toEqual([
      { scope: "active", filter: { labels: { team: "platform" } } },
    ]);
    expect(result.data.map((item) => item.id)).toEqual(["agent-1234567890"]);
  });
});
