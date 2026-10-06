import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { test, expect, type Page } from "../support/fixtures";
import {
  addProjectFlow,
  addProjectFlowBack,
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
import { openMobileAgentSidebar } from "../support/helpers/sidebar";
import { daemonWsRoutePattern } from "../support/helpers/daemon-port";

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

async function holdDirectorySearchResponse(page: Page, query: string) {
  const delivery: { requestId: string | null; release: (() => void) | null } = {
    requestId: null,
    release: null,
  };
  const requests: string[] = [];
  await page.routeWebSocket(daemonWsRoutePattern(), (browser) => {
    const server = browser.connectToServer();
    browser.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as {
        message?: { type?: string; query?: string; requestId?: string };
      };
      if (frame.message?.type === "directory_suggestions_request") {
        requests.push(frame.message.query ?? "");
        if (frame.message.query === query) {
          delivery.requestId = frame.message.requestId ?? null;
        }
      }
      server.send(message);
    });
    server.onMessage((message) => {
      const frame = JSON.parse(message.toString()) as {
        message?: { type?: string; payload?: { requestId?: string } };
      };
      if (
        frame.message?.type === "directory_suggestions_response" &&
        frame.message.payload?.requestId === delivery.requestId
      ) {
        // Delay a real host response until the next search has finished.
        delivery.release = () => browser.send(message);
        return;
      }
      browser.send(message);
    });
  });
  return { delivery, requests };
}

