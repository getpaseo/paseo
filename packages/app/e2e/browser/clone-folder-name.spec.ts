import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { expect, test } from "../support/fixtures";
import {
  addProjectFlowInput,
  chooseAddProjectHost,
  chooseAddProjectTab,
  chooseAddProjectLocation,
  expectNewWorkspaceForAddedProject,
  openAddProjectFlow,
} from "../support/helpers/add-project-flow";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { createTempGitRepo } from "../support/helpers/workspace";

for (const viewport of [
  { width: 1280, height: 900, repositoryInput: "acme/api.git" },
  { width: 390, height: 844, repositoryInput: "https://github.invalid/acme/api.git" },
]) {
  test(`clone folder name at ${viewport.width}px: defaults, validation, tab drafts, collision, keyboard retry`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    await page.setViewportSize(viewport);
    const repo = await createTempGitRepo("clone-source-");
    const parent = await mkdtemp(path.join(tmpdir(), "clone-destination-"));
    const remote = "https://github.invalid/acme/api.git";
    // Git's normal URL rewriting keeps this real clone deterministic and offline.
    const host = await startIsolatedHostDaemon("clone-folder-host", {
      environment: {
        NODE_ENV: "development",
        GIT_CONFIG_COUNT: "2",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(repo.path).href}.insteadOf`,
        GIT_CONFIG_VALUE_0: remote,
        GIT_CONFIG_KEY_1: `url.${pathToFileURL(repo.path).href}.insteadOf`,
        GIT_CONFIG_VALUE_1: "https://github.com/acme/api.git",
      },
    });
    const client = await connectDaemonClient<DaemonClient>({
      clientIdPrefix: "clone-folder",
      port: host.port,
    });
    try {
      for (const folderName of [
        "",
        ".",
        "..",
        "../escape",
        "nested/name",
        "nested\\name",
        "bad\0name",
        "C:escape",
        " spaced ",
      ]) {
        const result = await client.cloneGithubProject({
          repo: remote,
          targetDirectory: parent,
          folderName,
        });
        expect(result.project).toBeNull();
        expect(result.error).toMatch(/Directory name/);
      }
      // Legacy callers still get the repository's original name.
      const legacy = await client.cloneGithubProject({ repo: remote, targetDirectory: parent });
      expect(legacy.error).toBeNull();
      expect(legacy.checkoutPath).toBe(path.join(parent, "api"));

      await gotoAppShell(page);
      await addConnectedHostAndReload(page, {
        serverId: host.serverId,
        label: "Clone host",
        port: host.port,
      });
      if (viewport.width === 390)
        await page.getByRole("button", { name: "Open menu", exact: true }).click();
      await openAddProjectFlow(page);
      await chooseAddProjectHost(page, host.serverId);
      await chooseAddProjectTab(page, "clone");
      await addProjectFlowInput(page).fill(viewport.repositoryInput);
      await chooseAddProjectLocation(page, parent);
      const folderNameInput = page.getByRole("textbox", { name: "Folder name", exact: true });
      await expect(folderNameInput).toHaveValue("api");
      const preview = page.getByTestId("add-project-flow-location");
      await expect(preview).toContainText("api");
      await page.getByRole("button", { name: "Clone project", exact: true }).click();
      await expect(page.getByTestId("add-project-flow-error")).toHaveText(
        `Checkout path already exists: ${path.join(parent, "api")}`,
      );

      await folderNameInput.fill("../escape");
      await expect(page.getByRole("button", { name: "Clone project", exact: true })).toBeDisabled();
      await expect(page.getByText("Use a name without slashes", { exact: true })).toBeVisible();
      await folderNameInput.fill("acme-api");
      await chooseAddProjectTab(page, "existing");
      await chooseAddProjectTab(page, "clone");
      const otherParent = path.join(parent, "other");
      await mkdir(otherParent);
      await chooseAddProjectLocation(page, otherParent);
      await expect(folderNameInput).toHaveValue("acme-api");
      const checkout = path.join(otherParent, "acme-api");
      await expect(preview).toContainText("other/acme-api");
      await page.screenshot({ path: testInfo.outputPath("clone-folder.png") });
      await testInfo.attach("Clone folder form", {
        path: testInfo.outputPath("clone-folder.png"),
        contentType: "image/png",
      });
      await folderNameInput.focus();
      await page.keyboard.press("Enter");
      const projectId = await expectOpenedProject(page, "acme-api");
      await expectNewWorkspaceForAddedProject(page, {
        serverId: host.serverId,
        projectId,
        projectName: "acme-api",
        projectPath: checkout,
      });
      expect(await readFile(path.join(checkout, "README.md"), "utf8")).toBe("# Temp Repo\n");
      expect((await stat(path.join(checkout, ".git"))).isDirectory()).toBe(true);
      expect(await readFile(path.join(parent, "api", "README.md"), "utf8")).toBe("# Temp Repo\n");
      expect((await client.fetchWorkspaces({ filter: { projectId } })).entries).toEqual([]);
    } finally {
      await client.close();
      await host.close();
      await repo.cleanup();
      await rm(parent, { recursive: true, force: true });
    }
  });
}
