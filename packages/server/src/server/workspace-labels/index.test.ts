import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createTestLogger } from "../../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
} from "../workspace-registry.js";
import { createWorkspaceLabelService, type WorkspaceLabelService } from "./index.js";
import { writeJsonFileAtomic } from "../atomic-file.js";

function transactionPhase(transaction: unknown): string | undefined {
  return typeof transaction === "object" && transaction !== null && "phase" in transaction
    ? String(transaction.phase)
    : undefined;
}

describe("workspace labels", () => {
  let paseoHome: string;
  let registry: FileBackedWorkspaceRegistry;
  let labels: WorkspaceLabelService;

  beforeEach(async () => {
    paseoHome = await mkdtemp(join(tmpdir(), "paseo-labels-"));
    registry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    await registry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "wks_one",
        projectId: "prj_one",
        cwd: "/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }),
    );
    labels = createWorkspaceLabelService({ paseoHome, workspaceRegistry: registry });
  });

  afterEach(async () => {
    await rm(paseoHome, { recursive: true, force: true });
  });

  test("normalizes identity, preserves the target definition, persists assignments, and stays silent on no-op", async () => {
    const updates: unknown[] = [];
    const initial = await labels.subscribe({ onChange: (change) => updates.push(change) });
    expect(initial.snapshot).toMatchObject({ labels: [], sync: { mode: "snapshot", headSeq: 0 } });

    const assigned = await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "  Needs   review ", color: "sky" },
      assigned: true,
    });
    expect(assigned).toEqual({
      label: { name: "Needs review", color: "sky" },
      workspaceLabels: ["Needs review"],
    });
    expect(updates).toHaveLength(1);

    const targetWins = await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "needs REVIEW", color: "red" },
      assigned: true,
    });
    expect(targetWins.label).toEqual({ name: "Needs review", color: "sky" });
    expect(updates).toHaveLength(1);

    const reloaded = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    expect((await reloaded.get("wks_one"))?.labels).toEqual(["Needs review"]);
    const reloadedLabels = createWorkspaceLabelService({
      paseoHome,
      workspaceRegistry: reloaded,
    });
    const persisted = await reloadedLabels.subscribe({ onChange: () => undefined });
    expect(persisted.snapshot.labels).toEqual([{ name: "Needs review", color: "sky" }]);
    persisted.unsubscribe();
    initial.unsubscribe();
  });

  test("catches up one catalog change and falls back to a coherent snapshot", async () => {
    const initial = await labels.subscribe({ onChange: () => undefined });
    await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Blocked", color: "red" },
      assigned: true,
    });
    initial.unsubscribe();

    const caughtUp = await labels.subscribe({
      cursor: {
        generation: initial.snapshot.sync.generation,
        afterSeq: initial.snapshot.sync.headSeq,
      },
      onChange: () => undefined,
    });
    expect(caughtUp.snapshot).toMatchObject({
      labels: [{ name: "Blocked", color: "red" }],
      sync: { mode: "changes", headSeq: 1 },
    });
    const current = await labels.subscribe({
      cursor: {
        generation: caughtUp.snapshot.sync.generation,
        afterSeq: caughtUp.snapshot.sync.headSeq,
      },
      onChange: () => undefined,
    });
    expect(current.snapshot).toMatchObject({
      labels: [],
      sync: { mode: "changes", headSeq: 1, removals: [] },
    });
    current.unsubscribe();
    caughtUp.unsubscribe();

    const expired = await labels.subscribe({
      cursor: { generation: "expired", afterSeq: 1 },
      onChange: () => undefined,
    });
    expect(expired.snapshot).toMatchObject({
      labels: [{ name: "Blocked", color: "red" }],
      sync: { mode: "snapshot", headSeq: 1 },
    });
    expired.unsubscribe();
  });

  test("publishes only to active subscribers and emits no idle or no-op traffic", async () => {
    const updates: unknown[] = [];
    const subscription = await labels.subscribe({ onChange: (change) => updates.push(change) });
    await Promise.resolve();
    expect(updates).toEqual([]);

    await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Quiet", color: "sky" },
      assigned: false,
    });
    expect(updates).toEqual([]);

    subscription.unsubscribe();
    await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Quiet", color: "sky" },
      assigned: true,
    });
    expect(updates).toEqual([]);
  });

  test("compacts rename cycles and chained rename-delete into coherent catch-up changes", async () => {
    await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "A", color: "red" },
      assigned: true,
    });
    const checkpoint = await labels.subscribe({ onChange: () => undefined });

    await labels.rename({ name: "A", newName: "B" });
    await labels.rename({ name: "B", newName: "A" });
    const cycle = await labels.subscribe({
      cursor: {
        generation: checkpoint.snapshot.sync.generation,
        afterSeq: checkpoint.snapshot.sync.headSeq,
      },
      onChange: () => undefined,
    });
    expect(cycle.snapshot).toMatchObject({
      labels: [{ name: "A", color: "red" }],
      sync: { mode: "changes", removals: [] },
    });

    await labels.rename({ name: "A", newName: "B" });
    await labels.rename({ name: "B", newName: "C" });
    await labels.delete("C");
    const deleted = await labels.subscribe({
      cursor: {
        generation: cycle.snapshot.sync.generation,
        afterSeq: cycle.snapshot.sync.headSeq,
      },
      onChange: () => undefined,
    });
    expect(deleted.snapshot).toMatchObject({
      labels: [],
      sync: { mode: "changes", removals: [{ name: "A" }] },
    });

    deleted.unsubscribe();
    cycle.unsubscribe();
    checkpoint.unsubscribe();
  });

  test("renames, recolors, and deletes one host catalog while rewriting assignments", async () => {
    await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Blocked", color: "red" },
      assigned: true,
    });
    expect(await labels.rename({ name: "blocked", newName: "Waiting" })).toMatchObject({
      label: { name: "Waiting", color: "red" },
      affectedWorkspaceCount: 1,
    });
    await expect(labels.rename({ name: "waiting", newName: "" })).rejects.toMatchObject({
      code: "label_name_empty",
    });
    expect(await labels.recolor({ name: "WAITING", color: "amber" })).toEqual({
      label: { name: "Waiting", color: "amber" },
    });
    expect(await labels.delete("waiting")).toEqual({ affectedWorkspaceCount: 1 });
    expect((await registry.get("wks_one"))?.labels).toBeUndefined();
  });

  test("counts the same active and archived records that delete rewrites", async () => {
    await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Blocked", color: "red" },
      assigned: true,
    });
    await registry.archive("wks_one", "2026-08-14T01:00:00.000Z");

    expect(await labels.countAffectedWorkspaces("blocked")).toBe(1);
    expect(await labels.delete("Blocked")).toEqual({ affectedWorkspaceCount: 1 });
    expect((await registry.get("wks_one"))?.labels).toBeUndefined();
  });

  test("rejects rename collisions without changing catalog or assignments", async () => {
    await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Blocked", color: "red" },
      assigned: true,
    });
    await labels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Waiting", color: "amber" },
      assigned: true,
    });

    await expect(labels.rename({ name: "Blocked", newName: "waiting" })).rejects.toMatchObject({
      code: "label_name_taken",
    });
    expect((await registry.get("wks_one"))?.labels).toEqual(["Blocked", "Waiting"]);
    const snapshot = await labels.subscribe({ onChange: () => undefined });
    expect(snapshot.snapshot.labels).toEqual([
      { name: "Blocked", color: "red" },
      { name: "Waiting", color: "amber" },
    ]);
    snapshot.unsubscribe();
  });

  test("blocks when assignment persistence and rollback both fail", async () => {
    let failWrites = false;
    const failingRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "failing-workspaces.json"),
      createTestLogger(),
      {
        writeRecords: async (filePath, records) => {
          if (failWrites) throw new Error("disk full");
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    await failingRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "wks_failing",
        projectId: "prj_one",
        cwd: "/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }),
    );
    const failingLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "failing"),
      workspaceRegistry: failingRegistry,
    });
    failWrites = true;

    await expect(
      failingLabels.setAssignment({
        workspaceId: "wks_failing",
        label: { name: "Urgent", color: "red" },
        assigned: true,
      }),
    ).rejects.toMatchObject({ code: "workspace_label_storage_uncertain" });

    const snapshot = await failingLabels.subscribe({ onChange: () => undefined });
    expect(snapshot.snapshot).toMatchObject({ labels: [], sync: { headSeq: 0 } });
    expect((await failingRegistry.get("wks_failing"))?.labels).toBeUndefined();
    snapshot.unsubscribe();
  });

  test("restores workspace state when catalog persistence fails and keeps the catalog cache authoritative", async () => {
    let failCatalog = true;
    const failingLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "catalog-failure"),
      workspaceRegistry: registry,
      writeCatalog: async (filePath, definitions) => {
        if (failCatalog && definitions.length > 0) throw new Error("catalog disk full");
        await writeJsonFileAtomic(filePath, definitions);
      },
    });

    await expect(
      failingLabels.setAssignment({
        workspaceId: "wks_one",
        label: { name: "Urgent", color: "red" },
        assigned: true,
      }),
    ).rejects.toThrow("catalog disk full");
    expect((await registry.get("wks_one"))?.labels).toBeUndefined();
    const failedSnapshot = await failingLabels.subscribe({ onChange: () => undefined });
    expect(failedSnapshot.snapshot).toMatchObject({ labels: [], sync: { headSeq: 0 } });

    failCatalog = false;
    await failingLabels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    failedSnapshot.unsubscribe();
  });

  test("restores rename and delete assignment rewrites when catalog persistence fails", async () => {
    let failingCatalog: "priority" | "empty" | null = null;
    const failingLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "rewrite-catalog-failure"),
      workspaceRegistry: registry,
      writeCatalog: async (filePath, definitions) => {
        if (
          (failingCatalog === "priority" &&
            definitions.some((label) => label.name === "Priority")) ||
          (failingCatalog === "empty" && definitions.length === 0)
        ) {
          throw new Error("catalog unavailable");
        }
        await writeJsonFileAtomic(filePath, definitions);
      },
    });
    await failingLabels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    failingCatalog = "priority";

    await expect(failingLabels.rename({ name: "Urgent", newName: "Priority" })).rejects.toThrow(
      "catalog unavailable",
    );
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    failingCatalog = "empty";
    await expect(failingLabels.delete("Urgent")).rejects.toThrow("catalog unavailable");
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);

    const snapshot = await failingLabels.subscribe({ onChange: () => undefined });
    expect(snapshot.snapshot).toMatchObject({
      labels: [{ name: "Urgent", color: "red" }],
      sync: { headSeq: 1 },
    });
    snapshot.unsubscribe();
  });

  test("rolls back an interrupted compound rename after restart without publishing transient changes", async () => {
    let workspaceWrite = 0;
    let interruptWorkspaceWrite = false;
    const interruptedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "interrupted-workspaces.json"),
      createTestLogger(),
      {
        writeRecords: async (filePath, records) => {
          workspaceWrite += 1;
          if (interruptWorkspaceWrite && workspaceWrite > 2) {
            throw new Error("process interrupted");
          }
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    await interruptedRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "wks_interrupted",
        projectId: "prj_one",
        cwd: "/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }),
    );
    const interrupted = createWorkspaceLabelService({
      paseoHome,
      workspaceRegistry: interruptedRegistry,
      writeCatalog: writeJsonFileAtomic,
    });
    await interrupted.setAssignment({
      workspaceId: "wks_interrupted",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    const workspacePublications: unknown[] = [];
    const catalogPublications: unknown[] = [];
    interruptedRegistry.subscribeToMutations((mutation) => workspacePublications.push(mutation));
    const subscription = await interrupted.subscribe({
      onChange: (change) => catalogPublications.push(change),
    });
    interruptWorkspaceWrite = true;

    await expect(interrupted.rename({ name: "Urgent", newName: "Priority" })).rejects.toThrow();
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);

    const recoveredRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "interrupted-workspaces.json"),
      createTestLogger(),
    );
    const recovered = createWorkspaceLabelService({
      paseoHome,
      workspaceRegistry: recoveredRegistry,
    });
    await recovered.initialize();
    expect((await recoveredRegistry.get("wks_interrupted"))?.labels).toEqual(["Urgent"]);
    const recoveredSnapshot = await recovered.subscribe({ onChange: () => undefined });
    expect(recoveredSnapshot.snapshot.labels).toEqual([{ name: "Urgent", color: "red" }]);
    recoveredSnapshot.unsubscribe();
    subscription.unsubscribe();
  });

  test("aborts a pre-commit workspace write failure without publishing either surface", async () => {
    let failNextWorkspaceWrite = false;
    const recoveringRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "recovering-workspaces.json"),
      createTestLogger(),
      {
        writeRecords: async (filePath, records) => {
          if (failNextWorkspaceWrite) {
            failNextWorkspaceWrite = false;
            throw new Error("one interrupted write");
          }
          await writeJsonFileAtomic(filePath, records);
        },
      },
    );
    await recoveringRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "wks_recovering",
        projectId: "prj_one",
        cwd: "/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }),
    );
    const recovering = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "recovering"),
      workspaceRegistry: recoveringRegistry,
    });
    await recovering.setAssignment({
      workspaceId: "wks_recovering",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    const workspacePublications: unknown[] = [];
    const catalogPublications: unknown[] = [];
    recoveringRegistry.subscribeToMutations((mutation) => workspacePublications.push(mutation));
    const subscription = await recovering.subscribe({
      onChange: (change) => catalogPublications.push(change),
    });

    failNextWorkspaceWrite = true;
    await expect(recovering.rename({ name: "Urgent", newName: "Priority" })).rejects.toThrow(
      "one interrupted write",
    );

    expect((await recoveringRegistry.get("wks_recovering"))?.labels).toEqual(["Urgent"]);
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);
    subscription.unsubscribe();
  });

  test("treats the journal phase rewrite as the commit point", async () => {
    let failCommitMarker = false;
    const markerLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "commit-marker"),
      workspaceRegistry: registry,
      writeTransaction: async (filePath, transaction) => {
        if (failCommitMarker && transactionPhase(transaction) === "committed") {
          throw new Error("commit marker unavailable");
        }
        await writeJsonFileAtomic(filePath, transaction);
      },
    });
    await markerLabels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    const workspacePublications: unknown[] = [];
    const catalogPublications: unknown[] = [];
    registry.subscribeToMutations((mutation) => workspacePublications.push(mutation));
    const subscription = await markerLabels.subscribe({
      onChange: (change) => catalogPublications.push(change),
    });

    failCommitMarker = true;
    await expect(markerLabels.rename({ name: "Urgent", newName: "Priority" })).rejects.toThrow(
      "commit marker unavailable",
    );
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);

    const restartedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    const restarted = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "commit-marker"),
      workspaceRegistry: restartedRegistry,
    });
    await restarted.initialize();
    expect((await restartedRegistry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    expect((await restarted.subscribe({ onChange: () => undefined })).snapshot.labels).toEqual([
      { name: "Urgent", color: "red" },
    ]);
    subscription.unsubscribe();
  });

  test("does not leave replayable intent when prepared-journal persistence fails", async () => {
    const workspacePublications: unknown[] = [];
    const catalogPublications: unknown[] = [];
    registry.subscribeToMutations((mutation) => workspacePublications.push(mutation));
    const preparedLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "prepared-write"),
      workspaceRegistry: registry,
      writeTransaction: async () => {
        throw new Error("journal unavailable");
      },
    });
    const subscription = await preparedLabels.subscribe({
      onChange: (change) => catalogPublications.push(change),
    });

    await expect(
      preparedLabels.setAssignment({
        workspaceId: "wks_one",
        label: { name: "Urgent", color: "red" },
        assigned: true,
      }),
    ).rejects.toThrow("journal unavailable");
    expect((await registry.get("wks_one"))?.labels).toBeUndefined();
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);

    const restartedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    const restarted = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "prepared-write"),
      workspaceRegistry: restartedRegistry,
    });
    await restarted.initialize();
    expect((await restartedRegistry.get("wks_one"))?.labels).toBeUndefined();
    expect((await restarted.subscribe({ onChange: () => undefined })).snapshot.labels).toEqual([]);
    subscription.unsubscribe();
  });

  test("rolls back a durable prepared marker whose acknowledgement is lost before allowing registry writes", async () => {
    let losePreparedAcknowledgement = false;
    const preparedLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "prepared-lost-ack"),
      workspaceRegistry: registry,
      writeTransaction: async (filePath, transaction) => {
        await writeJsonFileAtomic(filePath, transaction);
        if (losePreparedAcknowledgement && transactionPhase(transaction) === "prepared") {
          throw new Error("lost prepared acknowledgement");
        }
      },
    });
    await preparedLabels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    const workspacePublications: unknown[] = [];
    const catalogPublications: unknown[] = [];
    registry.subscribeToMutations((mutation) => workspacePublications.push(mutation));
    const subscription = await preparedLabels.subscribe({
      onChange: (change) => catalogPublications.push(change),
    });

    losePreparedAcknowledgement = true;
    await expect(preparedLabels.rename({ name: "Urgent", newName: "Priority" })).rejects.toThrow(
      "lost prepared acknowledgement",
    );
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);

    losePreparedAcknowledgement = false;
    const archivedAt = "2099-01-01T00:00:00.000Z";
    await registry.archive("wks_one", archivedAt);
    expect(workspacePublications).toHaveLength(1);

    const restartedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    const restarted = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "prepared-lost-ack"),
      workspaceRegistry: restartedRegistry,
    });
    await restarted.initialize();
    expect(await restartedRegistry.get("wks_one")).toMatchObject({
      labels: ["Urgent"],
      archivedAt,
      updatedAt: archivedAt,
    });
    expect((await restarted.subscribe({ onChange: () => undefined })).snapshot.labels).toEqual([
      { name: "Urgent", color: "red" },
    ]);
    subscription.unsubscribe();
  });

  test("rolls back a durable catalog write whose acknowledgement is lost before allowing registry writes", async () => {
    let loseCatalogAcknowledgement = false;
    const catalogLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "catalog-lost-ack"),
      workspaceRegistry: registry,
      writeCatalog: async (filePath, definitions) => {
        await writeJsonFileAtomic(filePath, definitions);
        if (
          loseCatalogAcknowledgement &&
          definitions.some((definition) => definition.name === "Priority")
        ) {
          throw new Error("lost catalog acknowledgement");
        }
      },
    });
    await catalogLabels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    const workspacePublications: unknown[] = [];
    const catalogPublications: unknown[] = [];
    registry.subscribeToMutations((mutation) => workspacePublications.push(mutation));
    const subscription = await catalogLabels.subscribe({
      onChange: (change) => catalogPublications.push(change),
    });

    loseCatalogAcknowledgement = true;
    await expect(catalogLabels.rename({ name: "Urgent", newName: "Priority" })).rejects.toThrow(
      "lost catalog acknowledgement",
    );
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);

    loseCatalogAcknowledgement = false;
    const archivedAt = "2099-01-02T00:00:00.000Z";
    await registry.archive("wks_one", archivedAt);
    const restartedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    const restarted = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "catalog-lost-ack"),
      workspaceRegistry: restartedRegistry,
    });
    await restarted.initialize();
    expect(await restartedRegistry.get("wks_one")).toMatchObject({
      labels: ["Urgent"],
      archivedAt,
    });
    expect((await restarted.subscribe({ onChange: () => undefined })).snapshot.labels).toEqual([
      { name: "Urgent", color: "red" },
    ]);
    subscription.unsubscribe();
  });

  test("rolls back a durable workspace write whose acknowledgement is lost before allowing later writes", async () => {
    let loseWorkspaceAcknowledgement = false;
    const lostAckRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "lost-ack-workspaces.json"),
      createTestLogger(),
      {
        writeRecords: async (filePath, records) => {
          await writeJsonFileAtomic(filePath, records);
          if (loseWorkspaceAcknowledgement) {
            loseWorkspaceAcknowledgement = false;
            throw new Error("lost workspace acknowledgement");
          }
        },
      },
    );
    await lostAckRegistry.upsert(
      createPersistedWorkspaceRecord({
        workspaceId: "wks_lost_ack",
        projectId: "prj_one",
        cwd: "/repo",
        kind: "local_checkout",
        displayName: "main",
        createdAt: "2026-08-14T00:00:00.000Z",
        updatedAt: "2026-08-14T00:00:00.000Z",
      }),
    );
    const workspaceLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "workspace-lost-ack"),
      workspaceRegistry: lostAckRegistry,
    });
    await workspaceLabels.setAssignment({
      workspaceId: "wks_lost_ack",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    const workspacePublications: unknown[] = [];
    const catalogPublications: unknown[] = [];
    lostAckRegistry.subscribeToMutations((mutation) => workspacePublications.push(mutation));
    const subscription = await workspaceLabels.subscribe({
      onChange: (change) => catalogPublications.push(change),
    });

    loseWorkspaceAcknowledgement = true;
    await expect(workspaceLabels.rename({ name: "Urgent", newName: "Priority" })).rejects.toThrow(
      "lost workspace acknowledgement",
    );
    expect((await lostAckRegistry.get("wks_lost_ack"))?.labels).toEqual(["Urgent"]);
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);

    const archivedAt = "2099-01-03T00:00:00.000Z";
    await lostAckRegistry.archive("wks_lost_ack", archivedAt);
    const restartedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "lost-ack-workspaces.json"),
      createTestLogger(),
    );
    const restarted = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "workspace-lost-ack"),
      workspaceRegistry: restartedRegistry,
    });
    await restarted.initialize();
    expect(await restartedRegistry.get("wks_lost_ack")).toMatchObject({
      labels: ["Urgent"],
      archivedAt,
    });
    expect((await restarted.subscribe({ onChange: () => undefined })).snapshot.labels).toEqual([
      { name: "Urgent", color: "red" },
    ]);
    subscription.unsubscribe();
  });

  test("reports an uncertain outcome when the committed marker is durable before its write rejects", async () => {
    let rejectAfterCommittedWrite = false;
    const uncertainLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "uncertain-commit-marker"),
      workspaceRegistry: registry,
      writeTransaction: async (filePath, transaction) => {
        await writeJsonFileAtomic(filePath, transaction);
        if (rejectAfterCommittedWrite && transactionPhase(transaction) === "committed") {
          throw new Error("lost commit acknowledgement");
        }
      },
    });
    await uncertainLabels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    const workspacePublications: unknown[] = [];
    const catalogPublications: unknown[] = [];
    registry.subscribeToMutations((mutation) => workspacePublications.push(mutation));
    const subscription = await uncertainLabels.subscribe({
      onChange: (change) => catalogPublications.push(change),
    });

    rejectAfterCommittedWrite = true;
    await expect(
      uncertainLabels.rename({ name: "Urgent", newName: "Priority" }),
    ).rejects.toMatchObject({ code: "workspace_label_storage_uncertain" });
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);
    rejectAfterCommittedWrite = false;
    await expect(registry.archive("wks_one", "2099-01-04T00:00:00.000Z")).rejects.toThrow(
      "blocked until daemon restart",
    );
    await expect(uncertainLabels.recolor({ name: "Priority", color: "sky" })).rejects.toMatchObject(
      {
        code: "workspace_label_storage_uncertain",
      },
    );
    expect(workspacePublications).toEqual([]);
    expect(catalogPublications).toEqual([]);

    const restartedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    const restarted = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "uncertain-commit-marker"),
      workspaceRegistry: restartedRegistry,
    });
    await restarted.initialize();
    expect((await restartedRegistry.get("wks_one"))?.labels).toEqual(["Priority"]);
    expect((await restartedRegistry.get("wks_one"))?.archivedAt).toBeNull();
    expect((await restarted.subscribe({ onChange: () => undefined })).snapshot.labels).toEqual([
      { name: "Priority", color: "red" },
    ]);
    subscription.unsubscribe();
  });

  test("keeps a rejected mutation aborted when prepared-journal cleanup also fails", async () => {
    let failAfterCatalog = false;
    const cleanupLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "prepared-cleanup"),
      workspaceRegistry: registry,
      writeCatalog: async (filePath, definitions) => {
        if (failAfterCatalog && definitions.some((label) => label.name === "Priority")) {
          throw new Error("catalog unavailable");
        }
        await writeJsonFileAtomic(filePath, definitions);
      },
      removeTransaction: async () => {
        throw new Error("journal cleanup unavailable");
      },
    });
    await cleanupLabels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    failAfterCatalog = true;

    await expect(
      cleanupLabels.rename({ name: "Urgent", newName: "Priority" }),
    ).rejects.toMatchObject({ code: "workspace_label_storage_uncertain" });
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);

    const restartedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    const restarted = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "prepared-cleanup"),
      workspaceRegistry: restartedRegistry,
    });
    await restarted.initialize();
    expect((await restartedRegistry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    expect((await restarted.subscribe({ onChange: () => undefined })).snapshot.labels).toEqual([
      { name: "Urgent", color: "red" },
    ]);
  });

  test("reports success after the commit point even when committed-journal cleanup fails", async () => {
    let failCleanup = false;
    const cleanupLabels = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "committed-cleanup"),
      workspaceRegistry: registry,
      removeTransaction: async (filePath) => {
        if (failCleanup) throw new Error("journal cleanup unavailable");
        await rm(filePath);
      },
    });
    await cleanupLabels.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Urgent", color: "red" },
      assigned: true,
    });
    failCleanup = true;

    await expect(cleanupLabels.rename({ name: "Urgent", newName: "Priority" })).resolves.toEqual({
      label: { name: "Priority", color: "red" },
      affectedWorkspaceCount: 1,
    });
    const archivedAt = "2099-01-01T00:00:00.000Z";
    await registry.archive("wks_one", archivedAt);

    const restartedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    const restarted = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "committed-cleanup"),
      workspaceRegistry: restartedRegistry,
      removeTransaction: async () => {
        throw new Error("journal cleanup still unavailable");
      },
    });
    await restarted.initialize();
    expect(await restartedRegistry.get("wks_one")).toMatchObject({
      labels: ["Priority"],
      archivedAt,
      updatedAt: archivedAt,
    });
    expect((await restarted.subscribe({ onChange: () => undefined })).snapshot.labels).toEqual([
      { name: "Priority", color: "red" },
    ]);

    const repeatedRegistry = new FileBackedWorkspaceRegistry(
      join(paseoHome, "projects", "workspaces.json"),
      createTestLogger(),
    );
    const repeated = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "committed-cleanup"),
      workspaceRegistry: repeatedRegistry,
      removeTransaction: async () => {
        throw new Error("journal cleanup still unavailable");
      },
    });
    await repeated.initialize();
    expect(await repeatedRegistry.get("wks_one")).toMatchObject({
      labels: ["Priority"],
      archivedAt,
      updatedAt: archivedAt,
    });
  });

  test("does not reject or roll back durable mutations when a workspace listener fails", async () => {
    registry.subscribeToMutations(async () => {
      throw new Error("subscriber failed");
    });

    await expect(
      labels.setAssignment({
        workspaceId: "wks_one",
        label: { name: "Urgent", color: "red" },
        assigned: true,
      }),
    ).resolves.toMatchObject({ workspaceLabels: ["Urgent"] });
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);
  });

  test("does not reject a durable catalog mutation when a subscriber fails", async () => {
    const subscription = await labels.subscribe({
      onChange: () => {
        throw new Error("subscriber failed");
      },
    });

    await expect(
      labels.setAssignment({
        workspaceId: "wks_one",
        label: { name: "Urgent", color: "red" },
        assigned: true,
      }),
    ).resolves.toMatchObject({ workspaceLabels: ["Urgent"] });
    expect((await registry.get("wks_one"))?.labels).toEqual(["Urgent"]);
    subscription.unsubscribe();
  });

  test("preserves concurrent workspace fields while assigning a label", async () => {
    await Promise.all([
      labels.setAssignment({
        workspaceId: "wks_one",
        label: { name: "Urgent", color: "red" },
        assigned: true,
      }),
      registry.update("wks_one", (workspace) => ({ ...workspace, title: "Concurrent title" })),
    ]);

    expect(await registry.get("wks_one")).toMatchObject({
      title: "Concurrent title",
      labels: ["Urgent"],
    });
  });

  test("expires a bounded journal to a coherent snapshot", async () => {
    const bounded = createWorkspaceLabelService({
      paseoHome: join(paseoHome, "bounded"),
      workspaceRegistry: registry,
      journalLimit: 1,
    });
    const checkpoint = await bounded.subscribe({ onChange: () => undefined });
    await bounded.setAssignment({
      workspaceId: "wks_one",
      label: { name: "One", color: "red" },
      assigned: true,
    });
    await bounded.setAssignment({
      workspaceId: "wks_one",
      label: { name: "Two", color: "sky" },
      assigned: true,
    });

    const expired = await bounded.subscribe({
      cursor: {
        generation: checkpoint.snapshot.sync.generation,
        afterSeq: checkpoint.snapshot.sync.headSeq,
      },
      onChange: () => undefined,
    });
    expect(expired.snapshot).toMatchObject({
      labels: [
        { name: "One", color: "red" },
        { name: "Two", color: "sky" },
      ],
      sync: { mode: "snapshot", headSeq: 2 },
    });
    expired.unsubscribe();
    checkpoint.unsubscribe();
  });
});