test.describe("Add Project command-center flow", () => {
  test.describe.configure({ timeout: 180_000 });

  test("shows local matches immediately and refreshes cached directory searches", async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    const root = await mkdtemp(path.join(homedir(), "paseo-e2e-local-search-"));
    const recentPath = path.join(root, "recent-project");
    const otherRecentPath = path.join(root, "recent-other");
    const discoveryPath = path.join(root, "discovery-target");
    const newPath = path.join(root, "new-target");
    await mkdir(recentPath);
    await mkdir(otherRecentPath);
    await mkdir(discoveryPath);
    const client = await connectSeedClient();
    const project = await client.addProject(recentPath);
    if (!project.project) throw new Error(project.error ?? "Could not seed recent project");
    const requests: string[] = [];
    const recordRequest = ({ payload }: { payload: string | Buffer }) => {
      if (typeof payload !== "string") return;
      const frame: { message?: { type?: string; query?: string } } = JSON.parse(payload);
      if (frame.message?.type === "directory_suggestions_request")
        requests.push(frame.message.query ?? "");
    };
    page.on("websocket", (socket) => socket.on("framesent", recordRequest));
    try {
      await page.setViewportSize({ width: 390, height: 844 });
      await gotoAppShell(page);
      await page.clock.install();
      await openMobileAgentSidebar(page);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "directory-search");
      await expect(addProjectFlow(page)).toContainText("recent-project");
      await page.clock.runFor(600);
      expect(requests).toEqual([]);

      const recentSearch = `${root}/recent`;
      await addProjectFlowInput(page).fill(recentSearch);
      await expect(addProjectFlow(page)).toContainText("recent-project");
      await page.clock.runFor(200);
      expect(requests).toEqual([]);
      await page.clock.runFor(250);
      await expect(addProjectFlow(page)).toContainText("recent-other");
      expect(requests).toEqual([recentSearch]);

      const search = `${root}/discovery`;
      await addProjectFlowInput(page).fill(search);
      await page.clock.runFor(200);
      expect(requests).toEqual([recentSearch]);
      await addProjectFlowInput(page).fill(recentSearch);
      await page.clock.runFor(600);
      expect(requests).toEqual([recentSearch]);

      await addProjectFlowInput(page).fill(search);
      await page.clock.runFor(450);
      await expect(addProjectFlow(page)).toContainText("discovery-target");
      expect(requests).toEqual([recentSearch, search]);

      const emptySearch = path.join(root, "new-targ");
      const discoveredPath = page.getByTestId(
        `add-project-flow-path-${encodeURIComponent(newPath)}`,
      );
      await addProjectFlowInput(page).fill(emptySearch);
      await page.clock.runFor(600);
      await expect(page.getByTestId("add-project-flow-refresh")).toBeEnabled();
      await expect(discoveredPath).toHaveCount(0);
      expect(requests).toEqual([recentSearch, search, emptySearch]);
      await mkdir(newPath);
      await page.getByTestId("add-project-flow-refresh").click();
      await expect(discoveredPath).toBeVisible();
      expect(requests).toEqual([recentSearch, search, emptySearch, emptySearch]);
      await rm(newPath, { recursive: true });
      await page.getByTestId("add-project-flow-refresh").click();
      await expect(discoveredPath).toHaveCount(0);
      await expect(page.getByTestId("add-project-flow-refresh")).toBeEnabled();
      expect(requests).toEqual([recentSearch, search, emptySearch, emptySearch, emptySearch]);

      await mkdir(newPath);
      await addProjectFlowInput(page).fill(recentSearch);
      await page.clock.runFor(600);
      await expect(addProjectFlow(page)).toContainText("recent-project");
      await addProjectFlowInput(page).fill(emptySearch);
      await page.clock.runFor(600);
      await expect(page.getByTestId("add-project-flow-refresh")).toBeEnabled();
      await expect(discoveredPath).toHaveCount(0);
      expect(requests).toEqual([recentSearch, search, emptySearch, emptySearch, emptySearch]);
      await addProjectFlowInput(page).fill("");
      await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + 16_000);
      await addProjectFlowInput(page).fill(emptySearch);
      await page.clock.runFor(600);
      await expect(discoveredPath).toBeVisible();
      expect(requests).toEqual([
        recentSearch,
        search,
        emptySearch,
        emptySearch,
        emptySearch,
        emptySearch,
      ]);
      await addProjectFlowInput(page).fill(recentSearch);
      await page.clock.runFor(600);
      await expect(addProjectFlow(page)).toContainText("recent-other");
      await expect(page.getByTestId("add-project-flow-refresh")).toBeEnabled();
      const screenshot = testInfo.outputPath("cached-directory-search.png");
      await page.screenshot({ path: screenshot });
    } finally {
      await client.removeProject(project.project.projectId);
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("Enter on focused Refresh searches without opening the selected directory", async ({
    page,
  }) => {
    const root = await mkdtemp(path.join(homedir(), "paseo-e2e-refresh-keyboard-"));
    const projectPath = path.join(root, "refresh-project");
    await mkdir(projectPath);
    const client = await connectSeedClient();
    const project = await client.addProject(projectPath);
    if (!project.project) throw new Error(project.error ?? "Could not seed recent project");
    const query = path.join(root, "refresh");
    const { requests } = await holdDirectorySearchResponse(page, "unused");
    try {
      await gotoAppShell(page);
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "directory-search");
      await addProjectFlowInput(page).fill(query);
      const refresh = page.getByTestId("add-project-flow-refresh");
      await expect(refresh).toBeEnabled();
      expect(requests).toEqual([query]);
      await refresh.focus();
      await expect(refresh).toBeFocused();
      await refresh.press("Enter");
      await expect.poll(() => requests).toEqual([query, query]);
      await expect(refresh).toBeEnabled();
      await expectAddProjectPage(page, "directory-search");
      await expect(page.getByTestId("add-project-flow-progress")).toHaveCount(0);
      await expectProjectHasNoWorkspaces(project.project.projectId);
    } finally {
      await client.removeProject(project.project.projectId);
      await client.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test("searches a new query while an older response is pending and ignores late results", async ({
    page,
  }) => {
    const root = await mkdtemp(path.join(homedir(), "paseo-e2e-pending-search-"));
    const slowPath = path.join(root, "slow-project");
    const fastPath = path.join(root, "fast-project");
    await mkdir(slowPath);
    await mkdir(fastPath);
    const { delivery, requests } = await holdDirectorySearchResponse(page, slowPath);
    try {
      await gotoAppShell(page);
      await page.clock.install();
      await openAddProjectFlow(page);
      await chooseAddProjectMethod(page, "directory-search");
      await addProjectFlowInput(page).fill(slowPath);
      await page.clock.runFor(450);
      await expect.poll(() => delivery.release !== null).toBe(true);
      await expect(page.getByTestId("add-project-flow-loading")).toBeVisible();

      await addProjectFlowInput(page).fill(fastPath);
      await page.clock.runFor(450);
      await expect(addProjectFlow(page)).toContainText("fast-project");
      await expect(page.getByTestId("add-project-flow-loading")).toHaveCount(0);
      expect(requests).toEqual([slowPath, fastPath]);

      delivery.release?.();
      await page.clock.runFor(100);
      await expect(page.getByTestId("add-project-flow-refresh")).toBeEnabled();
      await expect(addProjectFlow(page)).toContainText("fast-project");
      await expect(addProjectFlow(page)).not.toContainText("slow-project");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

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
    await expectNewWorkspaceForAddedProject(page, {
      serverId: getServerId(),
      projectId,
      projectName: projectPickerFixture.projectName,
      projectPath: projectPickerFixture.projectPath,
    });
    await expectProjectHasNoWorkspaces(projectId);
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
