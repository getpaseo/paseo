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

const ARCHIVE = {
  archivedAt: "2025-01-03T00:00:00.000Z",
  updatedAt: "2025-01-03T00:00:00.000Z",
};

test("archives a stored agent without changing terminal statuses", () => {
  const statuses: Array<StoredAgentRecord["lastStatus"]> = ["idle", "error", "closed"];

  for (const status of statuses) {
    const archived = buildArchivedAgentRecord({ ...BASE_RECORD, lastStatus: status }, ARCHIVE);

    expect(archived.lastStatus).toBe(status);
    expect(archived.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  }
});

test("archives busy stored agents as idle", () => {
  const statuses: Array<StoredAgentRecord["lastStatus"]> = ["initializing", "running"];

  for (const status of statuses) {
    const archived = buildArchivedAgentRecord({ ...BASE_RECORD, lastStatus: status }, ARCHIVE);

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
    ARCHIVE,
  );

  expect(archived).toMatchObject({
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
  });
});

test("moves updatedAt to the archive time", () => {
  const archived = buildArchivedAgentRecord(BASE_RECORD, ARCHIVE);

  expect(archived.updatedAt).toBe("2025-01-03T00:00:00.000Z");
});

test("keeps a later updatedAt when the archive time is earlier", () => {
  // Putting an original archive back after a failed unarchive must not move updatedAt backwards.
  const archived = buildArchivedAgentRecord(
    { ...BASE_RECORD, updatedAt: "2025-01-04T00:00:00.000Z" },
    ARCHIVE,
  );

  expect(archived.archivedAt).toBe("2025-01-03T00:00:00.000Z");
  expect(archived.updatedAt).toBe("2025-01-04T00:00:00.000Z");
});
