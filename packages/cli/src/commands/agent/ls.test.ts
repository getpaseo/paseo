import { describe, expect, it, vi } from "vitest";
import { buildAgentLsFetchOptions, runLsCommand } from "./ls.js";

const daemonTarget = { kind: "endpoint" as const, host: "example.test:12345" };

const daemonAgents = [3, 2, 1].map((n) => ({
  id: `${n}${n}${n}${n}${n}${n}${n}${n}-0000-4000-8000-000000000000`,
  provider: "codex",
  title: `agent ${n}`,
  status: "closed",
  archivedAt: null,
  cwd: "/tmp/project",
  createdAt: `2026-10-0${n}T00:00:00.000Z`,
  updatedAt: `2026-10-0${n}T00:00:00.000Z`,
  labels: {},
}));
type DaemonAgent = (typeof daemonAgents)[number];

// The fake daemon pages two agents at a time, newest first by the requested key
// (updated_at by default), and agent 1 is updated right after the first page is served.
const fetchAgents = vi.fn(
  async (options?: { sort?: { key: string }[]; page?: { cursor?: string } }) => {
    const key: keyof DaemonAgent =
      options?.sort?.[0]?.key === "created_at" ? "createdAt" : "updatedAt";
    const cursor = options?.page?.cursor;
    const ordered = daemonAgents
      .filter((agent) => cursor === undefined || agent[key] < cursor)
      .sort((left, right) => right[key].localeCompare(left[key]));
    const page = ordered.slice(0, 2);
    const hasMore = ordered.length > 2;
    if (cursor === undefined) {
      daemonAgents[2]!.updatedAt = "2026-10-09T00:00:00.000Z";
    }
    return {
      entries: page.map((agent) => ({ agent })),
      pageInfo: { nextCursor: hasMore ? page[page.length - 1]![key] : null },
    };
  },
);

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
  it("lists agents on every page, including one updated during the listing", async () => {
    const result = await runLsCommand({ daemonTarget, all: true, global: true }, {} as never);

    expect(result.data.map((item) => item.name)).toEqual(["agent 3", "agent 2", "agent 1"]);
  });
});
