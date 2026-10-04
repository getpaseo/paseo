import { describe, expect, it, vi } from "vitest";
import { buildAgentLsFetchOptions, runLsCommand } from "./ls.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const daemonAgents = ["1", "2", "3"].map((n) => ({
  id: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`,
  provider: "codex",
  title: `agent ${n}`,
  status: "closed",
  archivedAt: null,
  cwd: "/tmp/project",
  createdAt: "2026-10-01T00:00:00.000Z",
  labels: {},
}));

// The fake daemon pages agents two at a time.
const fetchAgents = vi.fn(async (options?: { page?: { cursor?: string } }) => {
  const start = Number(options?.page?.cursor ?? 0);
  const end = start + 2;
  return {
    entries: daemonAgents.slice(start, end).map((agent) => ({ agent })),
    pageInfo: { nextCursor: end < daemonAgents.length ? String(end) : null },
  };
});

vi.mock("../../utils/client.js", () => ({
  connectToDaemon: vi.fn(async () => ({ fetchAgents, close: vi.fn(async () => undefined) })),
}));

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

  it("asks the daemon for internal agents only with --internal", () => {
    expect(buildAgentLsFetchOptions({ background: true, global: true })).toEqual({
      filter: { includeBackground: true },
    });
  });

  it("fetches global non-archived agents for -g", () => {
    expect(buildAgentLsFetchOptions({ global: true })).toEqual({});
  });

  it("includes archived and background agents with -a", () => {
    expect(buildAgentLsFetchOptions({ all: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
      },
    });
  });

  it("fetches all global agents for -a -g", () => {
    expect(buildAgentLsFetchOptions({ all: true, global: true })).toEqual({
      filter: {
        includeArchived: true,
        includeBackground: true,
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

describe("runLsCommand", () => {
  it("lists agents on every page", async () => {
    const result = await runLsCommand({ daemonTarget, all: true, global: true }, {} as never);

    expect(result.data.map((item) => item.name)).toEqual(["agent 1", "agent 2", "agent 3"]);
  });
});
