import type {
  AgentMode,
  AgentModelDefinition,
  ProviderSnapshotEntry,
} from "@getpaseo/protocol/agent-types";
import type { ScheduleSummary } from "@getpaseo/protocol/schedule/types";
import { describe, expect, it } from "vitest";
import { buildProjectOptionId, type ScheduleProjectTarget } from "./schedule-project-targets";
import { openScheduleForm, type ScheduleFormSnapshot } from "./schedule-form-model";

type TestSchedule = ScheduleSummary & { serverId: string; serverName: string };

const HOSTS = [
  { serverId: "host-a", label: "Host A", supportsWorkspaceMultiplicity: true },
  { serverId: "host-b", label: "Host B", supportsWorkspaceMultiplicity: true },
] as const;

const MOCK_MODES: AgentMode[] = [{ id: "load-test", label: "Load test" }];

const HOST_A_MODELS: AgentModelDefinition[] = [
  {
    provider: "mock",
    id: "model-a",
    label: "Model A",
    isDefault: true,
  },
];

const HOST_B_MODELS: AgentModelDefinition[] = [
  {
    provider: "mock",
    id: "model-b",
    label: "Model B",
    isDefault: true,
    defaultThinkingOptionId: "high",
    thinkingOptions: [
      { id: "low", label: "Low" },
      { id: "high", label: "High", isDefault: true },
    ],
  },
];

function target(input: {
  serverId: string;
  projectKey: string;
  projectName: string;
  cwd: string;
  isGit?: boolean;
}): ScheduleProjectTarget {
  return {
    optionId: buildProjectOptionId(input.serverId, input.projectKey),
    serverId: input.serverId,
    serverName: input.serverId === "host-a" ? "Host A" : "Host B",
    projectKey: input.projectKey,
    projectName: input.projectName,
    cwd: input.cwd,
    isGit: input.isGit ?? true,
  };
}

const PROJECT_TARGETS = [
  target({
    serverId: "host-a",
    projectKey: "project-a",
    projectName: "Project A",
    cwd: "/repo/a",
  }),
  target({
    serverId: "host-b",
    projectKey: "project-b",
    projectName: "Project B",
    cwd: "/repo/b",
  }),
];

function scheduleOnHost(input: {
  serverId: string;
  serverName: string;
  cwd: string;
  model: string;
  cadence?: ScheduleSummary["cadence"];
}): TestSchedule {
  return {
    id: `schedule-${input.serverId}`,
    serverId: input.serverId,
    serverName: input.serverName,
    name: "Nightly",
    prompt: "Run the schedule",
    cadence: input.cadence ?? { type: "cron", expression: "0 9 * * *" },
    target: {
      type: "new-agent",
      config: {
        provider: "mock",
        cwd: input.cwd,
        model: input.model,
        modeId: "load-test",
        thinkingOptionId: "high",
        archiveOnFinish: false,
        isolation: "worktree",
      },
    },
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    nextRunAt: "2026-07-02T00:00:00.000Z",
    lastRunAt: null,
    pausedAt: null,
    expiresAt: null,
    maxRuns: 3,
  };
}

function providerSnapshot(models: AgentModelDefinition[]): { entries: ProviderSnapshotEntry[] } {
  return {
    entries: [
      {
        provider: "mock",
        label: "Mock",
        status: "ready",
        enabled: true,
        fetchedAt: "2026-07-01T00:00:00.000Z",
        models,
        modes: MOCK_MODES,
        defaultModeId: "load-test",
      },
    ],
  };
}

function open(snapshot: Omit<ScheduleFormSnapshot, "hosts">) {
  return openScheduleForm({
    ...snapshot,
    hosts: HOSTS,
  });
}

function openWithHosts(snapshot: ScheduleFormSnapshot) {
  return openScheduleForm(snapshot);
}

