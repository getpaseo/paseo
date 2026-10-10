import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "../support/fixtures";
import {
  addProjectFlow,
  addProjectFlowBack,
  addProjectFlowConfirmDirectory,
  addProjectFlowHost,
  addProjectFlowInput,
  addProjectFlowMethod,
  chooseAddProjectMethod,
  expectAddProjectPage,
  expectNewWorkspaceForAddedProject,
  openAddProjectFlow,
  openAddProjectHostSelection,
} from "../support/helpers/add-project-flow";
import { gotoAppShell } from "../support/helpers/app";
import {
  addConnectedHostAndReload,
  addOfflineHostAndReload,
  waitForConnectedHost,
} from "../support/helpers/hosts";
import {
  type IsolatedHostDaemon,
  startIsolatedHostDaemon,
} from "../support/helpers/isolated-host-daemon";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

const SECONDARY_HOST_ID = "add-project-flow-secondary";
const SECONDARY_HOST_LABEL = "Secondary Host";

function trackAddProjectRequests(page: Page): string[] {
  const requests: string[] = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = payload.toString();
      if (frame.includes('"project.add.request"')) requests.push(frame);
    });
  });
  return requests;
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

async function withProjectDirectory(
  projectName: string,
  runFlow: (directory: {
    parent: string;
    projectName: string;
    projectPath: string;
    rememberProjectId: (projectId: string) => void;
  }) => Promise<void>,
): Promise<void> {
  const parent = await mkdtemp(path.join(tmpdir(), "paseo-e2e-project-directory-"));
  const projectPath = path.join(parent, projectName);
  let projectId: string | null = null;
  try {
    await mkdir(projectPath);
    await runFlow({
      parent,
      projectName,
      projectPath,
      rememberProjectId: (openedProjectId) => {
        projectId = openedProjectId;
      },
    });
  } finally {
    try {
      await removeCreatedProject(projectPath, projectId);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
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

test.describe("Add Project command-center flow", () => {
  test.describe.configure({ timeout: 180_000 });

  test("method selection shows the daemon's available project sources without search", async ({
    page,
  }) => {
    await gotoAppShell(page);

    await openAddProjectFlow(page);

    await expect(addProjectFlowMethod(page, "directory-search")).toBeVisible();
    await expect(addProjectFlowMethod(page, "github")).toContainText("Clone from GitHub");
    await expect(addProjectFlowMethod(page, "new-directory")).toContainText("New directory");
    await expect(addProjectFlowInput(page)).toHaveCount(0);
    await expect(addProjectFlow(page).getByRole("textbox")).toHaveCount(0);
    await expect(page.getByTestId("add-project-flow-page-host")).toHaveCount(0);
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
      await addConnectedHostAndReload(page, {
        serverId: secondaryHost.serverId,
        label: SECONDARY_HOST_LABEL,
        port: secondaryHost.port,
      });
      await waitForConnectedHost(page, {
        serverId: SECONDARY_HOST_ID,
        endpoint: `localhost:${secondaryHost.port}`,
      });
      await openAddProjectHostSelection(page);

      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");

      await expectAddProjectPage(page, "method");
      await expect(addProjectFlow(page)).toContainText(SECONDARY_HOST_LABEL);
    });

    test("Escape and Back restore searchable page input before closing at the root", async ({
      page,
    }) => {
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
      await openAddProjectHostSelection(page);

      await addProjectFlowInput(page).fill("o");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "method");

      await chooseAddProjectMethod(page, "new-directory");
      await expectAddProjectPage(page, "new-directory-parent");
      await page.keyboard.press("Escape");

      await expectAddProjectPage(page, "method");
      await expect(addProjectFlowInput(page)).toHaveCount(0);
      await chooseAddProjectMethod(page, "new-directory");
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
        await addConnectedHostAndReload(page, {
          serverId: secondaryHost.serverId,
          label: SECONDARY_HOST_LABEL,
          port: secondaryHost.port,
        });
        await waitForConnectedHost(page, {
          serverId: SECONDARY_HOST_ID,
          endpoint: `localhost:${secondaryHost.port}`,
        });
        await openAddProjectHostSelection(page);
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

  test("keyboard directory search browses the selected directory before adding it", async ({
    page,
    projectPickerFixture,
  }) => {
    await gotoAppShell(page);
    await openAddProjectFlow(page);

    await page.keyboard.press("Enter");
    await expectAddProjectPage(page, "directory-search");
    await expect(addProjectFlowInput(page)).toBeFocused();
    await page.keyboard.type(projectPickerFixture.fuzzyQuery);
    await expect(addProjectFlow(page)).toContainText(projectPickerFixture.projectName, {
      timeout: 30_000,
    });
    await page.keyboard.press("Enter");
    await expect(addProjectFlowInput(page)).toHaveValue(
      `${projectPickerFixture.projectPath}${path.sep}`,
    );
    await expectAddProjectPage(page, "directory-search");
    await page.keyboard.press("ControlOrMeta+Enter");

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

  test("an empty directory is added only by explicit shortcut confirmation", async ({ page }) => {
    await withProjectDirectory(
      "empty-project",
      async ({ projectName, projectPath, rememberProjectId }) => {
        const addRequests = trackAddProjectRequests(page);
        await gotoAppShell(page);
        await openAddProjectFlow(page);
        await chooseAddProjectMethod(page, "directory-search");
        await addProjectFlowInput(page).fill(`${projectPath}${path.sep}`);
        await expect(page.getByTestId("add-project-flow-empty")).toBeVisible();
        await page.keyboard.press("Enter");
        await expectAddProjectPage(page, "directory-search");
        expect(addRequests).toHaveLength(0);

        await page.keyboard.press("ControlOrMeta+Enter");

        const projectId = await expectOpenedProject(page, projectName);
        rememberProjectId(projectId);
        expect(addRequests).toHaveLength(1);
        await expectNewWorkspaceForAddedProject(page, {
          serverId: getServerId(),
          projectId,
          projectName,
          projectPath,
        });
      },
    );
  });

  test("an empty directory is added only by explicit focused button confirmation", async ({
    page,
  }) => {
    await withProjectDirectory(
      "empty-project",
      async ({ projectName, projectPath, rememberProjectId }) => {
        const addRequests = trackAddProjectRequests(page);
        await gotoAppShell(page);
        await openAddProjectFlow(page);
        await chooseAddProjectMethod(page, "directory-search");
        await addProjectFlowInput(page).fill(`${projectPath}${path.sep}`);
        await expect(page.getByTestId("add-project-flow-empty")).toBeVisible();
        await page.keyboard.press("Enter");
        await expectAddProjectPage(page, "directory-search");
        expect(addRequests).toHaveLength(0);

        await page.keyboard.press("Tab");
        await expect(addProjectFlowConfirmDirectory(page)).toBeFocused();
        await page.keyboard.press("Enter");

        const projectId = await expectOpenedProject(page, projectName);
        rememberProjectId(projectId);
        expect(addRequests).toHaveLength(1);
        await expectNewWorkspaceForAddedProject(page, {
          serverId: getServerId(),
          projectId,
          projectName,
          projectPath,
        });
      },
    );
  });

  test("browsing and adding preserves a literal trailing backslash in a POSIX directory", async ({
    page,
  }) => {
    test.skip(process.platform === "win32", "Backslashes are directory separators on Windows");
    await withProjectDirectory(
      "team\\",
      async ({ parent, projectName, projectPath, rememberProjectId }) => {
        await mkdir(path.join(parent, "team"));
        await gotoAppShell(page);
        await openAddProjectFlow(page);
        await chooseAddProjectMethod(page, "directory-search");
        await addProjectFlowInput(page).fill(`${parent}${path.sep}`);
        await addProjectFlow(page).getByText(projectPath, { exact: true }).click();
        await expect(addProjectFlowInput(page)).toHaveValue(`${projectPath}${path.sep}`);
        await addProjectFlowConfirmDirectory(page).click();

        const projectId = await expectOpenedProject(page, projectName);
        rememberProjectId(projectId);
        await expectNewWorkspaceForAddedProject(page, {
          serverId: getServerId(),
          projectId,
          projectName,
          projectPath,
        });
      },
    );
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
    const title = addProjectFlow(page).getByTestId("add-project-flow-title");
    await expect(title.getByText("Choose destination", { exact: true })).toBeVisible();
    await expect(title.getByText("localhost", { exact: true })).toBeVisible();
    await expect(title).not.toContainText("Where should Paseo create");
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
      await expect(addProjectFlowInput(page)).toBeFocused();

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
