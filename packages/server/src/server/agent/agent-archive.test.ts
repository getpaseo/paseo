import { expect, test } from "vitest";

import { buildArchivedAgentRecord } from "./agent-archive.js";
import type { StoredAgentRecord } from "./agent-storage.js";

const BASE_RECORD: StoredAgentRecord = {
  id: "agent-1",
  provider: "codex",
  cwd: "/workspace/project",
  createdAt: "2025-01-01T00:00:00.000Z",
  updatedAt: "2025-01-02T00:00:00.000Z",
  labels: {},
  lastStatus: "idle",
  config: null,
};

test("archives a stored agent without changing terminal statuses", () => {
  const statuses: Array<StoredAgentRecord["lastStatus"]> = ["idle", "error", "closed"];

  for (const status of statuses) {
    const archived = buildArchivedAgentRecord(
      { ...BASE_RECORD, lastStatus: status },
      { archivedAt: "2025-01-03T00:00:00.000Z" },
    );

    expect(archived.lastStatus).toBe(status);
    expect(archived.archivedAt).toBe("2025-01-03T00:00:00.000Z");
    expect(archived.updatedAt).toBe(BASE_RECORD.updatedAt);
  }
});

test("archives busy stored agents as idle", () => {
  const statuses: Array<StoredAgentRecord["lastStatus"]> = ["initializing", "running"];

  for (const status of statuses) {
    const archived = buildArchivedAgentRecord(
      { ...BASE_RECORD, lastStatus: status },
      { archivedAt: "2025-01-03T00:00:00.000Z" },
    );

    expect(archived.lastStatus).toBe("idle");
  }
});

test("clears persisted attention when archiving", () => {
  const archived = buildArchivedAgentRecord(
    {
      ...BASE_RECORD,
      requiresAttention: true,
      attentionReason: "finished",
      attentionTimestamp: "2025-01-02T12:00:00.000Z",
    },
    { archivedAt: "2025-01-03T00:00:00.000Z" },
  );

  expect(archived).toMatchObject({
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  });
});

test("can stamp updatedAt to the archive timestamp", () => {
  const archived = buildArchivedAgentRecord(BASE_RECORD, {
    archivedAt: "2025-01-03T00:00:00.000Z",
    updatedAt: "2025-01-03T00:00:00.000Z",
  });

  expect(archived.updatedAt).toBe("2025-01-03T00:00:00.000Z");
});
