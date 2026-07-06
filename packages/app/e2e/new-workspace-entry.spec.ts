import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import {
  connectNewWorkspaceDaemonClient,
  expectNewWorkspaceProjectSelected,
  openGlobalNewWorkspaceComposer,
  openNewWorkspaceComposer,
} from "./helpers/new-workspace";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { seedSavedSettingsHosts } from "./helpers/settings";
import { getServerId } from "./helpers/server-id";
import { clickArchiveWorkspaceMenuItem, expectWorkspaceAbsentFromSidebar } from "./helpers/sidebar";
import { waitForSidebarHydration } from "./helpers/workspace-ui";

// Model B entry points into the New Workspace screen. The surviving entries are
// the global button (universal) and each project's per-row New workspace icon
// (preselects that project) — shown for git projects and for non-git projects on
// a multiplicity-capable host. These specs prove the global entry opens the
// screen, the project icon preselects the right project across the reused 'new'
// screen, and non-git projects never offer the worktree Isolation control.

function projectRow(page: import("@playwright/test").Page, projectKey: string) {
  return page.getByTestId(`sidebar-project-row-${projectKey}`);
}

test.describe("New workspace entry points", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;

  test.describe.configure({ timeout: 240_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
  });

  test.afterEach(async () => {
    await client?.close().catch(() => undefined);
  });

  test("the global new-workspace button opens the New Workspace screen", async ({ page }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-global-button-" });

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
        {
          serverId: "secondary-new-workspace-host",
          label: "Secondary host",
          endpoint: "127.0.0.1:9",
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      const globalButton = page.getByTestId("sidebar-global-new-workspace");
      await expect(globalButton).toBeVisible({ timeout: 30_000 });

      await openGlobalNewWorkspaceComposer(page);
      await expect(page.getByTestId("host-chooser")).toHaveCount(0);

      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("host-picker-trigger")).toBeVisible({ timeout: 30_000 });
    } finally {
      await seeded.cleanup();
    }
  });

  test("the New Workspace screen hides the host selector when there is only one host", async ({
    page,
  }) => {
    const seeded: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-single-host-" });

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId: getServerId(),
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(
        page.getByTestId(`sidebar-workspace-row-${getServerId()}:${seeded.workspaceId}`),
      ).toBeVisible({ timeout: 30_000 });

      await openGlobalNewWorkspaceComposer(page);

      await expect(page.getByTestId("new-workspace-project-picker-trigger")).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.getByTestId("host-picker-trigger")).toHaveCount(0);
    } finally {
      await seeded.cleanup();
    }
  });

  test("keeps the in-progress form when the remembered workspace is archived elsewhere", async ({
    page,
  }) => {
    const otherProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "aa-new-workspace-archive-other-",
    });
    const rememberedProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "zz-new-workspace-archive-remembered-",
    });
    const serverId = getServerId();
    const draftText = "keep this new workspace draft";

    try {
      await seedSavedSettingsHosts(page, [
        {
          serverId,
          label: "localhost",
          endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
        },
      ]);

      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await page
        .getByTestId(`sidebar-workspace-row-${serverId}:${rememberedProject.workspaceId}`)
        .click();
      await expect(page).toHaveURL(/\/workspace\//, { timeout: 30_000 });

      await page.goto(`/new?serverId=${encodeURIComponent(serverId)}`);
      await expectNewWorkspaceProjectSelected(page, rememberedProject.projectDisplayName);

      const composer = page.getByRole("textbox", { name: "Message agent..." });
      await expect(composer).toBeEditable({ timeout: 30_000 });
      await composer.fill(draftText);
      await expect(composer).toHaveValue(draftText);

      await clickArchiveWorkspaceMenuItem(page, rememberedProject.workspaceId);
      await expectWorkspaceAbsentFromSidebar(page, rememberedProject.workspaceId);

      await expect(page).toHaveURL(/\/new(?:\?.*)?$/, { timeout: 30_000 });
      await expect(composer).toHaveValue(draftText);
      await expectNewWorkspaceProjectSelected(page, rememberedProject.projectDisplayName);
    } finally {
      await otherProject.cleanup();
      await rememberedProject.cleanup();
    }
  });

  test("each project's row icon preselects that project, and the reused screen resets a stale manual choice across projects", async ({
    page,
  }) => {
    const projectA: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-a-" });
    const projectB: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-b-" });
    const projectC: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-preselect-c-" });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow(page, projectA.projectId)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, projectB.projectId)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, projectC.projectId)).toBeVisible({ timeout: 30_000 });

      // Project A's row icon opens New Workspace with A preselected.
      await openNewWorkspaceComposer(page, {
        projectKey: projectA.projectId,
        projectDisplayName: projectA.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, projectA.projectDisplayName);

      // Manually override the selection to C from inside A's screen. This stale
      // manualProjectKey is what the reused 'new' screen must reset when the next
      // route-driven navigation targets a different project.
      await page.getByTestId("new-workspace-project-picker-trigger").click();
      const optionC = page.getByTestId(`new-workspace-project-picker-option-${projectC.projectId}`);
      await expect(optionC).toBeVisible({ timeout: 30_000 });
      await optionC.click();
      await expectNewWorkspaceProjectSelected(page, projectC.projectDisplayName);

      // Navigate via B's row icon. B must be preselected — the route project wins
      // because the stale manual choice (C) was reset on the route change. If the
      // reset were missing, the trigger would still read C.
      await openNewWorkspaceComposer(page, {
        projectKey: projectB.projectId,
        projectDisplayName: projectB.projectDisplayName,
      });
      await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);
    } finally {
      await projectA.cleanup();
      await projectB.cleanup();
      await projectC.cleanup();
    }
  });

  test("the Isolation control is hidden for a non-git project and shown for a git project", async ({
    page,
  }) => {
    const gitProject: SeededWorkspace = await seedWorkspace({ repoPrefix: "entry-iso-git-" });
    const nonGitProject: SeededWorkspace = await seedWorkspace({
      repoPrefix: "entry-iso-nongit-",
      git: false,
    });

    try {
      await gotoAppShell(page);
      await waitForSidebarHydration(page);
      await expect(projectRow(page, gitProject.projectId)).toBeVisible({ timeout: 30_000 });
      await expect(projectRow(page, nonGitProject.projectId)).toBeVisible({ timeout: 30_000 });

      // Open New Workspace for the non-git project via the global button, then
      // select it in the picker (the per-row icon would preselect it too).
      await openGlobalNewWorkspaceComposer(page);
      const trigger = page.getByTestId("new-workspace-project-picker-trigger");
      await expect(trigger).toBeVisible({ timeout: 30_000 });
      await trigger.click();
      const nonGitOption = page.getByTestId(
        `new-workspace-project-picker-option-${nonGitProject.projectId}`,
      );
      await expect(nonGitOption).toBeVisible({ timeout: 30_000 });
      await nonGitOption.click();
      await expectNewWorkspaceProjectSelected(page, nonGitProject.projectDisplayName);

      // No git checkout means no worktree isolation choice: the Isolation row is
      // absent entirely.
      await expect(page.getByTestId("workspace-create-isolation-trigger")).toHaveCount(0);

      // Switching to the git project on the same screen reveals the Isolation row.
      await trigger.click();
      const gitOption = page.getByTestId(
        `new-workspace-project-picker-option-${gitProject.projectId}`,
      );
      await expect(gitOption).toBeVisible({ timeout: 30_000 });
      await gitOption.click();
      await expectNewWorkspaceProjectSelected(page, gitProject.projectDisplayName);

      await expect(page.getByTestId("workspace-create-isolation-trigger")).toBeVisible({
        timeout: 30_000,
      });
    } finally {
      await gitProject.cleanup();
      await nonGitProject.cleanup();
    }
  });
});
