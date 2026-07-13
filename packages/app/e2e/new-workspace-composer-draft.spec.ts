import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import {
  expectNewWorkspaceProjectSelected,
  openGlobalNewWorkspaceComposer,
  openNewWorkspaceComposer,
  selectNewWorkspaceProject,
} from "./helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { seedSavedSettingsHosts } from "./helpers/settings";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

const DRAFT = `Please investigate the workspace startup failure.

Trace the request from the app through the daemon, preserve the existing behavior, and explain the root cause before making changes.`;

test.describe("New workspace composer draft", () => {
  test.describe.configure({ timeout: 240_000 });

  test("keeps the draft when the project changes", async ({ page }) => {
    const firstProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-project-a-",
    });
    const secondProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-project-b-",
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openNewWorkspaceComposer(page, {
        projectKey: firstProject.projectId,
        projectDisplayName: firstProject.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, firstProject.projectDisplayName);

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await composer.fill(DRAFT);

      await selectNewWorkspaceProject(page, {
        projectKey: secondProject.projectId,
        projectDisplayName: secondProject.projectDisplayName,
      });

      await expect(composer).toHaveValue(DRAFT);
    } finally {
      await secondProject.cleanup();
      await firstProject.cleanup();
    }
  });

  test("keeps the draft when the host changes", async ({ page }) => {
    const project: SeededWorkspace = await seedWorkspace({
      repoPrefix: "new-workspace-draft-host-",
    });
    const secondaryServerId = "new-workspace-draft-secondary-host";

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "Primary host",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: secondaryServerId,
          label: "Secondary host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await openGlobalNewWorkspaceComposer(page);

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await composer.fill(DRAFT);

      await page.getByTestId("host-picker-trigger").click();
      await page.getByTestId(`new-workspace-host-picker-option-${secondaryServerId}`).click();

      await expect(composer).toHaveValue(DRAFT);
    } finally {
      await project.cleanup();
    }
  });
});
