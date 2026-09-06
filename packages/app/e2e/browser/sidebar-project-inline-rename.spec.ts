import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import {
  cancelProjectInlineRename,
  expectProjectNameOnDaemon,
  expectProjectTitle,
  startProjectInlineRename,
  submitProjectInlineRename,
} from "../support/helpers/rename";

test.describe("Sidebar project inline rename", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  test.afterEach(async () => {
    for (const cleanup of cleanupTasks.toReversed()) {
      await cleanup();
    }
    cleanupTasks.length = 0;
  });

  test("double-clicking a project title opens inline rename and saves on enter", async ({
    page,
  }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "sidebar-project-inline-rename-" });
    cleanupTasks.push(() => workspace.cleanup());

    await gotoAppShell(page);
    await expectProjectTitle(page, workspace.projectKey, workspace.projectDisplayName);

    await startProjectInlineRename(page, workspace.projectKey);
    await submitProjectInlineRename(page, workspace.projectKey, "Inline Renamed Project");

    await expectProjectTitle(page, workspace.projectKey, "Inline Renamed Project");
    await expectProjectNameOnDaemon(
      workspace.client,
      workspace.projectId,
      "Inline Renamed Project",
    );
  });

  test("pressing Escape cancels project inline rename without saving", async ({ page }) => {
    test.setTimeout(120_000);

    const workspace = await seedWorkspace({ repoPrefix: "sidebar-project-inline-cancel-" });
    cleanupTasks.push(() => workspace.cleanup());

    await gotoAppShell(page);
    await expectProjectTitle(page, workspace.projectKey, workspace.projectDisplayName);

    await startProjectInlineRename(page, workspace.projectKey);
    await cancelProjectInlineRename(page, workspace.projectKey);

    await expectProjectTitle(page, workspace.projectKey, workspace.projectDisplayName);
    await expectProjectNameOnDaemon(
      workspace.client,
      workspace.projectId,
      workspace.projectDisplayName,
    );
  });
});
