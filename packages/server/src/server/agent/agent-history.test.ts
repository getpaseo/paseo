import { describe, expect, test } from "vitest";
import { buildAgentHistory } from "./agent-history.js";
import type { AgentTombstone, StoredAgentRecord } from "./agent-storage.js";

function record(id: string, overrides: Partial<StoredAgentRecord> = {}): StoredAgentRecord {
  return {
    id,
    provider: "claude",
    cwd: "/repo",
    createdAt: "2026-09-29T10:00:00.000Z",
    updatedAt: "2026-09-29T10:00:00.000Z",
    lastActivityAt: "2026-09-29T10:00:00.000Z",
    labels: { "paseo.origin": "systemd:g4-watch.service" },
    lastStatus: "idle",
    config: null,
    ...overrides,
  } as StoredAgentRecord;
}

const tombstone: AgentTombstone = {
  id: "gone",
  provider: "codex",
  cwd: "/repo",
  labels: { "paseo.origin": "agent:parent", "paseo.parent-agent-id": "parent" },
  createdAt: "2026-09-29T09:00:00.000Z",
  deletedAt: "2026-09-29T12:00:00.000Z",
  summary: "Done.",
  usageTotals: {
    turns: 2,
    inputTokens: 10,
    cachedInputTokens: 0,
    outputTokens: 5,
    totalCostUsd: 0.1,
  },
};

describe("buildAgentHistory", () => {
  test("lists active, archived and deleted agents with origin and usage, newest first", () => {
    const entries = buildAgentHistory({
      records: [
        record("live", { lastActivityAt: "2026-09-29T11:00:00.000Z" }),
        record("old", { archivedAt: "2026-09-29T10:30:00.000Z" }),
      ],
      tombstones: [tombstone],
      liveUsage: new Map([
        [
          "live",
          { turns: 1, inputTokens: 3, cachedInputTokens: 0, outputTokens: 1, totalCostUsd: 0 },
        ],
      ]),
    });
    expect(entries.map((item) => [item.agentId, item.state])).toEqual([
      ["gone", "deleted"],
      ["live", "active"],
      ["old", "archived"],
    ]);
    expect(entries[0]).toMatchObject({
      origin: "agent:parent",
      parentAgentId: "parent",
      summary: "Done.",
    });
    expect(entries[1].usage).toMatchObject({ turns: 1, inputTokens: 3 });
  });

  test("hides internal sessions and applies since and limit", () => {
    const entries = buildAgentHistory({
      records: [
        record("internal", { internal: true }),
        record("a"),
        record("b", { lastActivityAt: "2026-09-28T00:00:00.000Z" }),
      ],
      tombstones: [],
      liveUsage: new Map(),
      since: "2026-09-29T00:00:00.000Z",
      limit: 5,
    });
    expect(entries.map((item) => item.agentId)).toEqual(["a"]);
  });
});
