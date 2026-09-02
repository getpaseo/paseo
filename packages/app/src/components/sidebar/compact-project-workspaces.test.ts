import { describe, expect, it } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { buildCompactProjectWorkspaceTargets } from "./compact-project-workspaces";

function workspace(
  input: Pick<SidebarWorkspaceEntry, "workspaceKey" | "workspaceId"> &
    Partial<SidebarWorkspaceEntry>,
): SidebarWorkspaceEntry {
  return {
    serverId: "host-a",
    projectViewKey: "project-a",
    projectName: "Project A",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: input.workspaceId,
    title: null,
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: false,
    archiveUnpushedCommitCount: 0,
    scripts: [],
    hasRunningScripts: false,
    scheduleId: null,
    ...input,
  };
}

describe("compact project workspace targets", () => {
  it("groups normal workspaces and schedule runs into one target each", () => {
    const oldWork = workspace({
      workspaceKey: "host-a:work-old",
      workspaceId: "work-old",
      statusEnteredAt: new Date("2026-08-24T10:00:00.000Z"),
    });
    const runningWork = workspace({
      workspaceKey: "host-a:work-new",
      workspaceId: "work-new",
      statusBucket: "running",
      statusEnteredAt: new Date("2026-08-26T10:00:00.000Z"),
    });
    const oldRun = workspace({
      workspaceKey: "host-a:run-old",
      workspaceId: "run-old",
      scheduleId: "schedule-1",
      statusEnteredAt: new Date("2026-08-25T10:00:00.000Z"),
    });
    const runningRun = workspace({
      workspaceKey: "host-a:run-new",
      workspaceId: "run-new",
      scheduleId: "schedule-2",
      statusBucket: "running",
      statusEnteredAt: new Date("2026-08-26T10:00:00.000Z"),
    });

    const targets = buildCompactProjectWorkspaceTargets({
      workspaces: [oldWork, runningWork, oldRun, runningRun],
      selection: null,
    });

    expect(targets).toHaveLength(2);
    expect(targets[0]).toMatchObject({
      key: "project:project-a:work",
      workspace: runningWork,
      statusBucket: "running",
      selected: false,
    });
    expect(targets[1]).toMatchObject({
      key: "project:project-a:schedule",
      workspace: runningRun,
      statusBucket: "running",
      selected: false,
    });
  });

  it("keeps the selected run as the grouped navigation target", () => {
    const selectedRun = workspace({
      workspaceKey: "host-a:run-old",
      workspaceId: "run-old",
      scheduleId: "schedule-1",
      statusEnteredAt: new Date("2026-08-25T10:00:00.000Z"),
    });
    const runningRun = workspace({
      workspaceKey: "host-a:run-new",
      workspaceId: "run-new",
      scheduleId: "schedule-1",
      statusBucket: "running",
      statusEnteredAt: new Date("2026-08-26T10:00:00.000Z"),
    });

    const [target] = buildCompactProjectWorkspaceTargets({
      workspaces: [selectedRun, runningRun],
      selection: { serverId: "host-a", workspaceId: selectedRun.workspaceId },
    });

    expect(target).toMatchObject({
      workspace: selectedRun,
      statusBucket: "running",
      selected: true,
    });
  });

  it("keeps different projects separate", () => {
    const projectA = workspace({
      workspaceKey: "host-a:project-a",
      workspaceId: "project-a",
    });
    const projectB = workspace({
      workspaceKey: "host-a:project-b",
      workspaceId: "project-b",
      projectViewKey: "project-b",
    });

    expect(
      buildCompactProjectWorkspaceTargets({
        workspaces: [projectA, projectB],
        selection: null,
      }).map((target) => target.key),
    ).toEqual(["project:project-a:work", "project:project-b:work"]);
  });
});
