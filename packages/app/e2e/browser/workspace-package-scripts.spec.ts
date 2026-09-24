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
    await expect(
      page.getByTestId("workspace-scripts-item-package.json:package.json:build"),
    ).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Retry/ })).not.toBeVisible();
    await page.keyboard.press("Escape");
    await writeFile(join(repo.path, "packages/web/package.json"), manifest);
    await openWorkspaceScriptsMenu(page);
    await nestedGroup.click();
    await expect(row).toBeVisible();
  } finally {
    await client.close();
    await repo.cleanup();
  }
});

test("long script lists stay bounded, scroll, and filter by name", async ({ page }, testInfo) => {
  const client = await connectWorkspaceSetupClient();
  const scripts = Object.fromEntries(
    Array.from({ length: 80 }, (_, index) => [
      `task-${String(index).padStart(2, "0")}`,
      "echo done",
    ]),
  );
  const repo = await createTempGitRepo("script-search-", {
    files: [{ path: "package.json", content: JSON.stringify({ scripts }) }],
  });
  try {
    const created = await client.createWorkspace({
      source: { kind: "directory", path: repo.path },
    });
    expect(created.error).toBeFalsy();
    await page.goto(buildHostWorkspaceRoute(getServerId(), created.workspace!.id));
    await openWorkspaceScriptsMenu(page);
    const menu = page.getByTestId("workspace-scripts-menu");
    const lastRow = page.getByTestId("workspace-scripts-item-package.json:package.json:task-79");
    await expect(lastRow).toBeAttached();
    const bounds = await menu.boundingBox();
    expect(bounds!.height).toBeLessThanOrEqual(422);
    await lastRow.scrollIntoViewIfNeeded();
    await expect(lastRow).toBeInViewport();
    expect((await menu.boundingBox())!.height).toBeLessThanOrEqual(422);
    const search = page.getByTestId("workspace-scripts-search");
    await search.scrollIntoViewIfNeeded();
    await search.fill("TASK-79");
    await expect(menu.locator('[data-testid^="workspace-scripts-item-"]')).toHaveCount(1);
    await expect(lastRow).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("searched-scripts.png") });
    await search.fill("no-matches");
    await expect(menu).toContainText("No matching scripts");
    await search.fill("");
    await expect(menu.locator('[data-testid^="workspace-scripts-item-"]')).toHaveCount(80);
    await page.screenshot({ path: testInfo.outputPath("scrollable-scripts.png") });
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByTestId("workspace-scripts-button").click();
    const sheet = page.getByTestId("workspace-scripts-menu-content");
    await expect(sheet).toBeVisible();
    await page.getByTestId("workspace-scripts-search").fill("task-79");
    await expect(sheet.locator('[data-testid^="workspace-scripts-item-"]')).toHaveCount(1);
    await expect(lastRow).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("compact-script-search.png") });
  } finally {
    await client.close();
    await repo.cleanup();
  }
});
