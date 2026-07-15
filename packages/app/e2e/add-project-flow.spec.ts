import { randomUUID } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Page } from "./fixtures";
import {
  addProjectFlow,
  addProjectFlowBack,
  addProjectFlowHost,
  addProjectFlowInput,
  addProjectFlowMethod,
  chooseAddProjectMethod,
  expectAddProjectPage,
  openAddProjectFlow,
  waitForConnectedHost,
} from "./helpers/add-project-flow";
import { gotoAppShell } from "./helpers/app";
import { buildSeededHost } from "./helpers/daemon-registry";
import { addOfflineHostAndReload } from "./helpers/hosts";
import { type IsolatedHostDaemon, startIsolatedHostDaemon } from "./helpers/isolated-host-daemon";
import { expectOpenedProject } from "./helpers/project-picker-ui";
import { connectSeedClient } from "./helpers/seed-client";

const EXTRA_HOSTS_KEY = "@paseo:e2e-extra-hosts";
const SECONDARY_HOST_ID = "add-project-flow-secondary";
const SECONDARY_HOST_LABEL = "Secondary Host";

async function addConnectedHostAndReload(page: Page, host: IsolatedHostDaemon): Promise<void> {
  const registryEntry = buildSeededHost({
    serverId: host.serverId,
    label: SECONDARY_HOST_LABEL,
    endpoint: `127.0.0.1:${host.port}`,
    nowIso: new Date().toISOString(),
  });
  await page.evaluate(
    ({ key, entry }) => {
      localStorage.setItem(key, JSON.stringify([entry]));
    },
    { key: EXTRA_HOSTS_KEY, entry: registryEntry },
  );
  await page.reload();
}

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