describe("schedule form model", () => {
  it("opens edit from the schedule host snapshot and completes that host resolution", () => {
    const previous = open({
      mode: "edit",
      schedule: scheduleOnHost({
        serverId: "host-a",
        serverName: "Host A",
        cwd: "/repo/a",
        model: "model-a",
      }),
      defaults: { serverId: null, projectTargets: PROJECT_TARGETS, preferences: {} },
    });
    previous.applyProviderSnapshot("host-a", providerSnapshot(HOST_A_MODELS));
    previous.close();

    const form = open({
      mode: "edit",
      schedule: scheduleOnHost({
        serverId: "host-b",
        serverName: "Host B",
        cwd: "/repo/b",
        model: "model-b",
      }),
      defaults: { serverId: null, projectTargets: PROJECT_TARGETS, preferences: {} },
    });

    expect(form.getState()).toMatchObject({
      mode: "edit",
      selectedServerId: "host-b",
      workingDir: "/repo/b",
      selectedProvider: "mock",
      selectedModel: "model-b",
      selectedMode: "load-test",
      selectedThinkingOptionId: "high",
      projectDisplay: { label: "Project B" },
      selectedProjectOptionId: buildProjectOptionId("host-b", "project-b"),
      archiveOnFinish: false,
      isolation: "worktree",
      effectiveIsolation: "worktree",
      providerResolutionByServerId: { "host-b": "pending" },
      providerSnapshotRequest: {
        serverId: "host-b",
        cwd: "/repo/b",
      },
    });

    form.applyProviderSnapshot("host-b", providerSnapshot(HOST_B_MODELS));

    expect(form.getState()).toMatchObject({
      selectedServerId: "host-b",
      selectedModelDisplay: { label: "Model B" },
      selectedModeDisplay: { label: "Load test" },
      selectedThinkingDisplay: { label: "High" },
      providerResolutionByServerId: { "host-b": "complete" },
      providerSnapshotRequest: null,
    });
  });

  it("opens create pristine after an edit instance closes", () => {
    const edit = open({
      mode: "edit",
      schedule: scheduleOnHost({
        serverId: "host-b",
        serverName: "Host B",
        cwd: "/repo/b",
        model: "model-b",
      }),
      defaults: { serverId: null, projectTargets: PROJECT_TARGETS, preferences: {} },
    });
    edit.close();

    const create = open({
      mode: "create",
      defaults: { serverId: "host-a", projectTargets: PROJECT_TARGETS, preferences: {} },
    });

    expect(create.getState()).toMatchObject({
      mode: "create",
      selectedServerId: "host-a",
      workingDir: "",
      selectedProvider: null,
      selectedModel: "",
      selectedMode: "",
      selectedThinkingOptionId: "",
      projectDisplay: null,
      selectedProjectOptionId: "",
      selectedModelDisplay: null,
      selectedThinkingDisplay: null,
      archiveOnFinish: true,
      isolation: "local",
      effectiveIsolation: "local",
      providerResolutionByServerId: {},
    });
  });

  it("derives the host to project to model disclosure chain from model state", () => {
    const form = open({
      mode: "create",
      defaults: { serverId: "host-a", projectTargets: PROJECT_TARGETS, preferences: {} },
    });

    expect(form.getState().disclosure).toEqual({
      showProjectField: true,
      showModelField: false,
      showThinkingField: false,
      showModeField: false,
      showIsolationField: false,
      showArchiveOnFinishField: false,
    });

    form.setProject(buildProjectOptionId("host-a", "project-a"), { label: "Project A" });

    expect(form.getState().disclosure).toEqual({
      showProjectField: true,
      showModelField: true,
      showThinkingField: false,
      showModeField: false,
      showIsolationField: true,
      showArchiveOnFinishField: true,
    });

    form.applyProviderSnapshot("host-a", providerSnapshot(HOST_B_MODELS));
    form.setModel("mock", "model-b");

    expect(form.getState().disclosure).toEqual({
      showProjectField: true,
      showModelField: true,
      showThinkingField: true,
      showModeField: true,
      showIsolationField: true,
      showArchiveOnFinishField: true,
    });
  });

  it("hides isolation unless the selected project can create a worktree", () => {
    const nonGitTarget = target({
      serverId: "host-a",
      projectKey: "plain-project",
      projectName: "Plain Project",
      cwd: "/tmp/plain",
      isGit: false,
    });
    const nonGit = open({
      mode: "create",
      defaults: { serverId: "host-a", projectTargets: [nonGitTarget], preferences: {} },
    });

    nonGit.setProject(nonGitTarget.optionId, { label: "Plain Project" });

    expect(nonGit.getState().disclosure).toMatchObject({
      showIsolationField: false,
      showArchiveOnFinishField: true,
    });

    const gitTarget = target({
      serverId: "host-a",
      projectKey: "git-project",
      projectName: "Git Project",
      cwd: "/tmp/git",
      isGit: true,
    });
    const unsupportedHost = openWithHosts({
      mode: "create",
      hosts: [{ serverId: "host-a", label: "Host A" }],
      defaults: { serverId: "host-a", projectTargets: [gitTarget], preferences: {} },
    });

    unsupportedHost.setProject(gitTarget.optionId, { label: "Git Project" });

    expect(unsupportedHost.getState().disclosure).toMatchObject({
      showIsolationField: false,
      showArchiveOnFinishField: true,
    });
  });

  it("normalizes interval cadences to cron cadences when opening the form", () => {
    const form = open({
      mode: "edit",
      schedule: scheduleOnHost({
        serverId: "host-a",
        serverName: "Host A",
        cwd: "/repo/a",
        model: "model-a",
        cadence: { type: "every", everyMs: 60_000 },
      }),
      defaults: {
        serverId: null,
        projectTargets: PROJECT_TARGETS,
        preferences: {},
        timezone: "Europe/Madrid",
      },
    });

    expect(form.getState().cadence).toEqual({
      type: "cron",
      expression: "* * * * *",
      timezone: "Europe/Madrid",
    });
  });

  it("applies new project targets without resetting selected values", () => {
    const projectA = PROJECT_TARGETS[0];
    const form = open({
      mode: "create",
      defaults: { serverId: "host-a", projectTargets: [projectA], preferences: {} },
    });
    form.setName("Draft name");
    form.setPrompt("Draft prompt");
    form.setProject(projectA.optionId, { label: "Project A" });

    form.applyProjectTargets([
      projectA,
      target({
        serverId: "host-a",
        projectKey: "project-c",
        projectName: "Project C",
        cwd: "/repo/c",
      }),
    ]);

    expect(form.getState()).toMatchObject({
      name: "Draft name",
      prompt: "Draft prompt",
      selectedServerId: "host-a",
      workingDir: "/repo/a",
      projectDisplay: { label: "Project A" },
      selectedProjectOptionId: projectA.optionId,
      projectOptions: [
        {
          id: projectA.optionId,
          value: projectA.optionId,
          label: "Project A",
          testID: "schedule-project-option-project-a",
        },
        {
          id: buildProjectOptionId("host-a", "project-c"),
          value: buildProjectOptionId("host-a", "project-c"),
          label: "Project C",
          testID: "schedule-project-option-project-c",
        },
      ],
    });
  });
});
