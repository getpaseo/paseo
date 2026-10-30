import { describe, expect, it } from "vitest";
import type { WorkspaceActivityInput } from "@getpaseo/protocol/workspace-activity";
import { WorkspaceActivityRegistry } from "./workspace-activities.js";
import { WorkerWorkspaceActivities } from "./worker-workspace-activities.js";

const input: WorkspaceActivityInput = {
  id: "task-1",
  workspaceId: "workspace-1",
  kind: "async-shell",
  label: "Background task",
  status: "running",
  icon: "Timer",
  count: 1,
};

describe("workspace activity ownership", () => {
  it("isolates installations, preserves unchanged timestamps, and notifies affected workspaces", () => {
    let now = Date.parse("2026-10-27T12:00:00Z");
    const registry = new WorkspaceActivityRegistry(() => now);
    const changed: string[][] = [];
    registry.subscribe((ids) => changed.push([...ids]));
    registry.replace({ pluginId: "shell", instanceId: "first" }, [input]);
    const first = registry.list()[0];
    now += 1000;
    registry.replace({ pluginId: "shell", instanceId: "first" }, [{ ...input }]);
    expect(registry.list()[0]).toEqual(first);
    expect(changed).toEqual([["workspace-1"]]);

    registry.replace({ pluginId: "other-shell", instanceId: "second" }, [input]);
    registry.replace({ pluginId: "shell", instanceId: "first" }, [{ ...input, count: 2 }]);
    expect(registry.list()).toEqual([
      expect.objectContaining({ id: "other-shell/task-1", pluginId: "other-shell", count: 1 }),
      expect.objectContaining({
        id: "shell/task-1",
        count: 2,
        changedAt: new Date(now).toISOString(),
      }),
    ]);
    registry.removeOwner("first");
    expect(registry.list().map((activity) => activity.id)).toEqual(["other-shell/task-1"]);
    registry.removeOwner("first");
    expect(changed).toHaveLength(4);
  });

  it("late cleanup from a previous instance cannot remove a reloaded plugin's activities", () => {
    const registry = new WorkspaceActivityRegistry();
    registry.replace({ pluginId: "shell", instanceId: "old" }, [input]);
    registry.removeOwner("old");
    registry.replace({ pluginId: "shell", instanceId: "new" }, [input]);
    registry.removeOwner("old");
    expect(registry.list()).toHaveLength(1);
  });

  it("clears archived workspaces and rejects revival through later full snapshots", () => {
    const registry = new WorkspaceActivityRegistry();
    const owner = { pluginId: "shell", instanceId: "first" };
    const other = { ...input, id: "task-2", workspaceId: "workspace-2" };
    registry.replace(owner, [input, other]);
    registry.archiveWorkspace("workspace-1");
    registry.replace(owner, [{ ...input, count: 2 }, other]);
    expect(registry.list().map((activity) => activity.workspaceId)).toEqual(["workspace-2"]);
  });
});

describe("workspace activity registration", () => {
  it("publishes changing group membership even when the task count stays equal", () => {
    let now = 0;
    const registry = new WorkspaceActivityRegistry(() => now);
    const owner = { pluginId: "shell", instanceId: "first" };
    const snapshots: WorkspaceActivityInput[][] = [];
    const worker = new WorkerWorkspaceActivities((activities) => {
      snapshots.push(activities);
      registry.replace(owner, activities);
    });
    const firstItem = { id: "shell-a", label: "Build" };
    const registration = worker.add({ ...input, items: [firstItem] });
    expect(registry.list()[0]?.items).toEqual([firstItem]);
    now = 1000;
    registration.update({ items: [{ id: "shell-b", label: "Tests" }] });
    expect(registry.list()[0]).toMatchObject({
      count: 1,
      items: [{ id: "shell-b", label: "Tests" }],
      changedAt: new Date(now).toISOString(),
    });
    registration.update({ items: [firstItem, { id: "shell-b", label: "Tests" }] });
    expect(registry.list()[0]?.count).toBe(2);
    expect(() => registration.update({ count: 3 })).toThrow("count must equal");
    expect(() => registration.update({ items: [firstItem, firstItem] })).toThrow(
      "duplicate item ids",
    );
    const snapshot = worker.snapshot();
    snapshot[0]!.items![0]!.label = "mutated externally";
    expect(worker.snapshot()[0]?.items?.[0]?.label).toBe("Build");
    expect(snapshots).toHaveLength(3);
  });

  it("updates one registration, removes idempotently, and cannot revive removed handles", () => {
    const snapshots: WorkspaceActivityInput[][] = [];
    const worker = new WorkerWorkspaceActivities((activities) => snapshots.push(activities));
    const registration = worker.add(input);
    registration.update({ count: 1 });
    expect(snapshots).toHaveLength(1);
    registration.update({ count: 3, status: "attention" });
    expect(worker.snapshot()).toEqual([{ ...input, count: 3, status: "attention" }]);
    registration.remove();
    registration.remove();
    expect(worker.snapshot()).toEqual([]);
    expect(snapshots).toHaveLength(3);
    expect(() => registration.update({ count: 1 })).toThrow("no longer registered");
  });

  it("rejects invalid counts and duplicate ids without losing existing activity", () => {
    const worker = new WorkerWorkspaceActivities(() => {});
    const registration = worker.add(input);
    expect(() => worker.add(input)).toThrow("Duplicate");
    expect(() => registration.update({ count: 0 })).toThrow();
    expect(() => registration.update({ count: 1.5 })).toThrow();
    expect(worker.snapshot()).toEqual([input]);
    worker.close();
    expect(worker.snapshot()).toEqual([]);
    expect(() => worker.add(input)).toThrow("closed");
    expect(() => registration.update({ count: 2 })).toThrow("no longer registered");
  });
});
