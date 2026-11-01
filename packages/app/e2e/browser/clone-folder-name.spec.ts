import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { shortenPath } from "../../src/utils/shorten-path";
import { expect, test } from "../support/fixtures";
import {
  addProjectFlowBack,
  addProjectFlowHost,
  addProjectFlowInput,
  chooseAddProjectMethod,
  expectAddProjectPage,
  expectNewWorkspaceForAddedProject,
  openAddProjectHostSelection,
} from "../support/helpers/add-project-flow";
import { gotoAppShell } from "../support/helpers/app";
import { connectDaemonClient } from "../support/helpers/daemon-client-loader";
import { addConnectedHostAndReload } from "../support/helpers/hosts";
import { startIsolatedHostDaemon } from "../support/helpers/isolated-host-daemon";
import { expectOpenedProject } from "../support/helpers/project-picker-ui";
import { createTempGitRepo } from "../support/helpers/workspace";

for (const viewport of [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
]) {
  test(`clone folder name at ${viewport.width}px: defaults, validation, Back, collision, retry`, async ({
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
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${pathToFileURL(repo.path).href}.insteadOf`,
        GIT_CONFIG_VALUE_0: remote,
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
      await openAddProjectHostSelection(page);
      await addProjectFlowHost(page, host.serverId).click();
      await chooseAddProjectMethod(page, "github");
      await addProjectFlowInput(page).fill(remote);
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "github-location");
      await addProjectFlowInput(page).fill(parent);
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "github-name");
      await expect(addProjectFlowInput(page)).toHaveValue("api");
      const preview = page.getByTestId("add-project-flow-path-preview");
      await expect(preview).toHaveText(shortenPath(path.join(parent, "api")));
      await page.getByTestId("add-project-flow-clone").click();
      await expect(page.getByTestId("add-project-flow-error")).toHaveText(
        `Checkout path already exists: ${path.join(parent, "api")}`,
      );

      await addProjectFlowInput(page).fill("../escape");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("add-project-flow-error")).toContainText("single folder name");
      await addProjectFlowInput(page).fill("acme-api");
      await addProjectFlowBack(page).click();
      await expectAddProjectPage(page, "github-location");
      const otherParent = path.join(parent, "other");
      await mkdir(otherParent);
      await addProjectFlowInput(page).fill(otherParent);
      await page.keyboard.press("Enter");
      await expectAddProjectPage(page, "github-name");
      await expect(addProjectFlowInput(page)).toHaveValue("acme-api");
      const checkout = path.join(otherParent, "acme-api");
      await expect(preview).toHaveText(shortenPath(checkout));
      await page.screenshot({ path: testInfo.outputPath("clone-folder.png") });
      await testInfo.attach("Clone folder form", {
        path: testInfo.outputPath("clone-folder.png"),
        contentType: "image/png",
      });
      await page.getByTestId("add-project-flow-clone").click();
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
