import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test, expect } from "../support/fixtures";
import {
  addProjectFlow,
  addProjectFlowHostTrigger,
  addProjectFlowInput,
  addProjectFlowSubmit,
  chooseAddHostFromProjectFlow,
  chooseAddProjectHost,
  chooseAddProjectLocation,
  chooseAddProjectTab,
  expectAddProjectResultVisible,
  expectAddProjectTab,
  expectNewWorkspaceForAddedProject,
  navigateAddProjectResults,
  navigateAndDismissAddProject,
  openAddProjectFlow,
  watchAddProjectRenderWarnings,
} from "../support/helpers/add-project-flow";
import { gotoAppShell } from "../support/helpers/app";
import {
  addConnectedHostAndReload,
  addOfflineHostAndReload,
  disconnectAllHostsAndReload,
  waitForConnectedHost,
} from "../support/helpers/hosts";
import {
  type IsolatedHostDaemon,
  startIsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const MOD = process.platform === "darwin" ? "Meta" : "Control";

const SECONDARY_HOST_ID = "add-project-flow-secondary";
const SECONDARY_HOST_LABEL = "Secondary Host";

async function expectProjectDirectory(pathname: string): Promise<void> {
  await expect.poll(async () => (await stat(pathname)).isDirectory()).toBe(true);
}

async function removeCreatedProject(
  pathname: string,
  knownProjectId: string | null,
): Promise<void> {
  const client = await connectSeedClient();
  try {
    let projectId = knownProjectId;
    if (!projectId) {
      const result = await client.addProject(pathname);
      projectId = result.project?.projectId ?? null;
    }
    if (projectId) await client.removeProject(projectId).catch(() => undefined);
  } finally {
    await client.close();
  }
}

async function expectProjectHasNoWorkspaces(projectId: string): Promise<void> {
  const client = await connectSeedClient();
  try {
    const result = await client.fetchWorkspaces({ filter: { projectId } });
    expect(result.entries).toEqual([]);
  } finally {
    await client.close();
  }
}

test.describe("Add project sheet", () => {
  test.describe.configure({ timeout: 180_000 });

  test("Add host replaces the project sheet when no hosts are connected", async ({ page }) => {
    await gotoAppShell(page);
    await disconnectAllHostsAndReload(page);
    await page.locator('[data-testid="sidebar-add-project"]:visible').click();
    await expect(addProjectFlow(page)).toContainText("No connected hosts");
    const originalUrl = page.url();
    await chooseAddHostFromProjectFlow(page);
    await expect(addProjectFlow(page)).toBeHidden();
    await expect(
      page.getByRole("button", { name: "Direct connection", exact: true }),
    ).toBeVisible();
    await expect(page).toHaveURL(originalUrl);
  });

  test("opens on Existing, switches tabs with Mod+1/2/3, keeps each draft, and closes on Escape", async ({
    page,
  }) => {
    const renderWarnings = watchAddProjectRenderWarnings(page);
    await gotoAppShell(page);
    await openAddProjectFlow(page);

    await page.keyboard.type("paseo");
    await page.keyboard.press(`${MOD}+2`);
    await expectAddProjectTab(page, "clone");
    await expect(addProjectFlowInput(page)).toBeFocused();
    await page.keyboard.type("getpaseo/");
    await page.keyboard.press(`${MOD}+3`);
    await expectAddProjectTab(page, "new-folder");
    await expect(addProjectFlowSubmit(page)).toBeDisabled();

    await page.keyboard.press(`${MOD}+1`);
    await expectAddProjectTab(page, "existing");
    await expect(addProjectFlowInput(page)).toHaveValue("paseo");
    await chooseAddProjectTab(page, "clone");
    await expect(addProjectFlowInput(page)).toHaveValue("getpaseo/");

    await navigateAndDismissAddProject(page);
    await expect(addProjectFlow(page)).not.toBeVisible();
    expect(renderWarnings).toEqual([]);
  });

  test("a single connected host shows no host picker, even with an offline host", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await addOfflineHostAndReload(page, {
      serverId: "add-project-flow-offline",
      label: "Offline Host",
    });

    await openAddProjectFlow(page);

    await expect(addProjectFlowHostTrigger(page)).toHaveCount(0);
  });

  test.describe("with two connected hosts", () => {
    let secondaryHost: IsolatedHostDaemon;

    test.beforeAll(async () => {
      secondaryHost = await startIsolatedHostDaemon(SECONDARY_HOST_ID);
    });

    test.afterAll(async () => {
      await secondaryHost?.close();
    });

    test("New folder creates a Project on the host chosen in the sheet", async ({ page }) => {
      const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-remote-project-"));
      const directoryName = `remote-${randomUUID().slice(0, 8)}`;
      const directoryPath = path.join(parentDirectory, directoryName);

      try {
        await gotoAppShell(page);
        await addConnectedHostAndReload(page, {
          serverId: secondaryHost.serverId,
          label: SECONDARY_HOST_LABEL,
          port: secondaryHost.port,
        });
        await waitForConnectedHost(page, {
          serverId: SECONDARY_HOST_ID,
          endpoint: `localhost:${secondaryHost.port}`,
        });
        await openAddProjectFlow(page);
        await chooseAddProjectTab(page, "new-folder");
        await addProjectFlowInput(page).fill(directoryName);

        await chooseAddProjectHost(page, SECONDARY_HOST_ID);
        await expect(addProjectFlowHostTrigger(page)).toContainText(SECONDARY_HOST_LABEL);
        await expect(addProjectFlowInput(page)).toHaveValue(directoryName);
        await chooseAddProjectLocation(page, parentDirectory);
        await addProjectFlowInput(page).focus();
        await page.keyboard.press("Enter");

        const projectId = await expectOpenedProject(page, directoryName);
        await expectNewWorkspaceForAddedProject(page, {
          serverId: SECONDARY_HOST_ID,
          projectId,
          projectName: directoryName,
          projectPath: directoryPath,
        });
        await expect(page.getByTestId("host-picker-trigger")).toContainText(SECONDARY_HOST_LABEL);
        await expectProjectDirectory(directoryPath);
      } finally {
        await rm(parentDirectory, { recursive: true, force: true });
      }
    });
  });

  test("a host that disconnects keeps its draft and blocks submit instead of moving it", async ({
    page,
  }) => {
    const droppingHost = await startIsolatedHostDaemon("add-project-flow-dropping");
    try {
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: droppingHost.serverId,
        label: "Dropping Host",
        port: droppingHost.port,
      });
      await waitForConnectedHost(page, {
        serverId: droppingHost.serverId,
        endpoint: `localhost:${droppingHost.port}`,
      });
      await openAddProjectFlow(page);
      await chooseAddProjectHost(page, droppingHost.serverId);
      await addProjectFlowInput(page).fill(homedir());

      await droppingHost.close();
      await expect(page.getByTestId("add-project-flow-error")).toHaveText(
        "Dropping Host is offline",
        { timeout: 30_000 },
      );
      await expect(addProjectFlowHostTrigger(page)).toContainText("Dropping Host");
      await expect(addProjectFlowInput(page)).toHaveValue(homedir());
      await expect(addProjectFlowSubmit(page)).toBeDisabled();
    } finally {
      await droppingHost.close();
    }
  });

  test("keyboard directory search adds the selected Project", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);

    await page.keyboard.type(projectPickerFixture.fuzzyQuery);
    await expect(addProjectFlow(page)).toContainText(projectPickerFixture.projectName, {
      timeout: 30_000,
    });
    await page.keyboard.press("Enter");

    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
    await expectNewWorkspaceForAddedProject(page, {
      serverId: getServerId(),
      projectId,
      projectName: projectPickerFixture.projectName,
      projectPath: projectPickerFixture.projectPath,
    });
    await expectProjectHasNoWorkspaces(projectId);
  });

  test("keyboard navigation keeps the selected row inside the visible results", async ({
    page,
  }) => {
    const parentDirectory = await mkdtemp(path.join(homedir(), "paseo-e2e-scroll-"));
    const rowPath = (index: number) =>
      path.join(parentDirectory, `scroll-probe-${String(index).padStart(2, "0")}`);
    const rowName = (index: number) => path.basename(rowPath(index));
    let projectId: string | null = null;
    try {
      await Promise.all(Array.from({ length: 16 }, (_, index) => mkdir(rowPath(index))));
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await addProjectFlowInput(page).fill(`${path.basename(parentDirectory)}/scroll-probe`);
      const results = page.getByTestId("add-project-flow-results");
      await expect(results.getByRole("button", { name: /scroll-probe-/ })).toHaveCount(16, {
        timeout: 30_000,
      });

      await navigateAddProjectResults(page, "ArrowDown", 11);
      await expectAddProjectResultVisible(page, rowName(11));
      await navigateAddProjectResults(page, "ArrowUp", 12);
      await expectAddProjectResultVisible(page, rowName(15));
      await navigateAddProjectResults(page, "ArrowDown", 1);
      await expectAddProjectResultVisible(page, rowName(0));

      await navigateAddProjectResults(page, "ArrowDown", 11);
      await page.keyboard.press("Enter");
      projectId = await expectOpenedProject(page, rowName(11));
      await expectNewWorkspaceForAddedProject(page, {
        serverId: getServerId(),
        projectId,
        projectName: rowName(11),
        projectPath: rowPath(11),
      });
    } finally {
      if (projectId) await removeCreatedProject(rowPath(11), projectId);
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  test("Enter on a focused result adds that folder, not the one picked before", async ({
    page,
  }) => {
    const parentDirectory = await mkdtemp(path.join(homedir(), "paseo-e2e-focus-"));
    const firstPath = path.join(parentDirectory, "focus-probe-a");
    const secondPath = path.join(parentDirectory, "focus-probe-b");
    let projectId: string | null = null;
    try {
      await Promise.all([mkdir(firstPath), mkdir(secondPath)]);
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await addProjectFlowInput(page).fill(`${path.basename(parentDirectory)}/focus-probe`);
      const results = page.getByTestId("add-project-flow-results");
      await expect(results.getByRole("button", { name: /focus-probe-/ })).toHaveCount(2, {
        timeout: 30_000,
      });

      await results.getByRole("button", { name: /focus-probe-b/ }).focus();
      await page.keyboard.press("Enter");
      projectId = await expectOpenedProject(page, "focus-probe-b");
      await expectNewWorkspaceForAddedProject(page, {
        serverId: getServerId(),
        projectId,
        projectName: "focus-probe-b",
        projectPath: secondPath,
      });
    } finally {
      if (projectId) await removeCreatedProject(secondPath, projectId);
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  test("Enter while a new search runs does not open a row from the previous search", async ({
    page,
  }) => {
    const parentDirectory = await mkdtemp(path.join(homedir(), "paseo-e2e-stale-"));
    try {
      await mkdir(path.join(parentDirectory, "stale-probe-a"));
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      const prefix = path.basename(parentDirectory);
      await addProjectFlowInput(page).fill(`${prefix}/stale-probe`);
      const results = page.getByTestId("add-project-flow-results");
      await expect(results.getByRole("button", { name: /stale-probe-a/ })).toBeVisible({
        timeout: 30_000,
      });

      await addProjectFlowInput(page).fill(`${prefix}/no-such-folder`);
      await page.keyboard.press("Enter");
      await expect(addProjectFlow(page).getByText("No matching folders")).toBeVisible({
        timeout: 30_000,
      });
      await expect(addProjectFlow(page)).toBeVisible();
      await expect(addProjectFlowSubmit(page)).toBeDisabled();
    } finally {
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  test("a complete repository URL is cloneable without a GitHub search result", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);
    await chooseAddProjectTab(page, "clone");

    const remote = "https://github.invalid/acme/manual.git";
    await addProjectFlowInput(page).fill(remote);
    await expect(addProjectFlow(page).getByText("manual", { exact: true })).toBeVisible();
    await expect(page.getByTestId("add-project-flow-location")).toContainText("/manual");
    await expect(addProjectFlowSubmit(page)).toBeEnabled();
  });

  test("Enter activates a focused button instead of the primary action", async ({ page }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);
    await chooseAddProjectTab(page, "clone");
    await addProjectFlowInput(page).fill("https://github.invalid/acme/manual.git");
    await expect(addProjectFlowSubmit(page)).toBeEnabled();

    await addProjectFlow(page).getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(addProjectFlow(page)).toBeHidden();
  });

  test("a row picked during a search is not replaced by the answer's first row", async ({
    page,
  }) => {
    const parentDirectory = await mkdtemp(path.join(homedir(), "paseo-e2e-dropped-pick-"));
    try {
      await Promise.all([
        mkdir(path.join(parentDirectory, "previous-probe")),
        mkdir(path.join(parentDirectory, "incoming-probe")),
      ]);
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      const prefix = path.basename(parentDirectory);
      const results = page.getByTestId("add-project-flow-results");
      await addProjectFlowInput(page).fill(`${prefix}/previous-probe`);
      await expect(results.getByRole("button", { name: /previous-probe/ })).toBeVisible({
        timeout: 30_000,
      });

      await addProjectFlowInput(page).fill(`${prefix}/incoming-probe`);
      await page.keyboard.press("ArrowDown");
      await expect(results.getByRole("button", { name: /incoming-probe/ })).toBeVisible({
        timeout: 30_000,
      });
      await expect(addProjectFlowSubmit(page)).toBeDisabled();
    } finally {
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  test("Enter in Location while a new search runs keeps the current location", async ({ page }) => {
    const parentDirectory = await mkdtemp(path.join(homedir(), "paseo-e2e-stale-location-"));
    try {
      await mkdir(path.join(parentDirectory, "stale-probe-a"));
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await chooseAddProjectTab(page, "new-folder");
      const location = page.getByTestId("add-project-flow-location");
      const locationBefore = await location.textContent();
      await location.click();
      const search = page.getByPlaceholder("Search folders or enter a path").last();
      const prefix = path.basename(parentDirectory);
      await search.fill(`${prefix}/stale-probe`);
      await expect(page.getByText(/stale-probe-a/).last()).toBeVisible({ timeout: 30_000 });

      await search.fill(`${prefix}/no-such-folder`);
      await page.keyboard.press("Enter");
      await expect(page.getByText("No matching folders")).toBeVisible({ timeout: 30_000 });
      await expect(search).toBeVisible();
      await expect(location).toHaveText(locationBefore ?? "");
    } finally {
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });

  test("New folder validates the name, then creates a Project in the chosen location", async ({
    page,
  }) => {
    const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-new-project-"));
    const directoryName = `created-${randomUUID().slice(0, 8)}`;
    const directoryPath = path.join(parentDirectory, directoryName);
    let projectId: string | null = null;

    try {
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await chooseAddProjectTab(page, "new-folder");
      await chooseAddProjectLocation(page, parentDirectory);

      await addProjectFlowInput(page).fill("../invalid");
      const nameError = page.getByTestId("add-project-flow-name-field-error");
      await expect(nameError).toHaveText("Use a name without slashes");
      await expect(addProjectFlowSubmit(page)).toBeDisabled();

      await addProjectFlowInput(page).fill("C:repo");
      await expect(nameError).toHaveText("Use a name without a drive letter");
      await expect(addProjectFlowSubmit(page)).toBeDisabled();

      await addProjectFlowInput(page).fill(directoryName);
      await expect(nameError).toBeHidden();
      await expect(addProjectFlowSubmit(page)).toBeEnabled();
      await expect(page.getByTestId("add-project-flow-location")).toContainText(directoryName);
      await addProjectFlowSubmit(page).click();

      projectId = await expectOpenedProject(page, directoryName);
      await expectNewWorkspaceForAddedProject(page, {
        serverId: getServerId(),
        projectId,
        projectName: directoryName,
        projectPath: directoryPath,
      });
      await expectProjectHasNoWorkspaces(projectId);
      await expectProjectDirectory(directoryPath);
    } finally {
      await removeCreatedProject(directoryPath, projectId).catch(() => undefined);
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });
});

test.describe("Compact Add project context", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("canceling Add project preserves the sidebar", async ({ page }) => {
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await openAddProjectFlow(page);
    await page.keyboard.press("Escape");
    await expect(addProjectFlow(page)).not.toBeVisible();
    await expect(page.getByRole("button", { name: "Close menu", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.getByTestId("sidebar-search")).toBeVisible();
  });
  test("successful Add project reveals the new workspace page", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Open menu", exact: true }).click();
    await openAddProjectFlow(page);
    await addProjectFlowInput(page).fill(projectPickerFixture.fuzzyQuery);
    await expect(
      page.getByRole("button", { name: new RegExp(projectPickerFixture.projectName) }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await addProjectFlowSubmit(page).click();
    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
    await expectNewWorkspaceForAddedProject(page, {
      serverId: getServerId(),
      projectId,
      projectName: projectPickerFixture.projectName,
      projectPath: projectPickerFixture.projectPath,
    });
    await expect(page.getByRole("button", { name: "Open menu", exact: true })).toBeVisible();
  });
});
