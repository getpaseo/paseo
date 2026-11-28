import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { connectNewWorkspaceDaemonClient } from "../support/helpers/new-workspace";
import { copyPluginExample } from "../support/helpers/plugin-fixture";
import { seedWorkspace } from "../support/helpers/seed-client";

test("copies a device file after review and includes it in a new worktree", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({
    repoPrefix: "local-files-",
    repo: {
      files: [
        { path: ".gitignore", content: ".env\n" },
        { path: ".worktreeinclude", content: ".env\n" },
      ],
    },
  });
  const example = await copyPluginExample("local-files");
  const installer = await connectNewWorkspaceDaemonClient({ ownProjects: false });
  const { config } = await installer.getDaemonConfig();
  try {
    await installer.patchDaemonConfig({ pluginsEnabled: true });
    await installer.installDirectoryPlugin(example.directory);
    await page.setViewportSize({ width: 1280, height: 900 });
    await gotoAppShell(page);
    await page.getByRole("button", { name: "Local Files", exact: true }).click();
    await page.getByRole("radio", { name: new RegExp(workspace.projectDisplayName) }).click();

    const choose = page.getByRole("button", { name: "Choose file from this device" });
    const picked = {
      name: ".env",
      mimeType: "application/octet-stream",
      buffer: Buffer.from("FIXTURE_ONLY=hello\n"),
    };
    const selectFile = async () => {
      const chooser = page.waitForEvent("filechooser");
      await choose.click();
      await (await chooser).setFiles(picked);
    };
    await selectFile();
    await expect(page.getByRole("heading", { name: "Review copy" })).toBeVisible();
    const imported = path.join(workspace.repoPath, ".env");
    await expect(page.getByText(imported, { exact: false })).toBeVisible();
    await expect(page.getByText("FIXTURE_ONLY", { exact: false })).toHaveCount(0);
    await expect(stat(imported)).rejects.toMatchObject({ code: "ENOENT" });
    await page.screenshot({ path: testInfo.outputPath("review-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByRole("heading", { name: "Review copy" })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("review-compact.png") });

    await page.getByRole("button", { name: /^Copy to / }).click();
    await expect(page.getByRole("alert")).toHaveText(new RegExp(`^Copied to `));
    expect(await readFile(imported)).toEqual(picked.buffer);
    expect((await stat(imported)).mode & 0o777).toBe(0o600);

    await selectFile();
    await expect(page.getByRole("alert")).toHaveText(".env already exists in this checkout.");
    await expect(page.getByRole("button", { name: /^Copy to / })).toHaveCount(0);

    const created = await workspace.client.createWorkspace({
      source: {
        kind: "worktree",
        projectId: workspace.projectId,
        action: "branch-off",
        worktreeSlug: "local-files-check",
      },
    });
    if (!created.workspace) throw new Error(created.error ?? "Worktree was not created");
    expect(await readFile(path.join(created.workspace.workspaceDirectory, ".env"))).toEqual(
      picked.buffer,
    );
    await workspace.client.archiveWorkspace(created.workspace.id);
  } finally {
    await installer.removePlugin("local-files");
    await installer.patchDaemonConfig({ pluginsEnabled: config.pluginsEnabled ?? false });
    await installer.close();
    await example.cleanup();
    await workspace.cleanup();
  }
});