test.describe("Add Project command-center flow", () => {
  test.describe.configure({ timeout: 180_000 });

  test("a single connected host opens directly on method selection", async ({ page }) => {
    await gotoAppShell(page);

    await openAddProjectFlow(page);

    await expect(addProjectFlowMethod(page, "directory-search")).toBeVisible();
    await expect(page.getByTestId("add-project-flow-page-host")).toHaveCount(0);
  });

  test("the back arrow, search input, and result glyph share one left edge", async ({ page }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);

    await page.keyboard.press("Enter");
    await expectAddProjectPage(page, "directory-search");
    await addProjectFlowInput(page).fill("/tmp");

    const backGlyph = addProjectFlowBack(page).locator("svg");
    const resultGlyph = addProjectFlow(page)
      .locator('[data-testid^="add-project-flow-path-"]')
      .first()
      .locator("svg");
    await expect(resultGlyph).toBeVisible();

    const [backBox, inputBox, resultBox, titleBox, resultsBox, footerBox] = await Promise.all([
      backGlyph.boundingBox(),
      addProjectFlowInput(page).boundingBox(),
      resultGlyph.boundingBox(),
      page.getByTestId("add-project-flow-title").boundingBox(),
      page.getByTestId("add-project-flow-results").boundingBox(),
      page.getByTestId("add-project-flow-footer").boundingBox(),
    ]);
    expect(backBox).not.toBeNull();
    expect(inputBox).not.toBeNull();
    expect(resultBox).not.toBeNull();
    expect(titleBox).not.toBeNull();
    expect(resultsBox).not.toBeNull();
    expect(footerBox).not.toBeNull();
    if (!backBox || !inputBox || !resultBox || !titleBox || !resultsBox || !footerBox) return;

    expect(Math.abs(backBox.x - inputBox.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(resultBox.x - inputBox.x)).toBeLessThanOrEqual(2);
    expect(titleBox.height).toBeLessThanOrEqual(24);
    expect(resultsBox.y + resultsBox.height).toBeLessThanOrEqual(footerBox.y + 1);
  });

  test("an offline extra host neither appears nor forces host selection", async ({ page }) => {
    await gotoAppShell(page);
    await addOfflineHostAndReload(page, {
      serverId: "add-project-flow-offline",
      label: "Offline Host",
    });

    await openAddProjectFlow(page);

    await expect(addProjectFlowHost(page, "add-project-flow-offline")).toHaveCount(0);
    await expect(addProjectFlowMethod(page, "directory-search")).toBeVisible();
  });

  test.describe("with two connected hosts", () => {
    let secondaryHost: IsolatedHostDaemon;

    test.beforeAll(async () => {
      secondaryHost = await startIsolatedHostDaemon(SECONDARY_HOST_ID);
    });

    test.afterAll(async () => {
      await secondaryHost?.close();
    });

    test("keyboard selection chooses the second host", async ({ page }) => {
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, secondaryHost);
      await waitForConnectedHost(page, {
        serverId: SECONDARY_HOST_ID,
        endpoint: `localhost:${secondaryHost.port}`,
      });
      await openAddProjectFlow(page, "host");

      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");

      await expectAddProjectPage(page, "method");
      await expect(addProjectFlow(page)).toContainText(SECONDARY_HOST_LABEL);
    });

    test("Escape and Back restore page input and active selection before closing at the root", async ({
      page,
    }) => {
      await gotoAppShell(page);
      await addConnectedHostAndReload(page, secondaryHost);
      await waitForConnectedHost(page, {
        serverId: SECONDARY_HOST_ID,
        endpoint: `localhost:${secondaryHost.port}`,
      });
      await openAddProjectFlow(page, "host");

      await addProjectFlowInput(page).fill("o");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "method");

      await addProjectFlowInput(page).fill("new");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "new-directory-parent");
      await page.keyboard.press("Escape");

      await expectAddProjectPage(page, "method");
      await expect(addProjectFlowInput(page)).toHaveValue("new");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "new-directory-parent");
      await addProjectFlowBack(page).click();

      await expectAddProjectPage(page, "method");
      await addProjectFlowBack(page).click();
      await expectAddProjectPage(page, "host");
      await expect(addProjectFlowInput(page)).toHaveValue("o");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "method");
      await expect(addProjectFlow(page)).toContainText(SECONDARY_HOST_LABEL);

      await page.keyboard.press("Escape");
      await expectAddProjectPage(page, "host");
      await page.keyboard.press("Escape");
      await expect(addProjectFlow(page)).not.toBeVisible();
    });

    test("New directory creates a Project on the selected remote host", async ({ page }) => {
      const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-remote-project-"));
      const directoryName = `remote-${randomUUID().slice(0, 8)}`;
      const directoryPath = path.join(parentDirectory, directoryName);

      try {
        await gotoAppShell(page);
        await addConnectedHostAndReload(page, secondaryHost);
        await waitForConnectedHost(page, {
          serverId: SECONDARY_HOST_ID,
          endpoint: `localhost:${secondaryHost.port}`,
        });
        await openAddProjectFlow(page, "host");
        await addProjectFlowHost(page, SECONDARY_HOST_ID).click();
        await expectAddProjectPage(page, "method");

        await expect(addProjectFlowMethod(page, "new-directory")).toContainText(
          `Create an empty directory on ${SECONDARY_HOST_LABEL}`,
        );
        await chooseAddProjectMethod(page, "new-directory");
        await addProjectFlowInput(page).fill(parentDirectory);
        await page.keyboard.press("Enter");
        await expectAddProjectPage(page, "new-directory-name");
        await page.keyboard.type(directoryName);
        await page.keyboard.press("Enter");

        await expectOpenedProject(page, directoryName);
        await expectProjectDirectory(directoryPath);
      } finally {
        await rm(parentDirectory, { recursive: true, force: true });
      }
    });
  });

  test("keyboard directory search adds the selected Project", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);

    await page.keyboard.press("Enter");
    await expectAddProjectPage(page, "directory-search");
    await page.keyboard.type(projectPickerFixture.fuzzyQuery);
    await expect(addProjectFlow(page)).toContainText(projectPickerFixture.projectName, {
      timeout: 30_000,
    });
    await page.keyboard.press("Enter");

    const projectId = await expectOpenedProject(page, projectPickerFixture.projectName);
    projectPickerFixture.rememberProjectId(projectId);
  });

  test("the current daemon advertises Clone from GitHub and New directory", async ({ page }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);

    await expect(addProjectFlowMethod(page, "github")).toContainText("Clone from GitHub");
    await expect(addProjectFlowMethod(page, "new-directory")).toContainText("New directory");
  });

  test("a complete repository URL remains selectable without a GitHub search result", async ({
    page,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);
    await chooseAddProjectMethod(page, "github");

    const remote = "https://github.invalid/acme/manual.git";
    await addProjectFlowInput(page).fill(remote);
    await expect(addProjectFlow(page).getByText("manual", { exact: true })).toBeVisible();
    await page.keyboard.press("Enter");

    await expectAddProjectPage(page, "github-location");
    await expect(addProjectFlow(page).getByTestId("add-project-flow-title")).toContainText(
      "manual",
    );
    await addProjectFlowBack(page).click();
    await expect(addProjectFlowInput(page)).toHaveValue(remote);
  });

  test("New directory validates the name, restores parent and name state, then creates a Project", async ({
    page,
  }) => {
    const parentDirectory = await mkdtemp(path.join(tmpdir(), "paseo-e2e-new-project-"));
    const directoryName = `created-${randomUUID().slice(0, 8)}`;
    const directoryPath = path.join(parentDirectory, directoryName);
    let projectId: string | null = null;

    try {
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "new-directory");

      await page.keyboard.type(parentDirectory);
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "new-directory-name");
      await page.keyboard.type("../invalid");
      await page.keyboard.press("Enter");

      const error = page.getByTestId("add-project-flow-error");
      await expect(error).toBeVisible();
      await expect(error).toContainText(/name|separator|directory/i);
      await expectAddProjectPage(page, "new-directory-name");

      await addProjectFlowInput(page).fill(directoryName);
      await addProjectFlowBack(page).click();
      await expectAddProjectPage(page, "new-directory-parent");
      await expect(addProjectFlowInput(page)).toHaveValue(parentDirectory);
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "new-directory-name");
      await expect(addProjectFlowInput(page)).toHaveValue(directoryName);
      await page.keyboard.press("Enter");

      projectId = await expectOpenedProject(page, directoryName);
      await expectProjectDirectory(directoryPath);
    } finally {
      await removeCreatedProject(directoryPath, projectId).catch(() => undefined);
      await rm(parentDirectory, { recursive: true, force: true });
    }
  });
});
