import os from "node:os";
import path from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { createTestLogger } from "../test-utils/test-logger.js";
import {
  createPersistedWorkspaceRecord,
  FileBackedWorkspaceRegistry,
  type WorkspaceMutation,
} from "./workspace-registry.js";
import {
  assignWorkspaceTopic,
  createWorkspaceTopic,
  updateWorkspaceTopic,
  WorkspaceTopicError,
} from "./workspace-topics.js";

const NOW = "2026-09-30T02:00:00.000Z";

function workspaceRecord(workspaceId: string) {
  return createPersistedWorkspaceRecord({
    workspaceId,
    projectId: "prj_1",
    cwd: `/repo/${workspaceId}`,
    kind: "worktree",
    displayName: workspaceId,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
  });
}

describe("workspace topics", () => {
  let tmpDir: string;
  let filePath: string;
  let registry: FileBackedWorkspaceRegistry;

  beforeEach(async () => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), "workspace-topics-"));
    filePath = path.join(tmpDir, "projects", "workspaces.json");
    registry = new FileBackedWorkspaceRegistry(filePath, createTestLogger());
    await registry.initialize();
    for (const id of ["wks_phase1", "wks_phase2", "wks_other"]) {
      await registry.upsert(workspaceRecord(id));
    }
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function topicOf(workspaceId: string) {
    return (await registry.get(workspaceId))?.topic;
  }

  test("combining two sessions puts the same topic on both and survives a restart", async () => {
    const { topic } = await createWorkspaceTopic(registry, {
      title: "  Riesling  ",
      description: " Phase 1 and 2 ",
      workspaceIds: ["wks_phase1", "wks_phase2"],
      topicId: "top_riesling",
      now: NOW,
    });

    expect(topic).toEqual({ id: "top_riesling", title: "Riesling", description: "Phase 1 and 2" });
    expect(await topicOf("wks_phase1")).toEqual(topic);
    expect(await topicOf("wks_phase2")).toEqual(topic);
    expect(await topicOf("wks_other")).toBeUndefined();
    expect((await registry.get("wks_phase1"))?.updatedAt).toBe(NOW);

    const restarted = new FileBackedWorkspaceRegistry(filePath, createTestLogger());
    await restarted.initialize();
    expect((await restarted.get("wks_phase2"))?.topic).toEqual(topic);
  });

  test("a third session joins an existing topic by id", async () => {
    const { topic } = await createWorkspaceTopic(registry, {
      title: "Riesling",
      workspaceIds: ["wks_phase1"],
    });
    const joined = await assignWorkspaceTopic(registry, {
      workspaceId: "wks_other",
      topicId: topic.id,
    });
    expect(joined.topic).toEqual(topic);
  });

  test("detaching the last child dissolves the topic", async () => {
    const { topic } = await createWorkspaceTopic(registry, {
      title: "Riesling",
      workspaceIds: ["wks_phase1", "wks_phase2"],
    });
    await assignWorkspaceTopic(registry, { workspaceId: "wks_phase1", topicId: null });
    expect(await topicOf("wks_phase1")).toBeUndefined();
    expect(await topicOf("wks_phase2")).toEqual(topic);
    expect(JSON.parse(readFileSync(filePath, "utf8"))[0]).not.toHaveProperty("topic");

    await assignWorkspaceTopic(registry, { workspaceId: "wks_phase2", topicId: null });
    await expect(
      assignWorkspaceTopic(registry, { workspaceId: "wks_other", topicId: topic.id }),
    ).rejects.toMatchObject({ code: "topic_not_found" });
  });

  test("renaming rewrites every child in one write, archived children included", async () => {
    const { topic } = await createWorkspaceTopic(registry, {
      title: "Riesling",
      description: "old",
      workspaceIds: ["wks_phase1", "wks_phase2"],
    });
    await registry.archive("wks_phase2", NOW);
    const mutations: WorkspaceMutation[] = [];
    registry.subscribeToMutations((mutation) => {
      mutations.push(mutation);
    });

    const renamed = await updateWorkspaceTopic(registry, { topicId: topic.id, title: "Wine" });

    expect(renamed.topic).toEqual({ id: topic.id, title: "Wine", description: "old" });
    expect(await topicOf("wks_phase1")).toEqual(renamed.topic);
    expect(await topicOf("wks_phase2")).toEqual(renamed.topic);
    expect(mutations.map((mutation) => mutation.workspaceId).sort()).toEqual([
      "wks_phase1",
      "wks_phase2",
    ]);

    const cleared = await updateWorkspaceTopic(registry, { topicId: topic.id, description: null });
    expect(cleared.topic.description).toBeNull();
  });

  test("an archived child keeps its topic, so restoring it returns it to the topic", async () => {
    const { topic } = await createWorkspaceTopic(registry, {
      title: "Riesling",
      workspaceIds: ["wks_phase1", "wks_phase2"],
    });
    await registry.archive("wks_phase1", NOW);
    await registry.update("wks_phase1", (record) => ({ ...record, archivedAt: null }));
    expect(await topicOf("wks_phase1")).toEqual(topic);
  });

  test("renaming a child workspace leaves the topic alone", async () => {
    const { topic } = await createWorkspaceTopic(registry, {
      title: "Riesling",
      workspaceIds: ["wks_phase1"],
    });
    await registry.update("wks_phase1", (record) => ({ ...record, title: "Phase one" }));
    expect(await topicOf("wks_phase1")).toEqual(topic);
  });

  test("creating a topic moves a workspace out of its previous topic", async () => {
    const first = await createWorkspaceTopic(registry, {
      title: "First",
      workspaceIds: ["wks_phase1"],
    });
    const second = await createWorkspaceTopic(registry, {
      title: "Second",
      workspaceIds: ["wks_phase1", "wks_phase2"],
    });
    expect(await topicOf("wks_phase1")).toEqual(second.topic);
    await expect(
      updateWorkspaceTopic(registry, { topicId: first.topic.id, title: "Gone" }),
    ).rejects.toMatchObject({ code: "topic_not_found" });
  });

  test("a failed create writes nothing", async () => {
    await registry.archive("wks_other", NOW);
    const attempts = [
      { title: "   ", workspaceIds: ["wks_phase1"], code: "topic_title_required" },
      { title: "Riesling", workspaceIds: [], code: "topic_needs_workspaces" },
      {
        title: "Riesling",
        workspaceIds: ["wks_phase1", "wks_missing"],
        code: "workspace_not_found",
      },
      { title: "Riesling", workspaceIds: ["wks_phase1", "wks_other"], code: "workspace_archived" },
    ];
    for (const { code, ...input } of attempts) {
      const failure = await createWorkspaceTopic(registry, input).catch((error) => error);
      expect(failure).toBeInstanceOf(WorkspaceTopicError);
      expect(failure.code).toBe(code);
    }
    expect(await topicOf("wks_phase1")).toBeUndefined();
  });
});
