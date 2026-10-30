import { expect, it } from "vitest";
import type { WorkspaceActivity, WorkspaceStatusDetails } from "@getpaseo/protocol/messages";
import { projectWorkspaceStatusActivities, projectWorkspaceStatusDetails } from "./renderer-model";

it("distinguishes unavailable inventories from known empty inventories", () => {
  expect(projectWorkspaceStatusDetails(undefined)).toBeNull();
  expect(projectWorkspaceStatusActivities(undefined)).toBeNull();
  expect(
    projectWorkspaceStatusDetails({
      nativeStatus: "done",
      rootStatus: "done",
      roots: [],
      subordinates: [],
    })?.roots,
  ).toEqual([]);
  expect(projectWorkspaceStatusActivities([])).toEqual([]);
});

it("caches immutable copies without freezing or exposing normalized store references", () => {
  const details: WorkspaceStatusDetails = {
    nativeStatus: "running",
    rootStatus: "done",
    roots: [
      {
        id: "root",
        provider: "codex",
        label: "Root",
        status: "done",
        lifecycleStatus: "idle",
        parentAgentId: null,
        parentWorkspaceId: null,
      },
    ],
    subordinates: [
      {
        id: "paseo/child",
        source: "paseo",
        kind: "subagent",
        provider: "codex",
        label: null,
        status: "running",
        count: 1,
        parentAgentId: "root",
        parentSubagentId: null,
      },
    ],
  };
  const projected = projectWorkspaceStatusDetails(details)!;
  expect(projectWorkspaceStatusDetails(details)).toBe(projected);
  expect(projected.roots[0]).not.toBe(details.roots[0]);
  expect(() => Object.assign(projected.roots[0]!, { label: "mutated" })).toThrow();
  expect(Object.isFrozen(projected.subordinates)).toBe(true);
  expect(details.roots[0]?.label).toBe("Root");
  expect(Object.isFrozen(details)).toBe(false);
  const activities: WorkspaceActivity[] = [
    {
      id: "p/a",
      activityId: "a",
      pluginId: "p",
      workspaceId: "w",
      kind: "shell",
      label: "Shell",
      status: "running",
      changedAt: "now",
      items: [{ id: "task-1", label: "Build" }],
    },
  ];
  const projectedActivities = projectWorkspaceStatusActivities(activities)!;
  expect(projectWorkspaceStatusActivities(activities)).toBe(projectedActivities);
  expect(() =>
    Object.assign(projectedActivities[0]?.items?.[0] ?? {}, { label: "mutated" }),
  ).toThrow();
  expect(activities[0]?.items?.[0]?.label).toBe("Build");
});
