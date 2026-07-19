// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { buildProjectOptionId, type ScheduleProjectTarget } from "./schedule-project-targets";
import { useScheduleFormModel } from "./use-schedule-form-model";
import type { ScheduleFormSnapshot } from "./schedule-form-model";

const HOSTS = [{ serverId: "host-a", label: "Host A" }] as const;
const PROJECT_A_ID = buildProjectOptionId("host-a", "project-a");

function projectTarget(input: {
  projectKey: string;
  projectName: string;
  cwd: string;
}): ScheduleProjectTarget {
  return {
    optionId: buildProjectOptionId("host-a", input.projectKey),
    serverId: "host-a",
    serverName: "Host A",
    projectKey: input.projectKey,
    projectName: input.projectName,
    cwd: input.cwd,
    isGit: true,
  };
}

function createSnapshot(projectTargets: readonly ScheduleProjectTarget[]): ScheduleFormSnapshot {
  return {
    mode: "create",
    hosts: HOSTS,
    defaults: {
      serverId: "host-a",
      projectTargets,
      preferences: {},
    },
  };
}

describe("useScheduleFormModel", () => {
  afterEach(() => {
    cleanup();
  });

  it("keeps one model instance and draft state while open snapshot inputs churn", () => {
    const firstTargets = [
      projectTarget({ projectKey: "project-a", projectName: "Project A", cwd: "/repo/a" }),
    ];
    const { result, rerender } = renderHook(({ snapshot }) => useScheduleFormModel(snapshot), {
      initialProps: { snapshot: createSnapshot(firstTargets) },
    });
    const openedModel = result.current;

    act(() => {
      openedModel.setName("Draft name");
      openedModel.setPrompt("Run the draft");
      openedModel.setProject(PROJECT_A_ID, { label: "Project A" });
    });

    rerender({
      snapshot: createSnapshot([
        projectTarget({ projectKey: "project-a", projectName: "Project A", cwd: "/repo/a" }),
      ]),
    });

    expect(result.current).toBe(openedModel);
    expect(result.current.getState()).toMatchObject({
      name: "Draft name",
      prompt: "Run the draft",
      selectedServerId: "host-a",
      workingDir: "/repo/a",
      projectDisplay: { label: "Project A" },
      selectedProjectOptionId: PROJECT_A_ID,
    });
  });
});
