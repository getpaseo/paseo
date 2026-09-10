import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "../support/fixtures";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  connectWorkspaceSetupClient,
  openWorkspaceScriptsMenu,
} from "../support/helpers/workspace-setup";
import { getServerId } from "../support/helpers/server-id";
import { buildHostWorkspaceRoute } from "../../src/utils/host-routes";

test("nested package scripts run, appear in the sidebar, and expose their result", async ({
  page,
}, testInfo) => {
  const client = await connectWorkspaceSetupClient();
  const manifest = JSON.stringify({
    scripts: {
      build:
        "node -e \"setInterval(() => { if(require('fs').existsSync('finish')) process.exit(0) }, 50)\"",
    },
  });
  const repo = await createTempGitRepo("package-scripts-", {
    files: [
      { path: "package.json", content: JSON.stringify({ scripts: { build: "echo root" } }) },
      { path: "packages/web/package.json", content: manifest },
    ],
  });
  try {
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
    });
    expect(created.error).toBeFalsy();
    const workspaceId = created.workspace!.id;
    await page.goto(buildHostWorkspaceRoute(getServerId(), workspaceId));
    await openWorkspaceScriptsMenu(page);
    const nestedGroup = page.getByTestId("workspace-scripts-group-packages/web/package.json");
    await expect(nestedGroup).toBeVisible();
    const scriptId = "package.json:packages%2Fweb%2Fpackage.json:build";
    const row = page.getByTestId(`workspace-scripts-item-${scriptId}`);
    await expect(row).not.toBeVisible();
    await nestedGroup.click();
    await expect(row).toContainText("build");
    await page.getByTestId(`workspace-scripts-start-${scriptId}`).click();
    await expect(
      page.getByLabel("Script packages/web/build running", { exact: true }).first(),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("running-package-script.png") });
    await page.keyboard.press("Escape");
    await writeFile(join(repo.path, "packages/web/finish"), "done");
    await expect
      .poll(async () => {
        const result = await client.listWorkspaceScripts(workspaceId);
        return result.scripts?.find((script) => script.scriptName === scriptId)?.exitCode;
      })
      .toBe(0);
    await openWorkspaceScriptsMenu(page);
    await nestedGroup.click();
    await expect(row).toContainText("exit 0");
    await expect(page.getByLabel("Script packages/web/build running", { exact: true })).toHaveCount(
      0,
    );
    await page.screenshot({ path: testInfo.outputPath("completed-package-script.png") });

    await page.keyboard.press("Escape");
    await writeFile(join(repo.path, "packages/web/package.json"), "{");
    await openWorkspaceScriptsMenu(page);
    const retry = page.getByRole("menuitem", { name: /Retry/ });
    await expect(retry).toBeVisible();
    await writeFile(join(repo.path, "packages/web/package.json"), manifest);
    await retry.click();
    await expect(retry).not.toBeVisible();
  } finally {
    await client.close();
    await repo.cleanup();
  }
});
