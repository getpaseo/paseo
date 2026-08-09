import { test } from "../support/fixtures";
import {
  expandStatusProject,
  expectCollapsedProjectStatus,
  expectProjectStatusHidden,
  expectWorkspaceStatus,
  openAndCollapseStatusProject,
  seedStatusProject,
  startNeedsInputWorkspace,
  startWorkingWorkspace,
} from "../helpers/project-status-badge";

test("a collapsed project surfaces its most urgent hidden workspace status", async ({ page }) => {
  test.setTimeout(120_000);
  const project = await seedStatusProject();

  try {
    await openAndCollapseStatusProject(page, project);
    await expectProjectStatusHidden(page, project);

    await startWorkingWorkspace(project);
    await expectCollapsedProjectStatus(page, project, "Working");

    await startNeedsInputWorkspace(project);
    await expectCollapsedProjectStatus(page, project, "Needs input");

    await expandStatusProject(page, project);
    await expectProjectStatusHidden(page, project);
    await expectWorkspaceStatus(page, "Working workspace", "running");
    await expectWorkspaceStatus(page, "Needs input workspace", "needs_input");
  } finally {
    await project.seed.cleanup().catch(() => undefined);
  }
});
