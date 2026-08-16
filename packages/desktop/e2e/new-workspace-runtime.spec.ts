import { test as base } from "../../app/e2e/support/fixtures";
import {
  createWorkspaceInSelectedRuntime,
  expectNoProbeInWorkspaceProjection,
  expectProbeFailureWithRetry,
  expectProbeSkippedProjectSetup,
  expectProviderAvailable,
  expectFixtureProviderUnavailable,
  expectHostWorkspaceAffordances,
  expectRuntimeChoices,
  expectRuntimeSelected,
  expectSelectedHostRuntimePlacement,
  expectUserWorkspaceRanProjectSetup,
  expectWorkspaceOpenInRuntime,
  gotoNewWorkspaceForRuntime,
  seedGitProjectForRuntime,
  seedNonGitProjectForRuntime,
  selectRuntime,
  retryFailedProbe,
  type SeededRuntimeProject,
} from "../../app/e2e/support/helpers/new-workspace-runtime";
import { getServerId } from "../../app/e2e/support/helpers/server-id";
import {
  openGlobalNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "../../app/e2e/support/helpers/new-workspace";
import { installDesktopRuntime } from "./support/runtime";

const hostOpenTargets = [
  {
    id: "vscode",
    label: "VS Code",
    kind: "editor" as const,
    icon: { kind: "symbol" as const, name: "terminal" as const },
  },
  {
    id: "finder",
    label: "Finder",
    kind: "file-manager" as const,
    icon: { kind: "symbol" as const, name: "folder" as const },
  },
];

const test = base.extend<{
  runtimeProject: SeededRuntimeProject;
  nonGitRuntimeProject: SeededRuntimeProject;
}>({
  runtimeProject: async ({ browserName: _browserName }, provide) => {
    const project = await seedGitProjectForRuntime();
    try {
      await provide(project);
    } finally {
      await project.cleanup();
    }
  },
  nonGitRuntimeProject: async ({ browserName: _browserName }, provide) => {
    const project = await seedNonGitProjectForRuntime();
    try {
      await provide(project);
    } finally {
      await project.cleanup();
    }
  },
});

test("probes and creates a workspace in a selected runtime", async ({ page, runtimeProject }) => {
  await test.step("choose the project and runtime", async () => {
    await installDesktopRuntime(page, {
      serverId: getServerId(),
      manageBuiltInDaemon: false,
      editorTargets: hostOpenTargets,
    });
    await gotoNewWorkspaceForRuntime(page, runtimeProject);
    await expectRuntimeChoices(page, ["Local", "Worktree", "Fixture", "Fixture Failure"]);
    await selectRuntime(page, "Fixture");
  });

  await test.step("show the selected runtime's provider truth", async () => {
    await expectProviderAvailable(page, "Fixture Agent");
    await expectProbeSkippedProjectSetup(runtimeProject);
    await selectRuntime(page, "Local");
    await expectFixtureProviderUnavailable(page);
    await selectRuntime(page, "Fixture");
    await expectProviderAvailable(page, "Fixture Agent");
  });

  await test.step("create and open the workspace", async () => {
    await createWorkspaceInSelectedRuntime(page);
    await expectWorkspaceOpenInRuntime(page, runtimeProject, "fixture");
    await expectUserWorkspaceRanProjectSetup(runtimeProject);
    await expectNoProbeInWorkspaceProjection(page, runtimeProject);
  });

  await test.step("remember the selected runtime", async () => {
    await openGlobalNewWorkspaceComposer(page);
    await selectNewWorkspaceProject(page, runtimeProject);
    await expectRuntimeSelected(page, "Fixture");
  });
});

test("shows probe failure with retry without host providers", async ({ page, runtimeProject }) => {
  await test.step("choose the failing runtime", async () => {
    await installDesktopRuntime(page, { serverId: getServerId(), manageBuiltInDaemon: false });
    await gotoNewWorkspaceForRuntime(page, runtimeProject);
    await selectRuntime(page, "Fixture Failure");
  });

  await test.step("show the runtime error without provider fallback", async () => {
    await expectProbeFailureWithRetry(page, "Fixture probe creation failed");
  });

  await test.step("retry the failed probe", async () => {
    await retryFailedProbe(page);
    await expectProbeFailureWithRetry(page, "Fixture probe creation failed");
  });
});

test("creates Local and Worktree through explicit runtime selection", async ({
  page,
  runtimeProject,
}) => {
  await test.step("create the selected Local workspace without project setup", async () => {
    await installDesktopRuntime(page, {
      serverId: getServerId(),
      manageBuiltInDaemon: false,
      editorTargets: hostOpenTargets,
    });
    await gotoNewWorkspaceForRuntime(page, runtimeProject);
    await selectRuntime(page, "Local");
    await createWorkspaceInSelectedRuntime(page);
    await expectWorkspaceOpenInRuntime(page, runtimeProject, "local");
    await expectSelectedHostRuntimePlacement(runtimeProject, "local", false);
    await expectHostWorkspaceAffordances(page);
  });

  await test.step("create the selected Worktree workspace with project setup", async () => {
    await openGlobalNewWorkspaceComposer(page);
    await selectNewWorkspaceProject(page, runtimeProject);
    await selectRuntime(page, "Worktree");
    await createWorkspaceInSelectedRuntime(page);
    await expectWorkspaceOpenInRuntime(page, runtimeProject, "worktree");
    await expectSelectedHostRuntimePlacement(runtimeProject, "worktree", true);
    await expectHostWorkspaceAffordances(page);
  });
});

test("hides Git runtimes for a non-Git project", async ({ page, nonGitRuntimeProject }) => {
  await installDesktopRuntime(page, { serverId: getServerId(), manageBuiltInDaemon: false });
  await gotoNewWorkspaceForRuntime(page, nonGitRuntimeProject);
  await expectRuntimeChoices(page, ["Local"]);
});
