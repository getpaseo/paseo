import { expect, test } from "./fixtures";
import { gotoAppShell } from "./helpers/app";
import { getE2EDaemonPort } from "./helpers/daemon-port";
import {
  expectNewWorkspaceProjectSelected,
  openGlobalNewWorkspaceComposer,
} from "./helpers/new-workspace";
import { seedWorkspace, type SeededWorkspace } from "./helpers/seed-client";
import { getServerId } from "./helpers/server-id";
import { seedSavedSettingsHosts } from "./helpers/settings";
import { LAST_WORKSPACE_SELECTION_STORAGE_KEY } from "@/stores/last-workspace-selection";
import { buildHostWorkspaceRoute, buildNewWorkspaceRoute } from "@/utils/host-routes";
import { switchWorkspaceViaSidebar, waitForSidebarHydration } from "./helpers/workspace-ui";

const OFFLINE_SERVER_IDS = [
  "srv_e2e_preselect_offline_1",
  "srv_e2e_preselect_offline_2",
  "srv_e2e_preselect_offline_3",
];

// New Workspace preselection is a form-context decision, not startup routing.
// Entry points from a workspace should carry the current project context, and a
// plain /new must not let a stale remembered offline host steal the initial host
// when there is exactly one online saved host.

async function pressNewWorkspaceShortcut(page: import("@playwright/test").Page): Promise<void> {
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.press(`${modifier}+n`);
  await expect(page).toHaveURL(/\/new(?:\?.*)?$/, { timeout: 30_000 });
}

async function expectProjectPreselectedWithin(
  page: import("@playwright/test").Page,
  projectDisplayName: string,
  timeout: number,
): Promise<void> {
  const projectPicker = page.getByRole("button", { name: "Workspace project" });
  await expect(projectPicker).toContainText(projectDisplayName, { timeout });
}

async function expectAnyProjectPreselectedWithin(
  page: import("@playwright/test").Page,
  timeout: number,
): Promise<void> {
  const projectPicker = page.getByRole("button", { name: "Workspace project" });
  await expect(projectPicker).toBeVisible({ timeout });
  await expect
    .poll(
      async () => {
        const label = ((await projectPicker.textContent()) ?? "").trim();
        return label || "Choose project";
      },
      { timeout },
    )
    .not.toBe("Choose project");
}

async function openColdRestoredWorkspaceWithOfflineHostFirst(
  page: import("@playwright/test").Page,
  workspace: SeededWorkspace,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId, workspaceId }) => {
      localStorage.setItem(storageKey, JSON.stringify({ serverId, workspaceId }));
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: connectedServerId,
      workspaceId: workspace.workspaceId,
    },
  );

  await page.goto("/");
  await expect(page).toHaveURL(buildHostWorkspaceRoute(connectedServerId, workspace.workspaceId), {
    timeout: 60_000,
  });
  await waitForSidebarHydration(page);
}

async function openNewWorkspaceWithStaleOfflineSelection(
  page: import("@playwright/test").Page,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ serverId, workspaceId: "wks_stale_offline" }),
      );
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: OFFLINE_SERVER_IDS[0]!,
    },
  );

  await page.goto(buildNewWorkspaceRoute());
  await expect(page.getByTestId("host-picker-trigger")).toBeVisible({ timeout: 60_000 });
}

async function seedOfflineHostsWithStaleSelection(
  page: import("@playwright/test").Page,
): Promise<void> {
  const connectedServerId = getServerId();
  await seedSavedSettingsHosts(page, [
    ...OFFLINE_SERVER_IDS.map((serverId, index) => ({
      serverId,
      label: `Offline host ${index + 1}`,
      endpoint: `127.0.0.1:${index + 1}`,
    })),
    {
      serverId: connectedServerId,
      label: "Connected host",
      endpoint: `127.0.0.1:${getE2EDaemonPort()}`,
    },
  ]);
  await page.evaluate(
    ({ storageKey, serverId }) => {
      localStorage.setItem(
        storageKey,
        JSON.stringify({ serverId, workspaceId: "wks_stale_offline" }),
      );
    },
    {
      storageKey: LAST_WORKSPACE_SELECTION_STORAGE_KEY,
      serverId: OFFLINE_SERVER_IDS[0]!,
    },
  );
}

test.describe("New workspace preselects the open workspace's project", () => {
  test.describe.configure({ timeout: 240_000 });

  let projectA: SeededWorkspace;
  let projectB: SeededWorkspace;

  test.beforeEach(async () => {
    projectA = await seedWorkspace({ repoPrefix: "preselect-a-" });
    projectB = await seedWorkspace({ repoPrefix: "preselect-b-" });
  });

  test.afterEach(async () => {
    await projectA?.cleanup();
    await projectB?.cleanup();
  });

  test("Cmd+N preselects the project you are looking at", async ({ page }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectB.workspaceId,
    });
    await pressNewWorkspaceShortcut(page);
    await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectA.workspaceId,
    });
    await pressNewWorkspaceShortcut(page);
    await expectNewWorkspaceProjectSelected(page, projectA.projectDisplayName);
  });

  test("New workspace button preselects the project you are looking at", async ({ page }) => {
    await gotoAppShell(page);
    await waitForSidebarHydration(page);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectB.workspaceId,
    });
    await openGlobalNewWorkspaceComposer(page);
    await expectNewWorkspaceProjectSelected(page, projectB.projectDisplayName);

    await switchWorkspaceViaSidebar({
      page,
      serverId: getServerId(),
      workspaceId: projectA.workspaceId,
    });
    await openGlobalNewWorkspaceComposer(page);
    await expectNewWorkspaceProjectSelected(page, projectA.projectDisplayName);
  });

  test("Cmd+N preselects the connected host project when an offline saved host is first", async ({
    page,
  }) => {
    await openColdRestoredWorkspaceWithOfflineHostFirst(page, projectB);

    await pressNewWorkspaceShortcut(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, projectB.projectDisplayName, 8_000);
  });

  test("New workspace button preselects the connected host project when an offline saved host is first", async ({
    page,
  }) => {
    await openColdRestoredWorkspaceWithOfflineHostFirst(page, projectB);

    await openGlobalNewWorkspaceComposer(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, projectB.projectDisplayName, 8_000);
  });

  test("plain /new ignores stale remembered offline hosts when only one saved host is connected", async ({
    page,
  }) => {
    await openNewWorkspaceWithStaleOfflineSelection(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectAnyProjectPreselectedWithin(page, 8_000);
  });

  test("stale remembered offline host heals after visiting the connected workspace", async ({
    page,
  }) => {
    const connectedServerId = getServerId();
    await seedOfflineHostsWithStaleSelection(page);

    await page.goto(buildHostWorkspaceRoute(connectedServerId, projectB.workspaceId));
    await expect(page).toHaveURL(buildHostWorkspaceRoute(connectedServerId, projectB.workspaceId), {
      timeout: 60_000,
    });
    await waitForSidebarHydration(page);

    await openGlobalNewWorkspaceComposer(page);

    await expect(page.getByTestId("host-picker-trigger")).toContainText("Connected host", {
      timeout: 8_000,
    });
    await expectProjectPreselectedWithin(page, projectB.projectDisplayName, 8_000);
  });
});
